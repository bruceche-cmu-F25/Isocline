/** Outbound: changes Isocline makes outside the home node, such as an event in the user's Google Calendar or an email
 * sent from their Gmail. The decision (a proposal accepted, a click) commits together with this record; delivering it
 * is a later step, done by the module that knows the service, and it can fail without undoing the decision.
 *
 *   queued → sending → done | failed | unknown
 *
 * Nothing goes out twice. A delivery that was cut off while `sending` (the home node stopped) becomes `unknown`, and is
 * retried only when its module said the action is idempotent (an event created under its own id, say); an email is
 * never resent, and the user is asked to check. Every ending is a notice, so the user hears how it went; except that
 * a change they made with their own hands (`quiet`) is only told when it did not go through, and the changes one
 * proposal made are told together: what went through is one notice once the last of them has ended (a plan of eleven
 * events is one "done", not eleven), while each that failed or may not have happened is told on its own.
 */
import type { DatabaseSync } from "node:sqlite";
import { coreContext } from "./context.ts";
import { recordDomainEvent } from "./events.ts";
import { iso, newId } from "./ids.ts";
import { createNotice } from "./notices.ts";
import type { World } from "./world.ts";

export const OUTBOUND_STATES = ["queued", "sending", "done", "failed", "unknown"] as const;
export type OutboundState = (typeof OUTBOUND_STATES)[number];
/** An idempotent delivery that keeps failing for reasons other than a refusal is given up after this many tries. */
export const OUTBOUND_MAX_ATTEMPTS = 5;

export interface Outbound {
  id: string;
  /** The module that delivers it, and what it does there (`calendar`, `add`). */
  module: string;
  action: string;
  payload: unknown;
  /** What it does, in the user's words. */
  preview: string;
  /** The whole of it, when there is more to read (an email's text). */
  detail: string | null;
  /** Safe to deliver again after a cut-off delivery. */
  idempotent: boolean;
  /** The proposal whose yes this is, if it came from one. */
  proposalId: string | null;
  /** The user made it themselves, in place: they are told only if it fails or may not have happened. */
  quiet: boolean;
  state: OutboundState;
  attempts: number;
  error: string | null;
  result: unknown;
  createdAt: string;
  updatedAt: string;
}

function toOutbound(row: Record<string, unknown>): Outbound {
  return {
    id: row.id as string, module: row.module as string, action: row.action as string, payload: JSON.parse(row.payload as string),
    preview: row.preview as string, detail: row.detail as string | null, idempotent: row.idempotent === 1, proposalId: row.proposal_id as string | null, quiet: row.quiet === 1, state: row.state as OutboundState,
    attempts: row.attempts as number, error: row.error as string | null, result: row.result ? JSON.parse(row.result as string) : null,
    createdAt: row.created_at as string, updatedAt: row.updated_at as string,
  };
}

function load(db: DatabaseSync, id: string): Outbound {
  const row = db.prepare("SELECT * FROM core_outbound WHERE id = ?").get(id);
  if (!row) throw new Error("No such outbound change");
  return toOutbound(row);
}

export function getOutbound(world: World, id: string): Outbound {
  return load(world.db, id);
}

export function listOutbound(world: World, options: { module?: string; states?: OutboundState[] } = {}): Outbound[] {
  const states = options.states ?? [...OUTBOUND_STATES];
  return world.db.prepare(`SELECT * FROM core_outbound WHERE (? IS NULL OR module = ?) AND state IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid`)
    .all(options.module ?? null, options.module ?? null, JSON.stringify(states)).map(toOutbound);
}

/** Records a change to deliver. Inside the caller's transaction (an op, a proposal's step), so it commits with the
 * decision or not at all. */
export function enqueueOutbound(world: World, input: {
  module: string; action: string; payload: unknown; preview: string; detail?: string; idempotent: boolean; quiet?: boolean; now?: number;
  /** Wait until this earlier outbound reaches a terminal state, including after retries or a restart. */
  afterId?: string;
}): Outbound {
  const now = input.now ?? Date.now();
  const preview = input.preview.trim().slice(0, 300);
  if (!preview) throw new Error("An outbound change needs a preview");
  return world.tx((db) => {
    const id = newId();
    const proposalId = coreContext()?.proposalId ?? null;
    db.prepare(`INSERT INTO core_outbound (id, module, action, payload, preview, detail, idempotent, proposal_id, quiet, state, attempts, created_at, updated_at, after_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`)
      .run(id, input.module, input.action, JSON.stringify(input.payload ?? null), preview, input.detail?.slice(0, 20_000) ?? null, input.idempotent ? 1 : 0, proposalId, input.quiet ? 1 : 0, iso(now), iso(now), input.afterId ?? null);
    recordDomainEvent(world, { kind: "outbound.queued", subject: `outbound:${id}`, payload: { outboundId: id, module: input.module, action: input.action, preview }, now });
    return load(db, id);
  });
}

/** The oldest change waiting for this module, now marked as being sent; `skip` leaves out ones already tried in this
 * pass. Null when there is none. */
