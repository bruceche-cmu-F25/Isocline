import assert from "node:assert/strict";
import { test } from "node:test";
import { ATTENTION, claimNotice, CORE_MIGRATIONS, createNotice, listEvents, listNotices, openWorld, presentNotice, recordDomainEvent, reportPresence, type AwayDigest, type World } from "@zirma/core";
import { OUTLET_STALE_MS, Outlets, watchAttention, type Reach } from "../src/index.ts";

/** The table, with a short wait before a notice nobody took is the phone's. */
const policy = { ...ATTENTION, pushAfterMs: 40 };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const world = (): World => openWorld(":memory:", CORE_MIGRATIONS);
const make = (w: World, kind = "run_request", payload: Record<string, unknown> = {}) => w.tx((db) => {
  const event = recordDomainEvent(w, { kind: "run.waiting", payload: {} });
  return createNotice(db, { eventSeq: event.seq, kind, payload });
});
/** The phones, as an outlet: `sent` gets what it was asked to tell; `goesOut` is whether a push service took it. */
const phone = (sent: string[], goesOut = true): Reach => ({
  outlet: { id: "push", kind: "push", attending: false },
  send: async (notice) => { sent.push(notice.id); return goesOut; },
});

test("a notice nobody took is handed where the table says, when it says, once, and that is recorded", async () => {
  const w = world();
  const sent: string[] = [];
  const attention = watchAttention({ world: w, reaches: () => [phone(sent)], policy });
  try {
    const left = make(w), taken = make(w);
    claimNotice(w, taken.id, "mac.figure"); // a device takes this one while the table waits
    await wait(10);
    assert.deepEqual(sent, [], "not before the table's wait is over");
    await wait(120);
    assert.deepEqual(sent, [left.id]);
    assert.deepEqual(listEvents(w).events.filter((event) => event.kind === "notice.assigned").map((event) => [event.payload.noticeId, event.payload.to]),
      [[taken.id, "mac.figure"], [left.id, "push"]]);
    // Once it went out it was told, on the phone: nothing shows it again when a hold runs out, since there is none.
    const pushed = listNotices(w, { states: ["presented"] }).map((notice) => [notice.id, notice.claimedBy, notice.claimUntil]);
    assert.deepEqual(pushed, [[left.id, "push", null]]);
    // Neither of these is the phone's: the welcome, and a change outside that simply went through.
    make(w, "welcome");
    make(w, "outbound", { state: "done" });
    await wait(120);
    assert.equal(sent.length, 1);
  } finally { attention.close(); w.close(); }
});

test("an outlet that does not take a notice is not asked again, and the notice keeps waiting", async () => {
  const w = world();
  const sent: string[] = [];
  const attention = watchAttention({ world: w, reaches: () => [phone(sent, false)], policy });
  try {
    const first = make(w);
    await wait(120);
    const second = make(w, "proposal"); // something else happens: the first is looked at again, and left alone
    await wait(120);
    assert.deepEqual(sent, [first.id, second.id]);
    assert.deepEqual(listNotices(w).map((notice) => notice.state), ["pending", "pending"]);
  } finally { attention.close(); w.close(); }
});

test("with no outlet to hand to, nothing is decided until there is one", async () => {
  const w = world();
  const sent: string[] = [];
  let reaches: Reach[] = [];
  const attention = watchAttention({ world: w, reaches: () => reaches, policy });
  try {
    const left = make(w);
    await wait(100);
    assert.deepEqual(sent, []);
    reaches = [phone(sent)]; // a phone turns notifications on
    make(w, "welcome"); // the next thing that happens
    await wait(60);
    assert.deepEqual(sent, [left.id]);
  } finally { attention.close(); w.close(); }
});

test("closed, it hands nothing on", async () => {
  const w = world();
  const sent: string[] = [];
  const attention = watchAttention({ world: w, reaches: () => [phone(sent)], policy });
  make(w);
  attention.close();
  await wait(120);
  assert.deepEqual(sent, []);
  w.close();
});

