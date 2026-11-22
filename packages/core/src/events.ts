/** The append-only event log. "What happened while I was away" is a query over
 * it; anything shown or spoken about past work must trace to a row here.
 */
import type { DatabaseSync } from "node:sqlite";
import { coreContext, type Actor } from "./context.ts";
import { iso, newId } from "./ids.ts";
import type { World } from "./world.ts";

export interface CoreEvent {
  seq: number;
  id: string;
  at: string;
  kind: string;
  subject: string | null;
  runId: string | null;
  actor: Actor | null;
  payload: Record<string, unknown>;
}
export interface EventInput {
  kind: string;
  subject?: string;
  payload: Record<string, unknown>;
  /** Defaults to the ambient core context. */
  actor?: Actor | null;
  runId?: string | null;
  now?: number;
}

const MAX_PAYLOAD = 16_000;
const KIND = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;

export class RunLeaseLostError extends Error {
  override name = "RunLeaseLostError";
  constructor() { super("Run lease expired or was replaced; no changes were written"); }
}

/** Only inside a world transaction. */
export function appendEvent(db: DatabaseSync, input: EventInput): CoreEvent {
  if (!KIND.test(input.kind) || input.kind.length > 64) throw new Error(`Invalid event kind: ${input.kind}`);
  const payload = JSON.stringify(input.payload);
  if (payload.length > MAX_PAYLOAD) throw new Error("Event payload too large");
  const context = coreContext();
  const event = {
    id: newId(),
    at: iso(input.now ?? Date.now()),
    kind: input.kind,
    subject: input.subject ?? null,
    runId: input.runId !== undefined ? input.runId : context?.run?.id ?? null,
    actor: input.actor !== undefined ? input.actor : context?.actor ?? null,
  };
  const row = db.prepare(`INSERT INTO core_events (id, at, kind, subject, run_id, actor, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq`).get(event.id, event.at, event.kind, event.subject, event.runId, event.actor, payload);
  return { seq: row!.seq as number, ...event, payload: input.payload };
}

/** A run whose lease lapsed or was taken over must not change the world. */
function assertRunStillOwned(db: DatabaseSync, now: number): void {
  const run = coreContext()?.run;
  if (!run) return;
  const row = db.prepare("SELECT state, lease_owner, lease_until FROM core_runs WHERE id = ?").get(run.id);
  if (!row || row.lease_owner !== run.owner || !["running", "cancelling"].includes(row.state as string)
    || Date.parse(row.lease_until as string) <= now) {
    throw new RunLeaseLostError();
  }
}

/** For modules: call inside the module's own write transaction. Under a run
 * context it throws (rolling the module's write back) if the run no longer
 * owns its lease.
 */
export function recordDomainEvent(world: World, input: EventInput): CoreEvent {
  if (!world.inTx()) throw new Error("Domain events are recorded inside the domain's own transaction");
  assertRunStillOwned(world.db, input.now ?? Date.now());
  return appendEvent(world.db, input);
}

/** The fields that differ between two versions of a record, each value bounded,
 * or null when nothing changed. Modules put this in an `.updated` event.
 */
export function changedFields(before: object, after: object): Record<string, [unknown, unknown]> | null {
  const bound = (value: unknown) => typeof value === "string" ? value.slice(0, 200) : value && typeof value === "object" ? "(changed)" : value ?? null;
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  const changes: Record<string, [unknown, unknown]> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) changes[key] = [bound(a[key]), bound(b[key])];
  }
  return Object.keys(changes).length ? changes : null;
}

export function toEvent(row: Record<string, unknown>): CoreEvent {
  return {
    seq: row.seq as number, id: row.id as string, at: row.at as string, kind: row.kind as string,
    subject: row.subject as string | null, runId: row.run_id as string | null, actor: row.actor as Actor | null,
    payload: JSON.parse(row.payload as string),
  };
}

export interface EventQuery { after?: number; runId?: string; subject?: string; limit?: number }