export function claimOutbound(world: World, module: string, skip: ReadonlySet<string> = new Set(), now: number = Date.now()): Outbound | null {
  return world.tx((db) => {
    const row = db.prepare(`SELECT id FROM core_outbound AS next WHERE module = ? AND state = 'queued' AND id NOT IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM core_outbound AS prior WHERE prior.id = next.after_id AND prior.state IN ('queued', 'sending'))
      ORDER BY created_at, rowid LIMIT 1`).get(module, JSON.stringify([...skip]));
    if (!row) return null;
    db.prepare("UPDATE core_outbound SET state = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(iso(now), row.id as string);
    return load(db, row.id as string);
  });
}

function end(world: World, db: DatabaseSync, outbound: Outbound, state: "done" | "failed" | "unknown", extra: { error?: string; result?: unknown }, now: number): Outbound {
  db.prepare("UPDATE core_outbound SET state = ?, error = ?, result = ?, updated_at = ? WHERE id = ?")
    .run(state, extra.error?.slice(0, 500) ?? null, extra.result === undefined ? null : JSON.stringify(extra.result), iso(now), outbound.id);
  const event = recordDomainEvent(world, {
    kind: `outbound.${state}`, subject: `outbound:${outbound.id}`, now,
    payload: { outboundId: outbound.id, module: outbound.module, action: outbound.action, preview: outbound.preview, ...(extra.error ? { error: extra.error.slice(0, 300) } : {}) },
  });
  if (outbound.quiet && state === "done") return load(db, outbound.id);
  if (outbound.proposalId) {
    if (state !== "done") tell(db, event.seq, outbound, state, extra.error, now);
    tellProposalDone(db, event.seq, outbound.proposalId, now);
  } else tell(db, event.seq, outbound, state, extra.error, now);
  return load(db, outbound.id);
}

/** The account a person needs when checking a Gmail send or Calendar change. Other payloads stay private. */
function accountOf(outbound: Outbound): string | null {
  const googleAction = (outbound.module === "mail" && outbound.action === "send") || outbound.module === "calendar";
  const input = outbound.payload;
  return googleAction && input && typeof input === "object" && "account" in input && typeof input.account === "string" ? input.account : null;
}

function tell(db: DatabaseSync, eventSeq: number, outbound: Outbound, state: OutboundState, error: string | undefined, now: number): void {
  const account = accountOf(outbound);
  createNotice(db, {
    eventSeq, kind: "outbound", now,
    payload: {
      outboundId: outbound.id, module: outbound.module, action: outbound.action, state, preview: outbound.preview,
      ...(account ? { account } : {}), ...(outbound.proposalId ? { proposalId: outbound.proposalId } : {}), ...(error ? { error: error.slice(0, 300) } : {}),
    },
  });
}

/** Once nothing one proposal queued is still waiting or being sent, what went through is told in one notice. One
 * change is told as itself; several carry each one's preview (`previews`) and how many (`count`). */
function tellProposalDone(db: DatabaseSync, eventSeq: number, proposalId: string, now: number): void {
  const all = db.prepare("SELECT * FROM core_outbound WHERE proposal_id = ? ORDER BY created_at, rowid").all(proposalId).map(toOutbound);
  if (all.some((each) => each.state === "queued" || each.state === "sending")) return;
  const done = all.filter((each) => each.state === "done" && !each.quiet);
  if (!done.length) return;
  if (done.length === 1) { tell(db, eventSeq, done[0], "done", undefined, now); return; }
  const modules = [...new Set(done.map((each) => each.module))], actions = [...new Set(done.map((each) => each.action))];
  const accounts = [...new Set(done.map(accountOf))];
  const title = db.prepare("SELECT title FROM core_proposals WHERE id = ?").get(proposalId)?.title as string | undefined;
  createNotice(db, {
    eventSeq, kind: "outbound", now,
    payload: {
      outboundIds: done.map((each) => each.id), module: modules.length === 1 ? modules[0] : "mixed", action: actions.length === 1 ? actions[0] : "mixed",
      state: "done", count: done.length, preview: done[0].preview, previews: done.slice(0, 30).map((each) => each.preview),
      proposalId, ...(title ? { title } : {}), ...(accounts.length === 1 && accounts[0] ? { account: accounts[0] } : {}),
    },
  });
}

/** How a delivery ended: done (with what the service answered), failed (refused, or given up), or unknown (it may or
 * may not have happened; the user is asked to check). */
export function finishOutbound(world: World, id: string, outcome: { state: "done"; result?: unknown } | { state: "failed" | "unknown"; error: string }, now: number = Date.now()): Outbound {
  return world.tx((db) => {
    const outbound = load(db, id);
    if (outbound.state !== "sending") throw new Error(`This change is ${outbound.state}, not being sent`);
    return end(world, db, outbound, outcome.state, outcome.state === "done" ? { result: outcome.result } : { error: outcome.error }, now);
  });
}

/** An idempotent delivery that could not reach the service: back in the queue for the next pass, until it has been
 * tried OUTBOUND_MAX_ATTEMPTS times. A change that is not idempotent cannot be retried: it is unknown. */
export function retryOutbound(world: World, id: string, error: string, now: number = Date.now()): Outbound {
  return world.tx((db) => {
    const outbound = load(db, id);
    if (outbound.state !== "sending") throw new Error(`This change is ${outbound.state}, not being sent`);
    if (!outbound.idempotent) return end(world, db, outbound, "unknown", { error }, now);
    if (outbound.attempts >= OUTBOUND_MAX_ATTEMPTS) return end(world, db, outbound, "failed", { error }, now);
    db.prepare("UPDATE core_outbound SET state = 'queued', error = ?, updated_at = ? WHERE id = ?").run(error.slice(0, 500), iso(now), id);
    return load(db, id);
  });
}

/** For a home node that has just started: deliveries the last one was in the middle of. Idempotent ones go back in the
 * queue; the rest are unknown, and the user is told. Returns how many there were. */
export function interruptOutbound(world: World, now: number = Date.now()): number {
  return world.tx((db) => {
    const rows = db.prepare("SELECT * FROM core_outbound WHERE state = 'sending'").all().map(toOutbound);
    for (const outbound of rows) {
      if (outbound.idempotent) db.prepare("UPDATE core_outbound SET state = 'queued', updated_at = ? WHERE id = ?").run(iso(now), outbound.id);
      else end(world, db, outbound, "unknown", { error: "Isocline stopped while sending this" }, now);
    }
    return rows.length;
  });
}
