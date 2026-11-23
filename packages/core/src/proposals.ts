/** Proposals: changes Alfred has prepared that wait for the user's yes.
 *
 * A run proposes and may then finish; the proposal waits (up to a week) in the user's inbox. The user accepts,
 * declines, or asks for a change (which opens a new run and supersedes this one). The user may also change a step
 * by their own hand before deciding (amendProposal: a proposed event dragged to another hour); what the step then
 * previews is what will run. Accepting runs exactly the steps that were previewed, once, in one transaction. If anything they touch has changed since the proposal was made
 * (read from the event log), it is stale and runs nothing. Only the user decides: the decision is a device command,
 * never a run's.
 */
import type { DatabaseSync } from "node:sqlite";
import { coreContext, withCoreContext, withDefaultActor } from "./context.ts";
import { latestEventSeq, recordDomainEvent, toEvent, type CoreEvent } from "./events.ts";
import { iso, newId } from "./ids.ts";
import { createNotice } from "./notices.ts";
import type { PROPOSAL_STATES } from "./schema.ts";
import type { World } from "./world.ts";

export type ProposalState = (typeof PROPOSAL_STATES)[number];
export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** One operation a device could run (`todo.delete` with its input), pinned to the exact records it names. */
export interface ProposalStep {
  op: string;
  input: unknown;
  /** What it does, in the user's words ("删除待办「交周报」"). */
  preview: string;
  /** The whole of it, when there is more to read than a line (an email's text). */
  detail?: string;
}

export interface Proposal {
  id: string;
  state: ProposalState;
  /** The decision, as a short question ("删掉 3 条逾期很久的待办？"). */
  title: string;
  /** What will change and why. */
  summary: string;
  steps: ProposalStep[];
  /** What the steps touch (`todo:<id>`); a change to any of them since `openedSeq` makes the proposal stale. */
  subjects: string[];
  openedSeq: number;
  runId: string | null;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  decidedAt: string | null;
  /** deliveryQueued records whether approving these steps queued an external change. Older outcomes omit it. */
  outcome: { error?: string; receipts?: string[]; deliveryQueued?: boolean } | null;
  /** Derived, for open proposals: something it touches has changed since. */
  stale?: boolean;
}

export class ProposalStateError extends Error {
  override name = "ProposalStateError";
  readonly state: ProposalState | "missing";
  constructor(state: ProposalState | "missing") {
    super(state === "missing" ? "No such proposal" : `This proposal is ${state}, not open`);
    this.state = state;
  }
}

function load(db: DatabaseSync, id: string): Proposal {
  const row = db.prepare("SELECT * FROM core_proposals WHERE id = ?").get(id);
  if (!row) throw new ProposalStateError("missing");
  return {
    id: row.id as string, state: row.state as ProposalState, title: row.title as string, summary: row.summary as string,
    steps: JSON.parse(row.steps as string), subjects: JSON.parse(row.subjects as string), openedSeq: row.opened_seq as number,
    runId: row.run_id as string | null, conversationId: row.conversation_id as string | null,
    createdAt: row.created_at as string, updatedAt: row.updated_at as string, expiresAt: row.expires_at as string,
    decidedAt: row.decided_at as string | null, outcome: row.outcome ? JSON.parse(row.outcome as string) : null,
  };
}

/** Has anything these subjects name changed since `seq`? */
function changedSince(db: DatabaseSync, subjects: readonly string[], seq: number): boolean {
  if (!subjects.length) return false;
  return !!db.prepare("SELECT 1 FROM core_events WHERE subject IN (SELECT value FROM json_each(?)) AND seq > ? LIMIT 1")
    .get(JSON.stringify(subjects), seq);
}

function setState(db: DatabaseSync, id: string, state: ProposalState, now: number, extra: { decided?: boolean; outcome?: Proposal["outcome"] } = {}): void {
  db.prepare(`UPDATE core_proposals SET state = ?, updated_at = ?, decided_at = COALESCE(?, decided_at), outcome = COALESCE(?, outcome) WHERE id = ?`)
    .run(state, iso(now), extra.decided ? iso(now) : null, extra.outcome ? JSON.stringify(extra.outcome) : null, id);
}

/** Once it is decided, the proposal's notice has said its piece, and so has the result of the run that proposed it
 * (that result was "I proposed this"). */
function closeNotices(db: DatabaseSync, id: string, now: number): void {
  db.prepare(`UPDATE core_notices SET state = 'acknowledged', claimed_by = NULL, claim_until = NULL, updated_at = ?
    WHERE state NOT IN ('acknowledged', 'expired') AND (
      (kind = 'proposal' AND json_extract(payload, '$.proposalId') = ?)
      OR (kind = 'run_result' AND json_extract(payload, '$.runId') = (SELECT run_id FROM core_proposals WHERE id = ?)))`).run(iso(now), id, id);
}

