/** A run: one recoverable unit of work handed to an engine. Its id, ownership
 * and lifecycle stay here; the engine only sees the goal. What a run DID is
 * read from the events recorded under it, never from the model's words.
 *
 * A run may stop to ask the user (a choice, or permission for one action):
 * it waits in `waiting_input` / `waiting_permission`, still leased to its
 * executor, until the user answers or cancels.
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import { withCoreContext } from "./context.ts";
import { CONVERSATION_ID, ConversationError, createConversation, requireOpenSession, recordUnreadReply, titleFrom, touchConversation, updateConversation } from "./conversations.ts";
import { appendEvent, readRunEvents, type CoreEvent } from "./events.ts";
import { attachFiles } from "./files.ts";
import { iso, newId } from "./ids.ts";
import { createNotice } from "./notices.ts";
import { resultDestination, retirePreviousEditions } from "./result-delivery.ts";
import { TEMPLATE_TEXT, type AutomationTemplate } from "./automation-templates.ts";
import { localeOf } from "./settings.ts";
import { RUN_STATES } from "./schema.ts";
import { grantCommand } from "./shell.ts";
import type { World } from "./world.ts";

export type RunState = (typeof RUN_STATES)[number];
export const RUN_LEASE_MS = 60_000;

export interface RunOutcome {
  status: "completed" | "failed" | "cancelled";
  /** The engine's own account. An interpretation, not proof of what happened. */
  reply?: string;
  /** The overview carries a preview; the run and conversation detail carry the complete reply. */
  replyTruncated?: true;
  /** A short code, never a raw provider error. */
  error?: string;
  /** Ids of the domain events recorded under this run: what it actually did. */
  receipts: string[];
}
/** What a waiting run asks the user. */
export interface RunRequest {
  id: string;
  /** `permission`: may it do this one action (answers `allow` / `deny`). `input`: a choice or a short answer. */
  kind: "input" | "permission";
  question: string;
  /** Suggested answers. A permission request can also offer a command grant or session-wide approval. */
  options: string[];
  /** For `permission`: exactly what would happen (a diff, a command), shown with the question. */
  detail?: string;
  /** What `detail` is, when it is not a diff: a shell command. */
  detailKind?: "command";
  /** For a command: what `always` would allow for the rest of the session. */
  grant?: string;
  createdAt: string;
}
export interface Run {
  id: string;
  requestId: string;
  conversationId: string;
  goal: string;
  profile: string;
  state: RunState;
  createdAt: string;
  updatedAt: string;
  attempt: number;
  leaseOwner: string | null;
  leaseUntil: string | null;
  cancelRequested: boolean;
  outcome: RunOutcome | null;
  request: RunRequest | null;
  /** What the user was looking at when they asked (a page of the workspace). Context for the engine, not an instruction. */
  context: ViewContext | null;
  /** The automation that started this run on its schedule; null when the user asked. */
  automationId: string | null;
}

/** The page a request came from: its view (`todo.list`, `core.inbox`), its title and one line of what it shows now,
 * and what was selected on it, if anything. */
export interface ViewContext {
  view: string;
  title?: string;
  summary?: string;
  selection?: { id: string; title?: string };
  /** Said out loud, not typed (quick talk, docs/design/voice.md §1.2): the words are a transcript, and the reply
   * will be read aloud. `view` is then the page the user was on, or `core.voice` when there was none (the Mac's
   * figure, the hotkey). */
  spoken?: true;
}
/** The view of a run asked by voice from no page. */
export const VOICE_VIEW = "core.voice";

const VIEW = /^[a-z][a-z0-9]*\.[a-z][a-z_]*$/;
/** Checks and bounds a context from a device; anything malformed is refused, not trimmed into something else. */
export function viewContext(input: unknown): ViewContext | null {
  if (input === undefined || input === null) return null;
  const value = input as Record<string, unknown>;
  const text = (field: unknown, max: number) => (field === undefined ? undefined : typeof field === "string" && field.length <= max ? field : (() => { throw new Error("Invalid view context"); })());
  if (typeof value !== "object" || typeof value.view !== "string" || !VIEW.test(value.view) || value.view.length > 64) throw new Error("Invalid view context");
  const selection = value.selection as Record<string, unknown> | undefined;
  if (selection !== undefined && (typeof selection !== "object" || typeof selection.id !== "string" || !selection.id || selection.id.length > 64)) throw new Error("Invalid view context");
  if (value.spoken !== undefined && value.spoken !== true) throw new Error("Invalid view context");
  return {
    view: value.view,
    ...(value.title !== undefined ? { title: text(value.title, 80) } : {}),
    ...(value.summary !== undefined ? { summary: text(value.summary, 300) } : {}),
    ...(selection ? { selection: { id: selection.id as string, ...(selection.title !== undefined ? { title: text(selection.title, 200) } : {}) } } : {}),
    ...(value.spoken ? { spoken: true as const } : {}),
  };
}