test("the outlets that reported lately are known, the one used last first; one that goes quiet is forgotten", () => {
  const outlets = new Outlets();
  const t0 = Date.parse("2026-11-19T09:00:00.000Z");
  outlets.report("home", { client: "mac", kind: "figure", attending: true, idleMs: 4_000 }, t0);
  outlets.report("home", { client: "mac.window", kind: "window", attending: false, idleMs: 60_000 }, t0);
  outlets.report("d-phone", { client: "phone.tab", kind: "window", attending: true, idleMs: 500 }, t0 + 1_000);
  assert.deepEqual(outlets.list(t0 + 1_000).map((outlet) => [outlet.id, outlet.kind, outlet.device, outlet.attending, outlet.activeAt! - t0]), [
    ["phone.tab", "window", "d-phone", true, 500],
    ["mac", "figure", "home", true, -4_000],
    ["mac.window", "window", "home", false, -60_000],
  ]);
  // What an outlet says next replaces what it said before.
  outlets.report("d-phone", { client: "phone.tab", kind: "window", attending: false }, t0 + 30_000);
  const phone = outlets.list(t0 + 30_000).find((outlet) => outlet.id === "phone.tab")!;
  assert.deepEqual([phone.attending, phone.activeAt, phone.reportedAt - t0], [false, undefined, 30_000]);
  // A device that was unpaired takes its outlets with it.
  outlets.report("d-old", { client: "old.tab", kind: "window", attending: true, idleMs: 0 }, t0 + 30_000);
  outlets.forget("d-old");
  assert.equal(outlets.list(t0 + 30_000).some((outlet) => outlet.device === "d-old"), false);
  // The Mac's two said nothing more: the home node no longer takes their word for it.
  assert.deepEqual(outlets.list(t0 + OUTLET_STALE_MS + 1).map((outlet) => outlet.id), ["phone.tab"]);
  assert.deepEqual(outlets.list(t0 + 30_000 + OUTLET_STALE_MS + 1), []);
});

/** Short waits all round: the figure after 30 ms, the phone after 40, and 60 ms for a device to show what it got. */
const quick = { ...ATTENTION, figureAfterMs: 30, pushAfterMs: 40, presentWithinMs: 60 };
const handings = (w: World) => listEvents(w).events.filter((event) => event.kind === "notice.assigned").map((event) => event.payload.to);
const only = (w: World) => listNotices(w, { states: ["pending", "claimed", "presented"] })[0];

test("a window the user is looking at is handed the notice at once and shows it; nothing else is told", async () => {
  const w = world();
  const outlets = new Outlets();
  const sent: string[] = [];
  const attention = watchAttention({ world: w, outlets, reaches: () => [phone(sent)], policy: quick });
  try {
    outlets.report("d-phone", { client: "phone.tab", kind: "window", attending: true, idleMs: 9_000 });
    outlets.report("home", { client: "mac.window", kind: "window", attending: true, idleMs: 200 });
    outlets.report("home", { client: "mac", kind: "figure", attending: true, idleMs: 200 });
    const made = make(w, "run_result");
    await wait(15);
    assert.deepEqual([only(w).state, only(w).claimedBy], ["claimed", "mac.window"], "of two windows in use, the one used last");
    presentNotice(w, made.id, "mac.window");
    await wait(200);
    assert.deepEqual(handings(w), ["mac.window"]);
    assert.deepEqual(sent, []);
  } finally { attention.close(); w.close(); }
});

test("an outlet that does not show what it was handed is passed over: the window, then the figure, then the phone", async () => {
  const w = world();
  const outlets = new Outlets();
  const sent: string[] = [];
  const attention = watchAttention({ world: w, outlets, reaches: () => [phone(sent)], policy: quick });
  try {
    outlets.report("home", { client: "mac.window", kind: "window", attending: true, idleMs: 0 });
    outlets.report("home", { client: "mac", kind: "figure", attending: true, idleMs: 0 });
    const made = make(w);
    await wait(400);
    assert.deepEqual(handings(w), ["mac.window", "mac", "push"]);
    assert.deepEqual(sent, [made.id]);
  } finally { attention.close(); w.close(); }
});

test("what waited for the user is handed to the window they turn to", async () => {
  const w = world();
  const outlets = new Outlets();
  const attention = watchAttention({ world: w, outlets, reaches: () => [], policy: quick });
  try {
    outlets.report("d-phone", { client: "phone.tab", kind: "window", attending: false });
    make(w);
    await wait(100);
    assert.equal(only(w).state, "pending", "nobody to tell: it waits");
    outlets.report("d-phone", { client: "phone.tab", kind: "window", attending: true, idleMs: 0 });
    assert.deepEqual([only(w).state, only(w).claimedBy], ["claimed", "phone.tab"]);
  } finally { attention.close(); w.close(); }
});

