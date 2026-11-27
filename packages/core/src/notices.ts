/** Nothing is spoken or shown directly: results, interruptions and requests
 * become notices, and only a device's report that it actually presented one
 * marks it delivered. A notice is information, never an instruction.
 *
 * Who a notice was handed to, where it was shown and when the user dismissed it are events (`notice.assigned`,
 * `notice.presented`, `notice.acknowledged`), so "where was I told about this?" has an answer.
 */
import type { DatabaseSync } from "node:sqlite";
import { noticeClass, type NoticeClass } from "./attention.ts";
import { appendEvent } from "./events.ts";
import { iso, newId } from "./ids.ts";
import { refreshResultRecaps } from "./result-delivery.ts";
import { NOTICE_STATES } from "./schema.ts";
import type { World } from "./world.ts";

export type NoticeState = (typeof NOTICE_STATES)[number];
export interface Notice {
  id: string;
  eventSeq: number;
  kind: string;
  state: NoticeState;
  createdAt: string;
  updatedAt: string;
  claimedBy: string | null;
  claimUntil: string | null;
  expiresAt: string | null;
  payload: Record<string, unknown>;
  /** What it is to the user (attention.ts). Read from its kind and payload each time, not stored. */
  class: NoticeClass;
}

export class NoticeStateError extends Error {
  override name = "NoticeStateError";
  readonly code: "missing" | "state" | "claim";
  constructor(code: "missing" | "state" | "claim") {
    super(code === "missing" ? "No such notice" : code === "claim" ? "Notice is claimed by another device" : "Notice is not in a state that allows this");
    this.code = code;
  }
}

const CLIENT = /^[A-Za-z0-9._:-]{1,80}$/;
function client(value: string): string {
  if (!CLIENT.test(value)) throw new Error("Invalid client id");
  return value;
}

function toNotice(row: Record<string, unknown>): Notice {
  const payload = JSON.parse(row.payload as string) as Record<string, unknown>;
  return {
    id: row.id as string, eventSeq: row.event_seq as number, kind: row.kind as string, state: row.state as NoticeState,
    createdAt: row.created_at as string, updatedAt: row.updated_at as string, claimedBy: row.claimed_by as string | null,
    claimUntil: row.claim_until as string | null, expiresAt: row.expires_at as string | null, payload,
    class: noticeClass(row.kind as string, payload),
  };
}

/** Only inside a world transaction, next to the event it is about. */
export function createNotice(db: DatabaseSync, input: { eventSeq: number; kind: string; payload: Record<string, unknown>; ttlMs?: number; now?: number }): Notice {
  const now = input.now ?? Date.now();
  const id = newId();
  db.prepare(`INSERT INTO core_notices (id, event_seq, kind, state, created_at, updated_at, expires_at, payload)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`)
    .run(id, input.eventSeq, input.kind, iso(now), iso(now), input.ttlMs ? iso(now + input.ttlMs) : null, JSON.stringify(input.payload));
  return load(db, id);
}

function load(db: DatabaseSync, id: string): Notice {
  const row = db.prepare("SELECT * FROM core_notices WHERE id = ?").get(id);
  if (!row) throw new NoticeStateError("missing");
  return toNotice(row);
}

function expire(db: DatabaseSync, now: number): void {
  db.prepare(`UPDATE core_notices SET state = 'expired', updated_at = ?, claimed_by = NULL, claim_until = NULL
    WHERE state IN ('pending', 'claimed') AND expires_at IS NOT NULL AND expires_at <= ?`).run(iso(now), iso(now));
}

/** Hands a notice to `to` until `until`, and records it. Only inside a world transaction. The one way a notice
 * gets a holder, whoever chose it: a device taking it for itself, the home node sending it somewhere (server
 * attention.ts), or the welcome going to the device that saw the user come back. */