function event(world: World, proposal: Proposal, kind: string, payload: Record<string, unknown>, now: number): CoreEvent {
  return recordDomainEvent(world, { kind, subject: `proposal:${proposal.id}`, payload: { proposalId: proposal.id, title: proposal.title, ...payload }, now });
}

/** Past its week: it runs nothing, and leaves the inbox. */
function expire(world: World, db: DatabaseSync, proposal: Proposal, now: number): void {
  setState(db, proposal.id, "expired", now);
  event(world, proposal, "proposal.expired", {}, now);
  closeNotices(db, proposal.id, now);
}

/** For the home node's clock: open proposals nobody decided in time expire by themselves, so they and their notices
 * do not wait forever. Returns how many did. */
export function expireProposals(world: World, now: number = Date.now()): number {
  return withDefaultActor("system", () => world.tx((db) => {
    const rows = db.prepare("SELECT id FROM core_proposals WHERE state = 'open' AND expires_at <= ? ORDER BY created_at, rowid").all(iso(now));
    for (const row of rows) expire(world, db, load(db, row.id as string), now);
    return rows.length;
  }));
}

/** Opens a proposal; under a run, it belongs to the run's conversation. A notice tells the user.
 *
 * `replaces`: it is a corrected version of what was proposed earlier in the same conversation ("make it 3 to 4"), so
 * the proposals earlier runs there left open are superseded: the user is never left two versions to choose from.
 * `replaced` lists them. */
