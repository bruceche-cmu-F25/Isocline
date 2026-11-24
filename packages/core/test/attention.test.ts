import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acknowledgeNotice, ATTENTION, attends, claimNotice, CORE_MIGRATIONS, createNotice, decide, isOpen, listEvents, listNotices, noticeClass, openWorld,
  presentNotice, recordDomainEvent, releaseNotice, reportPresence, undeliveredNotices, type Outlet, type World,
} from "../src/index.ts";

const T0 = Date.parse("2026-11-19T09:00:00.000Z");
const made = new Date(T0).toISOString();
/** Notices as they are made: a run's result, a question, a proposal, an interrupted run, and how a change outside went. */
const NOTICES = {
  result: { kind: "run_result", payload: { status: "completed" } },
  question: { kind: "run_request", payload: { kind: "input" } },
  proposal: { kind: "proposal", payload: {} },
  interrupted: { kind: "run_interrupted", payload: {} },
  sent: { kind: "outbound", payload: { state: "done" } },
  refused: { kind: "outbound", payload: { state: "failed" } },
  unsure: { kind: "outbound", payload: { state: "unknown" } },
  welcome: { kind: "welcome", payload: {} },
} as const;
const notice = (name: keyof typeof NOTICES) => ({ kind: NOTICES[name].kind, class: noticeClass(NOTICES[name].kind, NOTICES[name].payload), createdAt: made });

/** A window of the app: `attending` is in front and focused; `usedAgoMs`, how long before T0 it was last touched. */
const windowOutlet = (id: string, attending: boolean, usedAgoMs = 0): Outlet => ({ id, kind: "window", attending, activeAt: T0 - usedAgoMs });
/** The Mac's figure: `attending` is the Mac awake and unlocked; `touchedAt`, when it was last used, if it says. */
const figure = (attending: boolean, touchedAt?: number): Outlet => ({ id: "mac.figure", kind: "figure", attending, ...(touchedAt === undefined ? {} : { activeAt: touchedAt }) });
const push: Outlet = { id: "push", kind: "push", attending: false };
const after = (ms: number) => T0 + ms;

test("what a notice is to the user: it waits on them, it is news, or it is the welcome", () => {
  const classes = Object.fromEntries(Object.keys(NOTICES).map((name) => [name, notice(name as keyof typeof NOTICES).class]));
  assert.deepEqual(classes, {
    question: "needs_you", proposal: "needs_you", interrupted: "needs_you", refused: "needs_you", unsure: "needs_you",
    result: "tells_you", sent: "tells_you",
    welcome: "greeting",
  });
  assert.equal(noticeClass("reminder", {}), "tells_you", "a kind that has no place in the list yet is news");
});

test("every notice says which it is, read from its kind and what it carries", () => {
  const world = openWorld(":memory:", CORE_MIGRATIONS);
  world.tx((db) => {
    const event = recordDomainEvent(world, { kind: "outbound.unknown", payload: {} });
    createNotice(db, { eventSeq: event.seq, kind: "outbound", payload: { state: "unknown", preview: "Email Ana" } });
    createNotice(db, { eventSeq: event.seq, kind: "run_result", payload: { status: "completed" } });
  });
  assert.deepEqual(listNotices(world).map((item) => [item.kind, item.class]), [["outbound", "needs_you"], ["run_result", "tells_you"]]);
  world.close();
});

test("row 1: a window in use gets it at once, and of several the one used last", () => {
  const outlets = [windowOutlet("phone.window", true, 40_000), windowOutlet("mac.window", true, 10_000), windowOutlet("tab", false, 1_000), figure(true), push];
  for (const name of ["result", "question", "proposal", "interrupted", "sent", "refused", "unsure"] as const) {
    assert.deepEqual(decide(notice(name), outlets, after(0)), { do: "tell", outlet: "mac.window" }, name);
  }
});

test("row 2: at the Mac but not looking, the figure says it, once a window has had its chance", () => {
  const outlets = [windowOutlet("mac.window", false), figure(true), push];
  assert.deepEqual(decide(notice("result"), outlets, after(400)), { do: "wait", until: after(ATTENTION.figureAfterMs) });
  assert.deepEqual(decide(notice("result"), outlets, after(ATTENTION.figureAfterMs)), { do: "tell", outlet: "mac.figure" });
  assert.deepEqual(decide(notice("unsure"), outlets, after(60_000)), { do: "tell", outlet: "mac.figure" }, "and not the phone while the user is at the Mac");
});