export class RunError extends Error {
  override name = "RunError";
  readonly code: "missing" | "conflict" | "state" | "lease";
  constructor(code: "missing" | "conflict" | "state" | "lease", message?: string) {
    super(message ?? {
      missing: "No such run",
      conflict: "This request id was already used for a different request",
      state: "The run is not in a state that allows this",
      lease: "Run lease expired or was replaced",
    }[code]);
    this.code = code;
  }
}

const TERMINAL: readonly RunState[] = ["completed", "failed", "cancelled"];
const WAITING: readonly RunState[] = ["waiting_input", "waiting_permission"];
/** Held by an executor: working, waiting on the user, or stopping. */
const LEASED: readonly RunState[] = ["running", "cancelling", ...WAITING];
const LEASED_SQL = LEASED.map((state) => `'${state}'`).join(", ");
/** Working, with something in flight: only these lose their run when the lease runs out. A run waiting on the user
 * has nothing in flight, so time alone (the machine slept, nobody was there for a day) does not take it from its
 * executor; it ends when the user answers or cancels, or when the home node restarts (interruptOrphanedRuns). */
const LAPSING_SQL = LEASED.filter((state) => !WAITING.includes(state)).map((state) => `'${state}'`).join(", ");
export const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const OWNER = /^[A-Za-z0-9._:-]{1,80}$/;
const PROFILE = /^[a-z][a-z0-9_-]{0,63}$/;

function toRun(row: Record<string, unknown>): Run {
  return {
    id: row.id as string, requestId: row.request_id as string, conversationId: row.conversation_id as string,
    goal: row.goal as string, profile: row.profile as string, state: row.state as RunState,
    createdAt: row.created_at as string, updatedAt: row.updated_at as string, attempt: row.attempt as number,
    leaseOwner: row.lease_owner as string | null, leaseUntil: row.lease_until as string | null,
    cancelRequested: row.cancel_requested === 1, outcome: row.outcome ? JSON.parse(row.outcome as string) : null,
    request: row.request ? JSON.parse(row.request as string) : null,
    context: row.context ? JSON.parse(row.context as string) : null,
    automationId: (row.automation_id as string | null) ?? null,
  };
}

function load(db: DatabaseSync, id: string): Run {
  const row = db.prepare("SELECT * FROM core_runs WHERE id = ?").get(id);
  if (!row) throw new RunError("missing");
  return toRun(row);
}

function setState(db: DatabaseSync, run: Run, state: RunState, now: number, extra: Record<string, string | number | null> = {}): void {
  const columns = Object.keys(extra);
  db.prepare(`UPDATE core_runs SET state = ?, updated_at = ?${columns.map((column) => `, ${column} = ?`).join("")} WHERE id = ?`)
    .run(state, iso(now), ...Object.values(extra), run.id);
}

function runEvent(db: DatabaseSync, run: Run, kind: string, now: number, payload: Record<string, unknown> = {}): CoreEvent {
  // Lifecycle events belong to the run but are not receipts of its work.
  return appendEvent(db, { kind: `run.${kind}`, subject: `run:${run.id}`, runId: run.id, payload: { goal: run.goal.slice(0, 200), ...payload }, now });
}

function receiptsOf(db: DatabaseSync, runId: string): string[] {
  return readRunEvents(db, runId).filter((event) => !event.kind.startsWith("run.")).map((event) => event.id);
}

/** The question or interrupted attempt is no longer waiting for a decision. */
function closeWaitingNotices(db: DatabaseSync, runId: string, now: number): void {
  db.prepare(`UPDATE core_notices SET state = 'acknowledged', claimed_by = NULL, claim_until = NULL, updated_at = ?
    WHERE kind IN ('run_request', 'run_interrupted') AND state IN ('pending', 'claimed', 'presented') AND json_extract(payload, '$.runId') = ?`).run(iso(now), runId);
}

