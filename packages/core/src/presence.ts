/** Presence: is the user here, and did they just come back? This module only
 * knows WHEN a return happens and WHAT changed meanwhile, from the world's own
 * records. Ported from Robin's alfred-core/presence.ts, plus an explicit
 * `away` (the screen locked, the machine slept) from devices that can tell.
 *
 * Devices report `active` (real input, a window in use) and `away`. When the
 * user was last seen is state (one row, `core_presence`), spanning every
 * device; being there is not something that happened, so a report that only
 * says "still here" writes no event. What is an event is a change: the first
 * report, going away, coming back from away, and a return.
 * A report is a return when the user was away long enough: after an explicit
 * `away`, `awayReturnMs`; otherwise after `returnAfterMs` of silence, or on a
 * new local day. A return records `presence.returned` and one `welcome`
 * notice, in one transaction, handed to the device that saw the user come
 * back. A second window, a reload or another device reporting a moment later
 * finds fresh presence and greets nobody. What still waited to be told is told
 * by that welcome (docs/design/attention.md): it is not said one by one after.
 */
import type { DatabaseSync } from "node:sqlite";
import { awayChanges, awayResults } from "./result-delivery.ts";
import { appendEvent } from "./events.ts";
import { iso } from "./ids.ts";
import { noticeClass } from "./attention.ts";
import { createNotice, handNotice, tellInWelcome, type Notice } from "./notices.ts";
import type { World } from "./world.ts";

export const PRESENCE_KINDS = ["active", "away"] as const;
export type PresenceKind = (typeof PRESENCE_KINDS)[number];

export interface PresenceOptions {
  /** Silence after which any report counts as a return. */
  returnAfterMs?: number;
  /** After an explicit `away`, how long before coming back counts as a return. */
  awayReturnMs?: number;
}
export const RETURN_AFTER_MS = 30 * 60_000;
export const AWAY_RETURN_MS = 10 * 60_000;
/** "Still here" is written down at most this often: reports come every minute or so from each device. */
const SEEN_EVERY_MS = 20_000;
/** A welcome nobody saw within this long is stale; the next return makes a new one. */
export const WELCOME_TTL_MS = 2 * 60 * 60_000;
const CLAIM_MS = 60_000;

export interface AwayDigest {
  /** When the user was last here, and how long they were gone. */
  since: string;
  awayMs: number;
  /** Runs that finished while away. */
  runs: {
    completed: number; failed: number; interrupted: number; goals: string[];
    /** Up to three recent everyday results. Older saved welcomes only have goal fragments. */
    results?: Array<{ runId: string; conversationId: string; at: string; name: string | null }>;
  };
  /** World changes Zirma or the system made, by module (`todo`, …). Yours are not news. */
  changes: Record<string, number>;
  /** Things that wait on the user right now (a question, a proposal, an interrupted run, a change outside that
   * failed or may not have happened), whether or not a phone was told, and from before they left too. News is not
   * counted: the runs above are the news. */
  waiting: number;
}
export interface PresenceResult { returned: boolean; notice: Notice | null }

const CLIENT = /^[A-Za-z0-9._:-]{1,80}$/;
const localDay = (ms: number) => new Date(ms).toDateString();

function digest(db: DatabaseSync, since: { seq: number; at: string }, now: number): AwayDigest {
  const open = db.prepare(`SELECT kind, payload FROM core_notices WHERE kind != 'welcome'
    AND state IN ('pending', 'claimed', 'presented') AND (expires_at IS NULL OR expires_at > ?)`).all(iso(now)) as { kind: string; payload: string }[];
  const waiting = open.filter((row) => noticeClass(row.kind, JSON.parse(row.payload) as Record<string, unknown>) === "needs_you").length;
  return {
    since: since.at,
    awayMs: now - Date.parse(since.at),
    runs: awayResults(db, since.at, iso(now)),
    changes: awayChanges(db, since.seq, cursor(db)),
    waiting,
  };
}

/** When the user was last seen, and whether they have gone since. `seq` is where the event log stood then: what
 * came after it happened while they were away. */
interface Seen {
  active: { at: number; iso: string; seq: number } | null;
  /** Set while the latest signal is an explicit `away`. */
  away: { at: number; iso: string; seq: number } | null;
}