export function openProposal(world: World, input: {
  title: string; summary: string; steps: ProposalStep[]; subjects?: string[]; conversationId?: string | null; replaces?: boolean; now?: number;
}): Proposal & { replaced?: string[] } {
  const now = input.now ?? Date.now();
  const title = input.title.trim(), summary = input.summary.trim();
  if (!title || title.length > 200) throw new Error("title must be 1–200 characters");
  if (summary.length > 2000) throw new Error("summary is too long");
  if (!input.steps.length || input.steps.length > 20) throw new Error("a proposal has 1–20 steps");
  const id = newId(), runId = coreContext()?.run?.id ?? null;
  return world.tx((db) => {
    const replaced: string[] = [];
    if (input.replaces && input.conversationId) {
      const earlier = db.prepare(`SELECT id FROM core_proposals WHERE state = 'open' AND expires_at > ? AND conversation_id = ?
        AND (run_id IS NULL OR run_id IS NOT ?) ORDER BY created_at, rowid`).all(iso(now), input.conversationId, runId);
      for (const row of earlier) {
        const old = load(db, row.id as string);
        setState(db, old.id, "superseded", now, { decided: true });
        event(world, old, "proposal.decided", { decision: "revise", request: "", replacedBy: id }, now);
        closeNotices(db, old.id, now);
        replaced.push(old.id);
      }
    }
    const opened = recordDomainEvent(world, {
      kind: "proposal.opened", subject: `proposal:${id}`, now,
      payload: { proposalId: id, title, steps: input.steps.map((step) => step.preview.slice(0, 200)) },
    });
    db.prepare(`INSERT INTO core_proposals (id, state, title, summary, steps, subjects, opened_seq, run_id, conversation_id, created_at, updated_at, expires_at)
      VALUES (?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, title, summary, JSON.stringify(input.steps), JSON.stringify([...new Set(input.subjects ?? [])]), opened.seq,
      runId, input.conversationId ?? null, iso(now), iso(now), iso(now + PROPOSAL_TTL_MS),
    );
    createNotice(db, { eventSeq: opened.seq, kind: "proposal", now, payload: { proposalId: id, title, conversationId: input.conversationId ?? null, runId } });
    return { ...load(db, id), ...(replaced.length ? { replaced } : {}) };
  });
}

export function getProposal(world: World, id: string): Proposal {
  return load(world.db, id);
}

/** Open, unexpired proposals, oldest first, each marked stale if what it touches has changed since. */
export function listOpenProposals(world: World, now: number = Date.now()): Proposal[] {
  const rows = world.db.prepare("SELECT id FROM core_proposals WHERE state = 'open' AND expires_at > ? ORDER BY created_at, rowid").all(iso(now));
  return rows.map((row) => {
    const proposal = load(world.db, row.id as string);
    return { ...proposal, stale: changedSince(world.db, proposal.subjects, proposal.openedSeq) };
  });
}

/**
 * The user's yes. Runs every step through `apply` (which throws on failure) in one transaction: all of them, or none.
 * An expired or stale proposal changes state and runs nothing; a step that fails rolls the steps back and marks it
 * failed (or stale, when the failure is a conflict with newer data). Returns the proposal as it ends up.
 */
export function acceptProposal(world: World, id: string, apply: (step: ProposalStep) => void, now: number = Date.now()): Proposal {
  return world.tx((db) => {
    const proposal = load(db, id);
    if (proposal.state !== "open") throw new ProposalStateError(proposal.state);
    if (Date.parse(proposal.expiresAt) <= now) {
      expire(world, db, proposal, now);
      return load(db, id);
    }
    if (changedSince(db, proposal.subjects, proposal.openedSeq)) {
      setState(db, id, "stale", now, { decided: true });
      event(world, proposal, "proposal.stale", {}, now);
      closeNotices(db, id, now);
      return load(db, id);
    }
    const decided = event(world, proposal, "proposal.decided", { decision: "accepted" }, now);
    try {
      withCoreContext({ ...(coreContext() ?? { actor: "user" }), proposalId: id }, () => world.tx(() => { for (const step of proposal.steps) apply(step); }));
    } catch (error) {
      const conflict = error instanceof Error && error.name.endsWith("ConflictError");
      const message = error instanceof Error ? error.message : String(error);
      setState(db, id, conflict ? "stale" : "failed", now, { decided: true, outcome: { error: message.slice(0, 500) } });
      event(world, proposal, conflict ? "proposal.stale" : "proposal.failed", { error: message.slice(0, 200) }, now);
      closeNotices(db, id, now);
      return load(db, id);
    }
    // The receipts: what the steps actually wrote.
    const receipts = db.prepare("SELECT * FROM core_events WHERE seq > ? AND seq <= ? AND kind NOT LIKE 'proposal.%' ORDER BY seq")
      .all(decided.seq, latestEventSeq(world)).map(toEvent);
    setState(db, id, "executed", now, { decided: true, outcome: {
      receipts: receipts.map((receipt) => receipt.id),
      deliveryQueued: receipts.some((receipt) => receipt.kind === "outbound.queued"),
    } });
    event(world, proposal, "proposal.executed", { steps: proposal.steps.length, receipts: receipts.length }, now);
    closeNotices(db, id, now);
    return load(db, id);
  });
}

/** The user's no. */
export function declineProposal(world: World, id: string, now: number = Date.now()): Proposal {
  return world.tx((db) => {
    const proposal = load(db, id);
    if (proposal.state !== "open") throw new ProposalStateError(proposal.state);
    setState(db, id, "declined", now, { decided: true });
    event(world, proposal, "proposal.decided", { decision: "declined" }, now);
    closeNotices(db, id, now);
    return load(db, id);
  });
}

/** The user changes one step by hand while it waits: the same operation, with what they set (a proposed event's time).
 * The caller makes the step whole again (input and preview agree); `summary` says so where Alfred's words no longer
 * hold. Never a run's to do: a run that wants another proposal proposes again. */
export function amendProposal(world: World, id: string, index: number, step: ProposalStep, summary?: string, now: number = Date.now()): Proposal {
  if (coreContext()?.run) throw new Error("Only the user changes a proposal that waits for them");
  return world.tx((db) => {
    const proposal = load(db, id);
    if (proposal.state !== "open") throw new ProposalStateError(proposal.state);
    if (Date.parse(proposal.expiresAt) <= now) { expire(world, db, proposal, now); throw new ProposalStateError("expired"); }
    const was = proposal.steps[index];
    if (!was || was.op !== step.op) throw new Error("No such step in this proposal");
    const steps = proposal.steps.map((each, n) => (n === index ? step : each));
    db.prepare("UPDATE core_proposals SET steps = ?, summary = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(steps), (summary ?? proposal.summary).trim().slice(0, 2000), iso(now), id);
    event(world, proposal, "proposal.amended", { step: index, was: was.preview.slice(0, 200), preview: step.preview.slice(0, 200) }, now);
    return load(db, id);
  });
}

/** The user wants it changed: this one is superseded; the caller opens the run that revises it. */
export function supersedeProposal(world: World, id: string, request: string, now: number = Date.now()): Proposal {
  return world.tx((db) => {
    const proposal = load(db, id);
    if (proposal.state !== "open") throw new ProposalStateError(proposal.state);
    setState(db, id, "superseded", now, { decided: true });
    event(world, proposal, "proposal.decided", { decision: "revise", request: request.slice(0, 500) }, now);
    closeNotices(db, id, now);
    return load(db, id);
  });
}