/** What a notice calls a run (`goal`): the user's words, or for an automation's run, the automation's name, which is
 * what the user would call it (the instruction it gives Isocline is in the run). */
function said(db: DatabaseSync, run: Run): { goal: string; automationId?: string } {
  if (!run.automationId) return { goal: run.goal.slice(0, 200) };
  const row = db.prepare("SELECT name, template FROM core_automations WHERE id = ?").get(run.automationId);
  const name = (row?.name as string | null) ?? (row?.template ? TEMPLATE_TEXT[row.template as AutomationTemplate][localeOf(db)].name : null);
  return { goal: (name ?? run.goal).slice(0, 200), automationId: run.automationId };
}

function interrupt(db: DatabaseSync, run: Run, now: number): void {
  setState(db, run, "interrupted", now, { lease_owner: null, lease_until: null, request: null });
  closeWaitingNotices(db, run.id, now);
  const event = runEvent(db, run, "interrupted", now, { attempt: run.attempt });
  createNotice(db, { eventSeq: event.seq, kind: "run_interrupted", payload: { runId: run.id, conversationId: run.conversationId, ...said(db, run) }, now });
}

export interface SubmitRunInput {
  requestId: string;
  goal: string;
  profile: string;
  /** Continue this conversation; omitted, the run starts a new one. */
  conversationId?: string;
  /** The page the user asked from. */
  context?: unknown;
  /** Started by this automation, not by the user (automations.ts). */
  automationId?: string;
  /** Files sent with the message (files.ts), by id: uploaded before, and no other message's. */
  attachments?: readonly string[];
  now?: number;
}

/** Returns at once; a run never blocks the conversation. The same request id
 * returns the original run; reusing it for different content is refused.
 */
export function submitRun(world: World, input: SubmitRunInput): { run: Run; replayed: boolean } {
  if (!REQUEST_ID.test(input.requestId)) throw new Error("Invalid request id");
  if (!PROFILE.test(input.profile)) throw new Error("Invalid run profile");
  if (input.conversationId !== undefined && !CONVERSATION_ID.test(input.conversationId)) throw new ConversationError("invalid");
  const goal = input.goal.trim();
  if (!goal || goal.length > 8000) throw new Error("Goal must be 1–8000 characters");
  const context = viewContext(input.context);
  const attachments = [...new Set(input.attachments ?? [])];
  const hash = createHash("sha256").update(JSON.stringify({
    goal, profile: input.profile, conversationId: input.conversationId ?? null, ...(context ? { context } : {}),
    ...(input.automationId ? { automationId: input.automationId } : {}), ...(attachments.length ? { attachments } : {}),
  })).digest("hex");
  const now = input.now ?? Date.now();
  return world.tx((db) => {
    const existing = db.prepare("SELECT * FROM core_runs WHERE request_id = ?").get(input.requestId);
    if (existing) {
      if (existing.request_hash !== hash) throw new RunError("conflict");
      return { run: toRun(existing), replayed: true };
    }
    let conversationId = input.conversationId;
    if (conversationId) { requireOpenSession(db, conversationId); touchConversation(db, conversationId, now); }
    else conversationId = createConversation(db, { title: titleFrom(goal), now });
    const id = newId();
    db.prepare(`INSERT INTO core_runs (id, request_id, request_hash, conversation_id, goal, profile, state, created_at, updated_at, context, automation_id)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`).run(id, input.requestId, hash, conversationId, goal, input.profile, iso(now), iso(now), context ? JSON.stringify(context) : null, input.automationId ?? null);
    const run = load(db, id);
    const files = attachments.length ? attachFiles(db, attachments, run) : [];
    runEvent(db, run, "queued", now, { conversationId, ...(files.length ? { files: files.map((file) => ({ name: file.name, kind: file.kind })) } : {}) });
    return { run, replayed: false };
  });
}

/** A working run whose executor stopped heartbeating (crash, sleep) becomes
 * interrupted. It is never re-run automatically: that could repeat its actions.
 * A run waiting on the user is left waiting (see LAPSING_SQL).
 */
