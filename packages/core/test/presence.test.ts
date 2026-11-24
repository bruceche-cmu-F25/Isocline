import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acknowledgeNotice, CORE_MIGRATIONS, claimNotice, createNotice, finishRun, claimNextRun, listEvents, listNotices, openWorld, presentNotice, recordDomainEvent,
  reportPresence, submitRun, undeliveredNotices, withCoreContext, type AwayDigest, type World,
} from "../src/index.ts";

const MIN = 60_000;
const T0 = new Date(2026, 10, 17, 9, 0).getTime();

function world(): World {
  return openWorld(":memory:", [...CORE_MIGRATIONS, { id: "toy:1", sql: "CREATE TABLE toys (id TEXT PRIMARY KEY) STRICT;" }]);
}
const welcomes = (w: World) => w.db.prepare("SELECT state, claimed_by FROM core_notices WHERE kind = 'welcome'").all();

test("the first report only starts the clock", () => {
  const w = world();
  assert.deepEqual(reportPresence(w, { clientId: "mac", kind: "active", now: T0 }), { returned: false, notice: null });
  assert.equal(welcomes(w).length, 0);
});

test("locking the screen and coming back greets once, on the device that saw it", () => {
  const w = world();
  reportPresence(w, { clientId: "mac", kind: "active", now: T0 });
  reportPresence(w, { clientId: "mac", kind: "away", now: T0 + MIN });
  const back = reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 25 * MIN });
  assert.equal(back.returned, true);
  assert.equal(back.notice?.claimedBy, "mac");
  assert.equal((back.notice?.payload.awayMs as number), 24 * MIN);
  // A heartbeat, a second window or another device a moment later: nobody is greeted again.
  assert.equal(reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 25 * MIN + 500 }).returned, false);
  assert.equal(reportPresence(w, { clientId: "phone", kind: "active", now: T0 + 26 * MIN }).returned, false);
  assert.equal(welcomes(w).length, 1);
});

test("a short break is not a return; a repeated away is recorded once", () => {
  const w = world();
  reportPresence(w, { clientId: "mac", kind: "active", now: T0 });
  reportPresence(w, { clientId: "mac", kind: "away", now: T0 + MIN });
  reportPresence(w, { clientId: "mac", kind: "away", now: T0 + 2 * MIN });
  assert.equal(reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 6 * MIN }).returned, false);
  assert.equal(listEvents(w).events.filter((event) => event.kind === "presence.away").length, 1);
  assert.equal(welcomes(w).length, 0);
});

test("long silence without a lock is a return too, and so is a new day", () => {
  const w = world();
  reportPresence(w, { clientId: "mac", kind: "active", now: T0 });
  assert.equal(reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 20 * MIN }).returned, false);
  assert.equal(reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 51 * MIN }).returned, true);
  const lateNight = new Date(2026, 10, 17, 23, 50).getTime();
  const nextMorning = new Date(2026, 10, 18, 0, 5).getTime();
  reportPresence(w, { clientId: "mac", kind: "active", now: lateNight });
  assert.equal(reportPresence(w, { clientId: "mac", kind: "active", now: nextMorning }).returned, true);
});

test("still being here is not an event, and last seen is kept all the same", () => {
  const w = world();
  for (let minute = 0; minute < 10; minute++) reportPresence(w, { clientId: "mac", kind: "active", now: T0 + minute * MIN });
  reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 9 * MIN + 5_000 }); // a second window, seconds later
  const presence = () => listEvents(w).events.filter((event) => event.kind.startsWith("presence.")).map((event) => event.kind);
  assert.deepEqual(presence(), ["presence.active"], "only the first report: the clock starting");
  // Last seen at minute 9, though nothing in the log says so: 29 minutes on is no return, an hour on is.
  assert.equal(reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 38 * MIN }).returned, false);
  assert.equal(reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 100 * MIN }).returned, true);
  // Going away and coming back are changes, and are recorded.
  reportPresence(w, { clientId: "mac", kind: "away", now: T0 + 101 * MIN });
  reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 103 * MIN });
  assert.deepEqual(presence(), ["presence.active", "presence.returned", "presence.away", "presence.active"]);
});