function seen(db: DatabaseSync): Seen {
  const row = db.prepare("SELECT active_at, active_seq, away_at, away_seq FROM core_presence WHERE id = 1").get();
  const point = (at: unknown, seq: unknown) => (typeof at === "string" ? { at: Date.parse(at), iso: at, seq: Number(seq ?? 0) } : null);
  return { active: point(row?.active_at, row?.active_seq), away: point(row?.away_at, row?.away_seq) };
}

const cursor = (db: DatabaseSync) => db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM core_events").get()!.seq as number;

/** Pure: given the last activity and the last presence signal, is a report at `now` a return?
 * With no history it is not: the clock starts, and the next real return greets.
 */
export function isReturn(lastActive: number | null, latest: { kind: string; at: number } | null, now: number, options: PresenceOptions = {}): boolean {
  if (lastActive === null || latest === null) return false;
  if (latest.kind === "presence.away") return now - latest.at >= (options.awayReturnMs ?? AWAY_RETURN_MS);
  return now - lastActive > (options.returnAfterMs ?? RETURN_AFTER_MS) || localDay(lastActive) !== localDay(now);
}

/** A device saw the user (`active`) or saw them go (`away`). Returns the
 * welcome notice when this report is a return.
 */
export function reportPresence(world: World, input: { clientId: string; kind: PresenceKind; now?: number } & PresenceOptions): PresenceResult {
  if (!CLIENT.test(input.clientId)) throw new Error("Invalid client id");
  if (!PRESENCE_KINDS.includes(input.kind)) throw new Error("Invalid presence kind");
  const now = input.now ?? Date.now();
  const latestOf = (was: Seen) => (was.away ? { kind: "presence.away", at: was.away.at } : was.active ? { kind: "presence.active", at: was.active.at } : null);
  if (input.kind === "active") {
    // "Still here", a moment after the last one: nothing to write down, so not even a transaction.
    const was = seen(world.db);
    if (was.active && !was.away && now - was.active.at < SEEN_EVERY_MS && !isReturn(was.active.at, latestOf(was), now, input)) return { returned: false, notice: null };
  }
  return world.tx((db) => {
    const was = seen(db);
    if (input.kind === "away") {
      if (!was.away) {
        const event = appendEvent(db, { kind: "presence.away", subject: "presence", actor: "user", runId: null, now, payload: { client: input.clientId } });
        db.prepare("UPDATE core_presence SET away_at = ?, away_seq = ? WHERE id = 1").run(iso(now), event.seq);
      }
      return { returned: false, notice: null };
    }
    const here = () => db.prepare("UPDATE core_presence SET active_at = ?, active_seq = ?, away_at = NULL, away_seq = NULL WHERE id = 1").run(iso(now), cursor(db));
    const returned = isReturn(was.active?.at ?? null, latestOf(was), now, input);
    // The first time ever, and back after going away: changes worth an event. Still being here is not.
    if (!was.active || was.away) appendEvent(db, { kind: "presence.active", subject: "presence", actor: "user", runId: null, now, payload: { client: input.clientId } });
    if (!returned || !was.active) {
      here();
      return { returned: false, notice: null };
    }
    // Only the newest welcome matters; an older one nobody presented is stale.
    db.prepare(`UPDATE core_notices SET state = 'expired', updated_at = ?, claimed_by = NULL, claim_until = NULL
      WHERE kind = 'welcome' AND state IN ('pending', 'claimed')`).run(iso(now));
    // Away since the last activity, or since the explicit `away` if that came later.
    const since = was.away ?? was.active;
    const away = digest(db, { seq: since.seq, at: since.iso }, now);
    const event = appendEvent(db, { kind: "presence.returned", subject: "presence", actor: "system", runId: null, now, payload: { ...away, client: input.clientId } });
    const notice = createNotice(db, { eventSeq: event.seq, kind: "welcome", payload: { ...away }, ttlMs: WELCOME_TTL_MS, now });
    // The device that saw the user come back is the one that greets them.
    handNotice(db, notice, input.clientId, now + CLAIM_MS, now);
    // And the greeting is where they hear of what waited: nothing is handed out one by one after it.
    tellInWelcome(db, now);
    here();
    return { returned: true, notice: { ...notice, state: "claimed", claimedBy: input.clientId, claimUntil: iso(now + CLAIM_MS) } };
  });
}