export function sweepRuns(world: World, options: { now?: number } = {}): void {
  const now = options.now ?? Date.now();
  world.tx((db) => {
    for (const row of db.prepare(`SELECT * FROM core_runs WHERE state IN (${LAPSING_SQL}) AND lease_until <= ?`).all(iso(now))) {
      interrupt(db, toRun(row), now);
    }
  });
}

/** For a home node that has just started and holds the single-instance lock:
 * no other executor can be alive, so every leased run belongs to a dead one.
 */
export function interruptOrphanedRuns(world: World, owner: string, options: { now?: number } = {}): number {
  const now = options.now ?? Date.now();
  return world.tx((db) => {
    const rows = db.prepare(`SELECT * FROM core_runs WHERE state IN (${LEASED_SQL}) AND (lease_owner IS NULL OR lease_owner != ?)`).all(owner);
    for (const row of rows) interrupt(db, toRun(row), now);
    return rows.length;
  });
}

/** The oldest queued run whose conversation has nothing else in progress,
 * leased to owner. Null when there is nothing to start.
 */
export function claimNextRun(world: World, owner: string, options: { leaseMs?: number; now?: number } = {}): Run | null {
  if (!OWNER.test(owner)) throw new Error("Invalid run owner");
  const now = options.now ?? Date.now();
  sweepRuns(world, { now });
  return world.tx((db) => {
    const row = db.prepare(`SELECT * FROM core_runs q WHERE q.state = 'queued' AND NOT EXISTS (
      SELECT 1 FROM core_runs a WHERE a.conversation_id = q.conversation_id AND a.state IN (${LEASED_SQL}))
      ORDER BY q.created_at, q.rowid LIMIT 1`).get();
    if (!row) return null;
    const run = toRun(row);
    setState(db, run, "running", now, { attempt: run.attempt + 1, lease_owner: owner, lease_until: iso(now + (options.leaseMs ?? RUN_LEASE_MS)) });
    runEvent(db, run, "started", now, { attempt: run.attempt + 1 });
    return load(db, run.id);
  });
}

function owned(db: DatabaseSync, id: string, owner: string, now: number): Run {
  const run = load(db, id);
  // A waiting run stays its executor's past the lease's time (see LAPSING_SQL); its next heartbeat renews it.
  const lapsed = Date.parse(run.leaseUntil!) <= now && !WAITING.includes(run.state);
  if (run.leaseOwner !== owner || !LEASED.includes(run.state) || lapsed) throw new RunError("lease");
  return run;
}

/** Extends the lease. Tells the executor whether cancellation was requested. */
export function heartbeatRun(world: World, id: string, owner: string, options: { leaseMs?: number; now?: number } = {}): { cancelRequested: boolean } {
  const now = options.now ?? Date.now();
  return world.tx((db) => {
    const run = owned(db, id, owner, now);
    db.prepare("UPDATE core_runs SET lease_until = ? WHERE id = ?").run(iso(now + (options.leaseMs ?? RUN_LEASE_MS)), id);
    return { cancelRequested: run.cancelRequested };
  });
}

/** Records the engine's actual result. Only the current lease holder may;
 * a replaced or lapsed executor cannot overwrite a newer attempt.
 */
export function finishRun(world: World, id: string, owner: string, result: Omit<RunOutcome, "receipts">, options: { now?: number } = {}): Run {
  if (!TERMINAL.includes(result.status)) throw new Error("Unknown run outcome");
  const now = options.now ?? Date.now();
  return world.tx((db) => {
    const run = owned(db, id, owner, now);
    const receipts = receiptsOf(db, id);
    const outcome: RunOutcome = {
      status: result.status,
      ...(result.reply ? { reply: result.reply.slice(0, 4000), ...(result.reply.length > 4000 ? { replyTruncated: true as const } : {}) } : {}),
      ...(result.error ? { error: result.error.slice(0, 80) } : {}),
      receipts,
    };
    if (outcome.replyTruncated) db.prepare("INSERT INTO core_run_replies (run_id, reply) VALUES (?, ?)").run(id, result.reply!);
    setState(db, run, result.status, now, { lease_owner: null, lease_until: null, outcome: JSON.stringify(outcome), request: null });
    closeWaitingNotices(db, id, now);
    touchConversation(db, run.conversationId, now);
    const event = runEvent(db, run, result.status, now, { receipts: receipts.length });
    const destination = resultDestination(db, run, result.status);
    if (destination) {
      createNotice(db, {
        eventSeq: event.seq, kind: "run_result", now,
        payload: {
          runId: id, conversationId: run.conversationId, status: result.status, ...said(db, run), ...destination, receipts: receipts.length,
          ...(outcome.reply ? { reply: outcome.reply.slice(0, 280) } : {}),
        },
      });
      if (destination.keep === "latest" && result.status === "completed" && run.automationId) retirePreviousEditions(db, run.automationId, id);
    } else if (!run.automationId && result.status === "completed" && outcome.reply) {
      recordUnreadReply(db, run.conversationId, id);
    }
    return detailRun(db, id);
  });
}