/** Ordered by seq; `after` is a cursor so a reconnecting client can catch up. */
export function listEvents(world: World, query: EventQuery = {}): { events: CoreEvent[]; cursor: number } {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 500);
  const rows = world.db.prepare(`SELECT * FROM core_events WHERE seq > ?
    AND (? IS NULL OR run_id = ?) AND (? IS NULL OR subject = ?) ORDER BY seq LIMIT ?`)
    .all(query.after ?? 0, query.runId ?? null, query.runId ?? null, query.subject ?? null, query.subject ?? null, limit);
  const events = rows.map(toEvent);
  return { events, cursor: events.length ? events[events.length - 1].seq : query.after ?? 0 };
}

/** Who last changed each subject that starts with `prefix` (e.g. `todo:`), from the event log: provenance is read
 * from what happened, not stored as a label. It reads every event there ever was under the prefix; where the
 * subjects are known, `lastChangesOf` does not. */
export function lastChanges(world: World, prefix: string): Map<string, { actor: Actor | null; kind: string; at: string }> {
  const rows = world.db.prepare(`SELECT subject, actor, kind, at FROM core_events WHERE seq IN (
    SELECT MAX(seq) FROM core_events WHERE subject >= ? AND subject < ? GROUP BY subject)`).all(prefix, `${prefix}\uffff`);
  return new Map(rows.map((row) => [row.subject as string, { actor: row.actor as Actor | null, kind: row.kind as string, at: row.at as string }]));
}

/** Who last changed each of these subjects (`todo:abc`…). Each is looked up by itself through the log's index, so
 * it costs the same however long the log has grown: for a snapshot, which knows the things it shows. */
export function lastChangesOf(world: World, subjects: readonly string[]): Map<string, { actor: Actor | null; kind: string; at: string }> {
  if (!subjects.length) return new Map();
  const rows = world.db.prepare(`SELECT e.subject, e.actor, e.kind, e.at FROM json_each(?) s
    JOIN core_events e ON e.seq = (SELECT MAX(seq) FROM core_events WHERE subject = s.value)`).all(JSON.stringify(subjects));
  return new Map(rows.map((row) => [row.subject as string, { actor: row.actor as Actor | null, kind: row.kind as string, at: row.at as string }]));
}

export function latestEventSeq(world: World): number {
  return (world.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM core_events").get()!.seq as number);
}

/** For whoever acts on what happened (a module's mirror, the todo list following the calendar): calls `listener`
 * after each commit that recorded events, with the kinds recorded since it was last called (or since it began to
 * listen). It keeps its own place in the log, so nothing is told twice. Returns an unsubscribe function. */
export function onEvents(world: World, listener: (kinds: ReadonlySet<string>) => void): () => void {
  let seen = latestEventSeq(world);
  return world.onCommit(() => {
    const rows = world.db.prepare("SELECT kind, MAX(seq) AS seq FROM core_events WHERE seq > ? GROUP BY kind").all(seen);
    if (!rows.length) return;
    seen = Math.max(...rows.map((row) => row.seq as number));
    listener(new Set(rows.map((row) => row.kind as string)));
  });
}

/** The work events (not lifecycle) written under each run, by run id. */
export function listRunReceipts(world: World, runIds: readonly string[]): Record<string, CoreEvent[]> {
  const receipts: Record<string, CoreEvent[]> = {};
  const rows = world.db.prepare(`SELECT * FROM core_events WHERE run_id IN (SELECT value FROM json_each(?))
    AND kind NOT LIKE 'run.%' ORDER BY seq`).all(JSON.stringify(runIds));
  for (const event of rows.map(toEvent)) (receipts[event.runId!] ??= []).push(event);
  return receipts;
}

/** How each run went: its steps, views it opened, questions and answers, what the user added
 * while it worked, and what it ran on, by run id.
 */
export function listRunActivity(world: World, runIds: readonly string[]): Record<string, CoreEvent[]> {
  const activity: Record<string, CoreEvent[]> = {};
  const rows = world.db.prepare(`SELECT * FROM core_events WHERE run_id IN (SELECT value FROM json_each(?))
    AND kind IN ('run.step', 'run.view', 'run.waiting', 'run.answered', 'run.steered', 'run.usage') ORDER BY seq`).all(JSON.stringify(runIds));
  for (const event of rows.map(toEvent)) (activity[event.runId!] ??= []).push(event);
  return activity;
}

export function readRunEvents(db: DatabaseSync, runId: string): CoreEvent[] {
  return db.prepare("SELECT * FROM core_events WHERE run_id = ? ORDER BY seq").all(runId).map(toEvent);
}