test("at the Mac means it was touched lately: an unlocked Mac left alone is not somewhere to say things", () => {
  const within = ATTENTION.atMachineWithinMs;
  assert.equal(attends(figure(true, T0), T0 + within - 1), true);
  assert.equal(attends(figure(true, T0), T0 + within), false);
  assert.equal(attends(figure(false, T0), T0), false, "locked or asleep");
  assert.equal(attends(push, T0), false, "nobody is looking at a pocket");
  // Left alone since before the notice was made: it is the phone's, not the figure's.
  const outlets = [windowOutlet("mac.window", false), figure(true, T0 - within), push];
  assert.deepEqual(decide(notice("question"), outlets, after(ATTENTION.pushAfterMs)), { do: "tell", outlet: "push" });
  // Touched a minute ago: the figure says it, and the phone stays quiet.
  assert.deepEqual(decide(notice("question"), [figure(true, T0 - 60_000), push], after(ATTENTION.pushAfterMs)), { do: "tell", outlet: "mac.figure" });
});

test("a window in use was touched lately: one left in front of an empty chair is not somewhere to show things", () => {
  const within = ATTENTION.atWindowWithinMs;
  assert.equal(attends(windowOutlet("mac.window", true), T0 + within - 1), true);
  assert.equal(attends(windowOutlet("mac.window", true), T0 + within), false);
  assert.equal(attends(windowOutlet("mac.window", false), T0), false, "not in front");
  assert.equal(attends({ id: "old.tab", kind: "window", attending: true }, T0 + within), true, "one that does not say when it was used is taken at its word");
  // In front, and left alone since long before the notice: the figure says it if the Mac is in use, else the phone.
  const left = windowOutlet("mac.window", true, within);
  assert.deepEqual(decide(notice("result"), [left, figure(true, T0), push], after(ATTENTION.figureAfterMs)), { do: "tell", outlet: "mac.figure" });
  assert.deepEqual(decide(notice("result"), [left, figure(true, T0 - ATTENTION.atMachineWithinMs), push], after(ATTENTION.pushAfterMs)), { do: "tell", outlet: "push" });
  assert.deepEqual(decide(notice("sent"), [left, push], after(ATTENTION.pushAfterMs)), { do: "wait", until: "return" });
  // Of two in front, the one still in use.
  assert.deepEqual(decide(notice("result"), [left, windowOutlet("phone.window", true, 60_000)], after(0)), { do: "tell", outlet: "phone.window" });
});

test("row 3: at no device, what needs the user and a run's result go to the phone after a wait; 'it went through' does not", () => {
  const outlets = [windowOutlet("mac.window", false), figure(false), push];
  for (const name of ["result", "question", "proposal", "interrupted", "refused", "unsure"] as const) {
    assert.deepEqual(decide(notice(name), outlets, after(5_000)), { do: "wait", until: after(ATTENTION.pushAfterMs) }, name);
    assert.deepEqual(decide(notice(name), outlets, after(ATTENTION.pushAfterMs)), { do: "tell", outlet: "push" }, name);
  }
  assert.deepEqual(decide(notice("sent"), outlets, after(ATTENTION.pushAfterMs)), { do: "wait", until: "return" });
});

test("row 4: otherwise it waits for the user's return", () => {
  // No phone has notifications on.
  assert.deepEqual(decide(notice("question"), [windowOutlet("mac.window", false), figure(false)], after(60_000)), { do: "wait", until: "return" });
  assert.deepEqual(decide(notice("question"), [], after(60_000)), { do: "wait", until: "return" });
  // Found too late to be news (the home node was off): no buzz for it.
  assert.deepEqual(decide(notice("result"), [push], after(ATTENTION.pushWhileFreshMs + 1)), { do: "wait", until: "return" });
  assert.deepEqual(decide(notice("result"), [push], after(ATTENTION.pushWhileFreshMs)), { do: "tell", outlet: "push" });
});

test("an outlet that was handed a notice and did not present it is passed over", () => {
  const outlets = [windowOutlet("mac.window", true, 10_000), windowOutlet("phone.window", true, 40_000), figure(true), push];
  assert.deepEqual(decide(notice("question"), outlets, after(30_000), { tried: new Set(["mac.window"]) }), { do: "tell", outlet: "phone.window" });
  assert.deepEqual(decide(notice("question"), outlets, after(30_000), { tried: new Set(["mac.window", "phone.window"]) }), { do: "tell", outlet: "mac.figure" });
  assert.deepEqual(decide(notice("question"), outlets, after(30_000), { tried: new Set(["mac.window", "phone.window", "mac.figure"]) }), { do: "tell", outlet: "push" });
  assert.deepEqual(decide(notice("question"), outlets, after(30_000), { tried: new Set(["mac.window", "phone.window", "mac.figure", "push"]) }), { do: "wait", until: "return" });
});

test("the welcome is not this table's: it goes to the device that saw the user come back", () => {
  assert.deepEqual(decide(notice("welcome"), [windowOutlet("mac.window", true), figure(true), push], after(60_000)), { do: "nothing" });
});

test("the waits are the policy's, in one place", () => {
  const policy = { ...ATTENTION, figureAfterMs: 0, pushAfterMs: 1_000, pushes: () => true };
  assert.deepEqual(decide(notice("result"), [figure(true)], after(0), { policy }), { do: "tell", outlet: "mac.figure" });
  assert.deepEqual(decide(notice("sent"), [push], after(1_000), { policy }), { do: "tell", outlet: "push" });
});