/** Cancelling is not cancelled: a running or waiting run stops when its
 * engine actually stops. Already-finished runs are returned unchanged.
 */
export function requestCancel(world: World, id: string, options: { now?: number } = {}): Run {
  const now = options.now ?? Date.now();
  return world.tx((db) => {
    const run = load(db, id);
    if (TERMINAL.includes(run.state) || run.state === "cancelling") return run;
    if (run.state === "queued" || run.state === "interrupted") {
      setState(db, run, "cancelled", now, { outcome: JSON.stringify({ status: "cancelled", receipts: receiptsOf(db, id) }) });
      closeWaitingNotices(db, id, now);
      runEvent(db, run, "cancelled", now);
    } else {
      // A waiting executor still owns the run after sleep. Give it time to record the engine's stop.
      const lapsed = WAITING.includes(run.state) && Date.parse(run.leaseUntil!) <= now;
      setState(db, run, "cancelling", now, { cancel_requested: 1, request: null, ...(lapsed ? { lease_until: iso(now + RUN_LEASE_MS) } : {}) });
      closeWaitingNotices(db, id, now);
      runEvent(db, run, "cancel_requested", now);
    }
    return load(db, id);
  });
}

/** The user's decision to continue an interrupted run. A new attempt, not a replay. */
export function resumeRun(world: World, id: string, options: { now?: number } = {}): Run {
  const now = options.now ?? Date.now();
  return world.tx((db) => {
    const run = load(db, id);
    if (run.state !== "interrupted") throw new RunError("state");
    requireOpenSession(db, run.conversationId, true);
    setState(db, run, "queued", now, { cancel_requested: 0 });
    touchConversation(db, run.conversationId, now);
    closeWaitingNotices(db, id, now);
    runEvent(db, run, "resumed", now);
    return load(db, id);
  });
}

// ---- asking the user -----------------------------------------------------

/** Answers reach the waiting executor through this, after they commit. */
export const runAnswers = new EventEmitter<{ answer: [runId: string, requestId: string, answer: string, by: string | undefined] }>();
// One listener per waiting run and per drain; there is no leak to warn about.
runAnswers.setMaxListeners(0);

const MAX_QUESTION = 1000;
const MAX_OPTION = 120;
const MAX_ANSWER = 8000;
/** `always` grants a plain command prefix. `allow_session` switches the development session's mode. */
export const PERMISSION_ANSWERS = ["allow", "deny", "always", "allow_session"] as const;
const MAX_DETAIL = 12_000;

/** The executor stops the run to ask. Only the lease holder of a running run may. */
export function openRequest(world: World, id: string, owner: string, input: { kind: RunRequest["kind"]; question: string; options?: string[]; detail?: string; detailKind?: "command"; grant?: string; always?: boolean; allowSession?: boolean; now?: number }): RunRequest {
  const now = input.now ?? Date.now();
  const question = input.question.trim().slice(0, MAX_QUESTION);
  if (!question) throw new Error("A request needs a question");
  const options = input.kind === "permission"
    ? ["allow", "deny", ...(input.always ? ["always"] : []), ...(input.allowSession ? ["allow_session"] : [])]
    : [...new Set((input.options ?? []).map((option) => String(option).trim().slice(0, MAX_OPTION)).filter(Boolean))].slice(0, 6);
  return world.tx((db) => {
    const run = owned(db, id, owner, now);
    if (run.state !== "running") throw new RunError("state");
    const detail = input.kind === "permission" && input.detail ? input.detail.slice(0, MAX_DETAIL) : undefined;
    const request: RunRequest = {
      id: newId(), kind: input.kind, question, options, ...(detail ? { detail } : {}),
      ...(detail && input.detailKind ? { detailKind: input.detailKind } : {}), ...(input.always && input.grant ? { grant: input.grant.slice(0, 300) } : {}),
      createdAt: iso(now),
    };
    setState(db, run, input.kind === "permission" ? "waiting_permission" : "waiting_input", now, { request: JSON.stringify(request) });
    // The detail (a diff, a command) stays on the run, not in the event log.
    const event = runEvent(db, run, "waiting", now, { request: { ...request, detail: undefined, grant: undefined } });
    createNotice(db, {
      eventSeq: event.seq, kind: "run_request", now,
      payload: { runId: id, conversationId: run.conversationId, goal: run.goal.slice(0, 200), requestId: request.id, kind: request.kind, question, options },
    });
    return request;
  });
}