export function handNotice(db: DatabaseSync, notice: Pick<Notice, "id" | "kind">, to: string, until: number, now: number): void {
  db.prepare("UPDATE core_notices SET state = 'claimed', claimed_by = ?, claim_until = ?, updated_at = ? WHERE id = ?").run(to, iso(until), iso(now), notice.id);
  appendEvent(db, { kind: "notice.assigned", subject: `notice:${notice.id}`, actor: "system", runId: null, now, payload: { noticeId: notice.id, kind: notice.kind, to } });
}

/** Who holds what the welcome told (`claimed_by`). It is no outlet's name, so no window shows any of it again. */
export const WELCOME_HOLDER = "welcome";

/** The user is back after a while, and the welcome is about to say so. Everything not shown anywhere yet (nobody's,
 * or handed to someone who has not shown it) is told by that welcome, once: it says what was done and how many
 * things wait, and none of them is said one by one afterwards. They stay in the list until dismissed. Only inside
 * a world transaction, next to the welcome. Returns how many there were. */
export function tellInWelcome(db: DatabaseSync, now: number): number {
  expire(db, now);
  // A reminder is not something that waited: still in time, it is told on its own (an event in five minutes must
  // not slip by inside "welcome back"); out of time, it has already lapsed (docs/design/reminders.md §3).
  const waiting = db.prepare("SELECT id, kind FROM core_notices WHERE state IN ('pending', 'claimed') AND kind NOT IN ('welcome', 'reminder') ORDER BY created_at, rowid").all() as { id: string; kind: string }[];
  for (const notice of waiting) {
    db.prepare("UPDATE core_notices SET state = 'presented', claimed_by = ?, claim_until = NULL, updated_at = ? WHERE id = ?").run(WELCOME_HOLDER, iso(now), notice.id);
    appendEvent(db, { kind: "notice.presented", subject: `notice:${notice.id}`, actor: "system", runId: null, now, payload: { noticeId: notice.id, kind: notice.kind, by: WELCOME_HOLDER } });
  }
  return waiting.length;
}

/** The notices not shown anywhere yet, oldest first: nobody's (`pending`), or handed to someone who has not shown
 * it (`claimed`). Unlike `listNotices` it only reads (no expiry pass), so it can be called after every commit
 * without causing one. */
export function undeliveredNotices(world: World, now: number = Date.now()): Notice[] {
  return world.db.prepare(`SELECT * FROM core_notices WHERE state IN ('pending', 'claimed') AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at, rowid`).all(iso(now)).map(toNotice);
}

/** Nobody holds it right now: it was never handed to anyone, or whoever got it ran out of time to show it. */
export function isOpen(notice: Pick<Notice, "state" | "claimUntil">, now: number): boolean {
  return notice.state === "pending" || (notice.state === "claimed" && Date.parse(notice.claimUntil!) <= now);
}

/** Undelivered notices, oldest first. When there are more than `limit`, the newest ones: old notices nobody
 * dismissed must not keep a new one from being told. A lapsed claim counts as pending again. */