const told = (world: World, kind: string, now = Date.now()) => world.tx((db) => {
  const event = recordDomainEvent(world, { kind: "run.completed", payload: {}, now });
  return createNotice(db, { eventSeq: event.seq, kind, payload: {}, now });
});

test("who a notice was handed to and where it was shown are events; holding on to it longer is not", () => {
  const world = openWorld(":memory:", CORE_MIGRATIONS);
  const now = Date.now();
  const first = told(world, "run_result", now), second = told(world, "proposal", now);
  const before = listEvents(world).cursor;
  claimNotice(world, first.id, "mac.figure", { now });
  claimNotice(world, first.id, "mac.figure", { now: now + 5_000 }); // the same holder, a little longer
  presentNotice(world, first.id, "mac.figure", { now: now + 6_000 });
  presentNotice(world, first.id, "mac.figure", { now: now + 7_000 });
  acknowledgeNotice(world, first.id, { now: now + 8_000 });
  // The phone held the second one; its hold ran out, and the Mac took it over.
  claimNotice(world, second.id, "push", { now, ttlMs: 1_000 });
  claimNotice(world, second.id, "mac.figure", { now: now + 9_000 });
  assert.deepEqual(listEvents(world, { after: before }).events.map((event) => [event.kind, event.payload.kind, event.payload.to ?? event.payload.by ?? null, event.actor]), [
    ["notice.assigned", "run_result", "mac.figure", "system"],
    ["notice.presented", "run_result", "mac.figure", "system"],
    ["notice.acknowledged", "run_result", null, "user"],
    ["notice.assigned", "proposal", "push", "system"],
    ["notice.assigned", "proposal", "mac.figure", "system"],
  ]);
  assert.deepEqual(undeliveredNotices(world, now + 9_000).filter((item) => isOpen(item, now + 9_000)), [], "neither is anybody's to take any more");
  world.close();
});

test("whoever was handed a notice has a while to show it; after that it is open again, and handing it over again is news", () => {
  const world = openWorld(":memory:", CORE_MIGRATIONS);
  const now = Date.now();
  const made = told(world, "run_result", now);
  const open = (at: number) => undeliveredNotices(world, at).filter((item) => isOpen(item, at)).map((item) => item.id);
  assert.deepEqual(open(now), [made.id]);
  claimNotice(world, made.id, "phone.tab", { now, ttlMs: 8_000 });
  assert.deepEqual(open(now + 7_999), [], "the phone's window has it");
  assert.deepEqual(open(now + 8_000), [made.id], "it did not show it in time");
  // Taking it back says who had it, once; there is nothing to take back while it is held, or once it is shown.
  assert.equal(releaseNotice(world, made.id, { now: now + 7_999 }), null);
  assert.equal(releaseNotice(world, made.id, { now: now + 8_000 }), "phone.tab");
  assert.equal(releaseNotice(world, made.id, { now: now + 8_000 }), null);
  assert.deepEqual([undeliveredNotices(world, now + 8_000)[0].state, undeliveredNotices(world, now + 8_000)[0].claimedBy], ["pending", null]);
  // The same window again, later (the user turned back to it): that is a new handing over, and recorded as one.
  claimNotice(world, made.id, "phone.tab", { now: now + 60_000, ttlMs: 8_000 });
  presentNotice(world, made.id, "phone.tab", { now: now + 61_000 });
  assert.deepEqual(listEvents(world).events.filter((event) => event.kind.startsWith("notice.")).map((event) => [event.kind, event.payload.to ?? event.payload.by]),
    [["notice.assigned", "phone.tab"], ["notice.assigned", "phone.tab"], ["notice.presented", "phone.tab"]]);
  assert.deepEqual(undeliveredNotices(world, now + 61_000), []);
  assert.equal(releaseNotice(world, made.id, { now: now + 99_000 }), null);
  world.close();
});

test("the welcome is handed to the device that saw the return; handing notices about is not counted as Isocline's work", () => {
  const world = openWorld(":memory:", CORE_MIGRATIONS);
  const now = Date.now(), hour = 3_600_000;
  reportPresence(world, { clientId: "mac", kind: "active", now: now - 5 * hour });
  reportPresence(world, { clientId: "mac", kind: "away", now: now - 4 * hour });
  const result = told(world, "run_result", now - 3 * hour);
  claimNotice(world, result.id, "push", { now: now - 3 * hour + 20_000, ttlMs: 12 * hour });
  const { notice: welcome } = reportPresence(world, { clientId: "mac", kind: "active", now });
  assert.deepEqual(welcome!.payload.changes, {});
  assert.deepEqual(listEvents(world).events.filter((event) => event.kind === "notice.assigned").map((event) => [event.payload.kind, event.payload.to]), [["run_result", "push"], ["welcome", "mac"]]);
  world.close();
});