/** The user answered. Accepted only for the question currently asked. `by`: who answered, for an answer that
 * outlives the question (`always`): `home`, or a paired device's id. */
export function answerRequest(world: World, id: string, input: { requestId: string; answer: string; by?: string; now?: number }): Run {
  const now = input.now ?? Date.now();
  const answer = String(input.answer ?? "").trim().slice(0, MAX_ANSWER);
  const run = world.tx((db) => {
    const run = load(db, id);
    if (!WAITING.includes(run.state) || !run.request) throw new RunError("state", "This run is not waiting for an answer");
    if (run.request.id !== input.requestId) throw new RunError("conflict", "That question was already answered or replaced");
    if (run.request.kind === "permission" && !run.request.options.includes(answer)) throw new RunError("state", "Answer allow or deny");
    if (!answer) throw new RunError("state", "An answer is needed");
    if (run.request.kind === "permission" && (answer === "allow_session" || answer === "always")) {
      const { detailKind, grant } = run.request;
      withCoreContext({ actor: "user" }, () => {
        if (answer === "always" && detailKind === "command") {
          if (!grant) throw new RunError("state", "This command has no prefix grant");
          grantCommand(world, run.conversationId, grant, input.by ?? "home", now);
        } else {
          // Older in-project edit prompts used "always" for the mode switch.
          updateConversation(world, run.conversationId, { mode: "edits", now });
        }
      });
    }
    // The run works again from here. If it waited past its lease (the machine slept), the answer starts the lease
    // anew, so what the answer allows is not refused before the executor's next heartbeat.
    const lapsed = Date.parse(run.leaseUntil!) <= now;
    setState(db, run, "running", now, { request: null, ...(lapsed ? { lease_until: iso(now + RUN_LEASE_MS) } : {}) });
    closeWaitingNotices(db, id, now);
    appendEvent(db, {
      kind: "run.answered", subject: `run:${id}`, runId: id, actor: "user", now,
      payload: { requestId: run.request.id, kind: run.request.kind, question: run.request.question.slice(0, 200), answer: answer.slice(0, 200) },
    });
    return load(db, id);
  });
  runAnswers.emit("answer", id, input.requestId, answer, input.by);
  return run;
}

const DETAIL_ROWS = `SELECT r.*, r.rowid AS history_order, body.reply AS full_reply
  FROM core_runs r LEFT JOIN core_run_replies body ON body.run_id = r.id`;

function withReply(row: Record<string, unknown>): Run {
  const run = toRun(row);
  if (typeof row.full_reply === "string" && run.outcome) {
    run.outcome.reply = row.full_reply;
    delete run.outcome.replyTruncated;
  }
  return run;
}

function detailRun(db: DatabaseSync, id: string): Run {
  const run = load(db, id);
  if (run.outcome?.replyTruncated) {
    const row = db.prepare("SELECT reply FROM core_run_replies WHERE run_id = ?").get(id);
    if (row) { run.outcome.reply = String(row.reply); delete run.outcome.replyTruncated; }
  }
  return run;
}

export function getRun(world: World, id: string): { run: Run; events: CoreEvent[] } {
  return { run: detailRun(world.db, id), events: readRunEvents(world.db, id) };
}

/** Chronological transcript pages, with the insertion order breaking timestamp ties. The turn held by
 * the executor accompanies the first page, so it stays visible even after many messages queue behind it. */