export function listNotices(world: World, options: {
  states?: NoticeState[]; limit?: number; now?: number; includeNeedsYou?: boolean; hiddenConversations?: readonly string[];
} = {}): Notice[] {
  const now = options.now ?? Date.now();
  const states = options.states ?? ["pending", "claimed"];
  for (const state of states) if (!NOTICE_STATES.includes(state)) throw new Error("Unknown notice state");
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
  return world.tx((db) => {
    expire(db, now);
    const scope = `FROM core_notices WHERE state IN (SELECT value FROM json_each(?))
      AND coalesce(json_extract(payload, '$.conversationId'), '') NOT IN (SELECT value FROM json_each(?))`;
    const args = [JSON.stringify(states), JSON.stringify(options.hiddenConversations ?? [])];
    const recent = db.prepare(`SELECT *, rowid AS position ${scope} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args, limit);
    if (options.includeNeedsYou && recent.length === limit) {
      const boundary = recent[limit - 1];
      // Ordinary results and greetings never require a decision. Inspect the remaining candidates using the
      // same classification as delivery, including receipts whose significance depends on the outcome.
      const older = db.prepare(`SELECT * ${scope} AND kind NOT IN ('run_result', 'welcome') AND (created_at, rowid) < (?, ?)
        ORDER BY created_at, rowid`).all(...args, boundary.created_at, boundary.position).map(toNotice);
      return [...older.filter((notice) => notice.class === "needs_you"), ...recent.map(toNotice).reverse()];
    }
    return recent.map(toNotice).reverse();
  });
}

/** Names the one who is to show a notice next, for `ttlMs`; after that it is open again. The home node's attention
 * does the naming (server attention.ts). A device may still name itself: clients from before that did, and the
 * welcome is taken that way. */
export function claimNotice(world: World, id: string, clientId: string, options: { ttlMs?: number; now?: number } = {}): Notice {
  const now = options.now ?? Date.now();
  const by = client(clientId);
  return world.tx((db) => {
    expire(db, now);
    const notice = load(db, id);
    if (notice.state !== "claimed" && notice.state !== "pending") throw new NoticeStateError("state");
    if (!isOpen(notice, now) && notice.claimedBy !== by) throw new NoticeStateError("claim");
    const until = now + (options.ttlMs ?? 30_000);
    // Holding on to it a little longer is not news; a new holder is, and so is being handed it again after the
    // time to show it ran out.
    if (notice.state === "claimed" && notice.claimedBy === by && !isOpen(notice, now)) db.prepare("UPDATE core_notices SET claim_until = ?, updated_at = ? WHERE id = ?").run(iso(until), iso(now), id);
    else handNotice(db, notice, by, until, now);
    return load(db, id);
  });
}

/** Its holder ran out of time without showing it: it is nobody's again. Returns who that was; null when there is
 * nothing to take back (it is still held, or it was shown after all). Not an event: the next handing over is. */
export function releaseNotice(world: World, id: string, options: { now?: number } = {}): string | null {
  const now = options.now ?? Date.now();
  return world.tx((db) => {
    const notice = load(db, id);
    if (notice.state !== "claimed" || !isOpen(notice, now)) return null;
    db.prepare("UPDATE core_notices SET state = 'pending', claimed_by = NULL, claim_until = NULL, updated_at = ? WHERE id = ?").run(iso(now), id);
    return notice.claimedBy;
  });
}

/** The device began playing or displaying it. Never replayed after this,
 * even if playback is then interrupted.
 */
export function presentNotice(world: World, id: string, clientId: string, options: { now?: number } = {}): Notice {
  const now = options.now ?? Date.now();
  const by = client(clientId);
  return world.tx((db) => {
    const notice = load(db, id);
    if (notice.state === "presented" || notice.state === "acknowledged") return notice;
    if (notice.state !== "claimed") throw new NoticeStateError("state");
    if (notice.claimedBy !== by) throw new NoticeStateError("claim");
    db.prepare("UPDATE core_notices SET state = 'presented', claim_until = NULL, updated_at = ? WHERE id = ?").run(iso(now), id);
    appendEvent(db, { kind: "notice.presented", subject: `notice:${id}`, actor: "system", runId: null, now, payload: { noticeId: id, kind: notice.kind, by } });
    return load(db, id);
  });
}

/** The user dismissed or opened it. Allowed from any undelivered state. It is recorded as an event: devices redraw
 * when something happens, so without one the notice would stay on every screen, the one it was dismissed on too. */
export function acknowledgeNotice(world: World, id: string, options: { now?: number } = {}): Notice {
  const now = options.now ?? Date.now();
  return world.tx((db) => {
    const notice = load(db, id);
    if (notice.state === "acknowledged") return notice;
    if (notice.state === "expired") throw new NoticeStateError("state");
    db.prepare("UPDATE core_notices SET state = 'acknowledged', claimed_by = NULL, claim_until = NULL, updated_at = ? WHERE id = ?").run(iso(now), id);
    if (notice.kind === "run_result" && notice.payload.delivery === "inbox") refreshResultRecaps(db, [notice.createdAt]);
    appendEvent(db, { kind: "notice.acknowledged", subject: `notice:${id}`, actor: "user", runId: null, now, payload: { noticeId: id, kind: notice.kind } });
    return load(db, id);
  });
}