test("a window left in front and not touched is not shown things; touched again, it gets what waited", async () => {
  const w = world();
  const outlets = new Outlets();
  const sent: string[] = [];
  const attention = watchAttention({ world: w, outlets, reaches: () => [phone(sent)], policy: quick });
  try {
    const says = (idleMs: number) => outlets.report("home", { client: "mac.window", kind: "window", attending: true, idleMs });
    says(ATTENTION.atWindowWithinMs + 1_000);
    const asked = make(w), news = make(w, "outbound", { state: "done" });
    await wait(150);
    assert.deepEqual(sent, [asked.id], "what needs the user goes to the phone");
    assert.deepEqual(listNotices(w, { states: ["pending", "claimed", "presented"] }).map((notice) => [notice.kind, notice.state, notice.claimedBy]),
      [["run_request", "presented", "push"], ["outbound", "pending", null]]);
    says(0); // the user is back at it
    assert.deepEqual(listNotices(w).find((notice) => notice.id === news.id)!.claimedBy, "mac.window");
    assert.deepEqual(handings(w), ["push", "mac.window"]);
  } finally { attention.close(); w.close(); }
});

test("a window that missed its chance is not asked over and over, and gets another when the user turns back to it", async () => {
  const w = world();
  const outlets = new Outlets();
  const attention = watchAttention({ world: w, outlets, reaches: () => [], policy: quick });
  try {
    const says = (attending: boolean) => outlets.report("home", { client: "mac.window", kind: "window", attending, idleMs: 0 });
    says(true);
    const made = make(w);
    await wait(150); // handed over, and not shown in time
    says(true); // still says it is looked at: no reason to think it would show it now
    await wait(100);
    assert.deepEqual(handings(w), ["mac.window"]);
    says(false);
    says(true);
    assert.deepEqual(handings(w), ["mac.window", "mac.window"]);
    presentNotice(w, made.id, "mac.window");
    assert.equal(only(w).state, "presented");
  } finally { attention.close(); w.close(); }
});

const welcomesOf = (w: World) => listNotices(w, { states: ["pending", "claimed", "presented"] }).filter((notice) => notice.kind === "welcome");

test("back after a while: the welcome is made where the user turned up and tells what waited; nothing is handed out one by one", async () => {
  const w = world();
  const outlets = new Outlets();
  const sent: string[] = [];
  const attention = watchAttention({ world: w, outlets, reaches: () => [phone(sent)], policy: quick, presence: { awayReturnMs: 100 } });
  try {
    reportPresence(w, { clientId: "mac", kind: "active" });
    reportPresence(w, { clientId: "mac", kind: "away" }); // the Mac was locked
    const asked = make(w), news = make(w, "outbound", { state: "done" });
    await wait(150);
    assert.deepEqual(sent, [asked.id], "the question went to the phone; 'it went through' waits");
    outlets.report("home", { client: "mac.window", kind: "window", attending: true, idleMs: 0 }); // back, and looking at Zirma
    const [welcome] = welcomesOf(w);
    assert.deepEqual([welcome.state, welcome.claimedBy, (welcome.payload as unknown as AwayDigest).waiting], ["claimed", "mac.window", 1]);
    const told = listNotices(w, { states: ["presented"] }).map((notice) => [notice.id, notice.claimedBy]);
    assert.deepEqual(told, [[asked.id, "push"], [news.id, "welcome"]]);
    await wait(150);
    assert.deepEqual(handings(w), ["push", "mac.window"], "the question to the phone, the welcome to the window, and nothing else to anyone");
  } finally { attention.close(); w.close(); }
});

test("a phone in the hand is being here: opening the Mac after that is not a return", async () => {
  const w = world();
  const outlets = new Outlets();
  const attention = watchAttention({ world: w, outlets, reaches: () => [], policy: quick, presence: { awayReturnMs: 100 } });
  try {
    const onPhone = () => outlets.report("d-phone", { client: "phone.tab", kind: "window", attending: true, idleMs: 0 });
    const atMac = () => outlets.report("home", { client: "mac", kind: "figure", attending: true, idleMs: 0 });
    reportPresence(w, { clientId: "mac", kind: "active" });
    reportPresence(w, { clientId: "mac", kind: "away" }); // the Mac was locked,
    onPhone(); // and the phone picked up straight away
    const made = make(w, "run_result", { status: "completed" });
    await wait(15);
    assert.deepEqual([only(w).id, only(w).claimedBy], [made.id, "phone.tab"], "what happens meanwhile is shown on the phone");
    presentNotice(w, made.id, "phone.tab");
    await wait(150);
    onPhone();
    atMac();
    assert.deepEqual(welcomesOf(w), [], "the user never left");
    // Without the phone, the same time away from a locked Mac is a return, and the Mac's figure greets.
    outlets.report("d-phone", { client: "phone.tab", kind: "window", attending: false });
    reportPresence(w, { clientId: "mac", kind: "away" });
    await wait(150);
    atMac();
    assert.deepEqual(welcomesOf(w).map((notice) => notice.claimedBy), ["mac"]);
  } finally { attention.close(); w.close(); }
});