export function conversationRuns(world: World, id: string, options: { before?: string; changed?: string[]; limit?: number } = {}) {
  const scope = `${DETAIL_ROWS} WHERE r.conversation_id = ?`;
  const order = " ORDER BY r.created_at DESC, r.rowid DESC";
  const turn = (row: Record<string, unknown>) => ({ ...withReply(row), historyOrder: Number(row.history_order) });
  if (options.changed) {
    const rows = world.db.prepare(`${scope} AND r.id IN (SELECT value FROM json_each(?))${order}`)
      .all(id, JSON.stringify(options.changed));
    return { runs: rows.map(turn).reverse() };
  }
  const size = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 100)));
  const before = options.before;
  const rows = before === undefined
    ? world.db.prepare(`${scope}${order} LIMIT ?`).all(id, size + 1)
    : world.db.prepare(`${scope} AND (r.created_at, r.rowid) <
        (SELECT created_at, rowid FROM core_runs WHERE id = ? AND conversation_id = ?)${order} LIMIT ?`).all(id, before, id, size + 1);
  const page = rows.slice(0, size);
  const boundary = page.at(-1);
  const nextCursor = rows.length > size && boundary ? String(boundary.id) : null;
  if (!before && nextCursor && boundary) {
    page.push(...world.db.prepare(`${scope} AND r.state IN (${LEASED_SQL})
      AND (r.created_at, r.rowid) < (?, ?)${order}`)
      .all(id, boundary.created_at, boundary.history_order));
  }
  return { runs: page.map(turn).reverse(), nextCursor };
}

/** Newest first. A device can keep turns held by executors visible beyond its window of recent runs. */
export function listRuns(world: World, options: {
  conversationId?: string; limit?: number; includeWaiting?: boolean; hiddenConversations?: readonly string[];
} = {}): Run[] {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 200);
  const scope = `FROM core_runs WHERE (? IS NULL OR conversation_id = ?)
    AND conversation_id NOT IN (SELECT value FROM json_each(?))`;
  const args = [options.conversationId ?? null, options.conversationId ?? null, JSON.stringify(options.hiddenConversations ?? [])];
  const recent = world.db.prepare(`SELECT *, rowid AS position ${scope} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args, limit);
  if (options.includeWaiting && recent.length === limit) {
    const boundary = recent[limit - 1];
    const active = world.db.prepare(`SELECT * ${scope} AND state IN (${LEASED_SQL}) AND (created_at, rowid) < (?, ?)
      ORDER BY created_at DESC, rowid DESC`).all(...args, boundary.created_at, boundary.position);
    return [...recent, ...active].map(toRun);
  }
  return recent.map(toRun);
}

/** Page through a rule's own runs, including manual triggers. Ordinary follow-up turns in the conversation stay out. */
export function listAutomationRuns(world: World, automationId: string, before: string | null = null, limit = 20) {
  const scope = "FROM core_runs WHERE automation_id = ?";
  const order = "ORDER BY created_at DESC, rowid DESC LIMIT ?";
  const size = Math.max(1, Math.min(100, Math.trunc(limit)));
  const rows = before === null
    ? world.db.prepare(`SELECT * ${scope} ${order}`).all(automationId, size + 1)
    : world.db.prepare(`SELECT * ${scope} AND (created_at, rowid) <
        (SELECT created_at, rowid FROM core_runs WHERE id = ? AND automation_id = ?) ${order}`)
      .all(automationId, before, automationId, size + 1);
  const runs = rows.slice(0, size).map(toRun);
  return { runs, nextCursor: rows.length > size ? runs[runs.length - 1].id : null };
}

/** The bounded recent exchange before `run` in its conversation, oldest first.
 * Given to the engine as context; never as instructions it must follow.
 */
export function conversationBefore(world: World, run: Run, options: { turns?: number; chars?: number } = {}): Array<{ role: "user" | "assistant"; text: string }> {
  const chars = options.chars ?? 1000;
  const rows = world.db.prepare(`SELECT * FROM core_runs WHERE conversation_id = ? AND id != ?
    AND state IN ('completed', 'failed', 'cancelled') AND created_at <= ?
    ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(run.conversationId, run.id, run.createdAt, options.turns ?? 6).map(toRun).reverse();
  return rows.flatMap((past) => [
    { role: "user" as const, text: past.goal.slice(0, chars) },
    { role: "assistant" as const, text: (past.outcome?.reply ?? `(${past.state}${past.outcome?.error ? `: ${past.outcome.error}` : ""})`).slice(0, chars) },
  ]);
}