test("a world from before last seen was state: the upgrade takes it from the old events, and greets nobody for it", () => {
  const path = join(mkdtempSync(join(tmpdir(), "alfred-presence-")), "world.sqlite");
  const before = CORE_MIGRATIONS.filter((migration) => Number(migration.id.split(":")[1]) < 12);
  const old = openWorld(path, before);
  const event = (kind: string, at: number) => old.db.prepare("INSERT INTO core_events (id, at, kind, subject, actor, payload) VALUES (?, ?, ?, 'presence', 'user', '{}')")
    .run(`e${at}`, new Date(at).toISOString(), kind);
  event("presence.active", T0);
  event("presence.away", T0 + MIN);
  event("presence.active", T0 + 5 * MIN);
  event("presence.active", T0 + 8 * MIN); // the last heartbeat the old way
  old.close();

  const w = openWorld(path, CORE_MIGRATIONS);
  assert.equal(reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 9 * MIN }).returned, false, "seen a minute ago");
  const back = reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 50 * MIN });
  assert.equal(back.returned, true);
  assert.equal(back.notice?.payload.awayMs, 41 * MIN);
  w.close();
});

test("the welcome says what Zirma did while the user was away, not what the user did", () => {
  const w = world();
  reportPresence(w, { clientId: "mac", kind: "active", now: T0 });
  reportPresence(w, { clientId: "mac", kind: "away", now: T0 + MIN });
  // While away: a run adds a toy; the user's own phone edit is not news.
  const { run } = submitRun(w, { requestId: "r1", goal: "Add a kite and notify me when done.", profile: "tasks", now: T0 + 2 * MIN });
  claimNextRun(w, "home", { now: T0 + 2 * MIN });
  withCoreContext({ actor: "alfred", run: { id: run.id, owner: "home" } }, () => w.tx(() =>
    recordDomainEvent(w, { kind: "toy.added", subject: "toy:kite", payload: {}, now: T0 + 2.5 * MIN })));
  finishRun(w, run.id, "home", { status: "completed", reply: "done" }, { now: T0 + 2.5 * MIN });
  withCoreContext({ actor: "user" }, () => w.tx(() => recordDomainEvent(w, { kind: "toy.added", subject: "toy:ball", payload: {}, now: T0 + 4 * MIN })));

  const back = reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 40 * MIN });
  const digest = back.notice!.payload as { runs: { completed: number; goals: string[] }; changes: Record<string, number>; waiting: number };
  assert.equal(digest.runs.completed, 1);
  assert.deepEqual(digest.runs.goals, ["Add a kite and notify me when done."]);
  assert.deepEqual(digest.changes, { toy: 1 });
  assert.equal(digest.waiting, 0, "a result is news, and the runs above say it: nothing here waits on the user");
});

const tell = (w: World, kind: string, payload: Record<string, unknown>, now: number) => w.tx((db) => {
  const event = recordDomainEvent(w, { kind: "run.completed", payload: {}, now });
  return createNotice(db, { eventSeq: event.seq, kind, payload, now });
});

test("on a return the welcome tells what waited, once: nothing is left to say one by one, and it says how many things need the user", () => {
  const w = world();
  reportPresence(w, { clientId: "mac", kind: "active", now: T0 });
  // Before leaving: an interrupted run was shown on the Mac and left there.
  const old = tell(w, "run_interrupted", {}, T0);
  claimNotice(w, old.id, "mac", { now: T0 });
  presentNotice(w, old.id, "mac", { now: T0 });
  reportPresence(w, { clientId: "mac", kind: "away", now: T0 + MIN });
  // While away: a result and "it went through" nobody was told of, a question the phone was told of, a proposal
  // handed to a window that never showed it, and a failed change the user has dealt with on the phone.
  const result = tell(w, "run_result", { status: "completed" }, T0 + 2 * MIN);
  const sent = tell(w, "outbound", { state: "done" }, T0 + 3 * MIN);
  const question = tell(w, "run_request", { kind: "input" }, T0 + 4 * MIN);
  claimNotice(w, question.id, "push", { now: T0 + 4 * MIN });
  presentNotice(w, question.id, "push", { now: T0 + 4 * MIN });
  const proposal = tell(w, "proposal", {}, T0 + 5 * MIN);
  claimNotice(w, proposal.id, "phone.tab", { now: T0 + 5 * MIN, ttlMs: 8_000 });
  const refused = tell(w, "outbound", { state: "failed" }, T0 + 6 * MIN);
  acknowledgeNotice(w, refused.id, { now: T0 + 7 * MIN });

  const before = listEvents(w).cursor;
  const back = reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 40 * MIN });
  assert.equal((back.notice!.payload as unknown as AwayDigest).waiting, 3, "the question, the proposal, and the interrupted run from before");
  // Nothing is anybody's to hand out any more, except the welcome itself.
  assert.deepEqual(undeliveredNotices(w, T0 + 40 * MIN).map((notice) => [notice.kind, notice.claimedBy]), [["welcome", "mac"]]);
  const where = (id: string) => { const row = w.db.prepare("SELECT state, claimed_by FROM core_notices WHERE id = ?").get(id)!; return [row.state, row.claimed_by]; };
  assert.deepEqual([result, sent, proposal].map((notice) => where(notice.id)), [["presented", "welcome"], ["presented", "welcome"], ["presented", "welcome"]]);
  assert.deepEqual([where(question.id), where(old.id), where(refused.id)], [["presented", "push"], ["presented", "mac"], ["acknowledged", null]], "what was told already is left as it was");
  // That the welcome told them is recorded, like any other showing.
  assert.deepEqual(listEvents(w, { after: before }).events.filter((event) => event.kind.startsWith("notice.")).map((event) => [event.kind, event.payload.kind, event.payload.to ?? event.payload.by]),
    [["notice.assigned", "welcome", "mac"], ["notice.presented", "run_result", "welcome"], ["notice.presented", "outbound", "welcome"], ["notice.presented", "proposal", "welcome"]]);
  // They stay in the list until dismissed.
  assert.equal(listNotices(w, { states: ["presented"], now: T0 + 40 * MIN }).length, 5);
});

test("a short break greets nobody, so what waited is still handed out", () => {
  const w = world();
  reportPresence(w, { clientId: "mac", kind: "active", now: T0 });
  reportPresence(w, { clientId: "mac", kind: "away", now: T0 + MIN });
  const result = tell(w, "run_result", { status: "completed" }, T0 + 2 * MIN);
  assert.equal(reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 5 * MIN }).returned, false);
  assert.deepEqual(undeliveredNotices(w, T0 + 5 * MIN).map((notice) => [notice.id, notice.state]), [[result.id, "pending"]]);
});

test("a newer return replaces a welcome nobody saw", () => {
  const w = world();
  reportPresence(w, { clientId: "mac", kind: "active", now: T0 });
  reportPresence(w, { clientId: "mac", kind: "away", now: T0 + MIN });
  reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 30 * MIN });
  reportPresence(w, { clientId: "mac", kind: "away", now: T0 + 31 * MIN });
  reportPresence(w, { clientId: "mac", kind: "active", now: T0 + 60 * MIN });
  assert.deepEqual(welcomes(w).map((row) => row.state).sort(), ["claimed", "expired"]);
  assert.equal(listNotices(w, { now: T0 + 60 * MIN }).filter((notice) => notice.kind === "welcome").length, 1);
});
