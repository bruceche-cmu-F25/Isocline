import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  claimNextRun, CORE_MIGRATIONS, createAutomation, createRunDrain, deleteAutomation, ensureTemplates, finishRun, fireDueAutomations, getConversation, getRun, latestSlot,
  listAutomationRuns, listAutomations, listDevices, listEvents, listNotices, listRuns, nextSlot, openWorld, recordDomainEvent, runAutomationNow, submitRun, sweepRuns,
  updateAutomation, updateSettings, withCoreContext,
  type EnginePort, type Run, type RunProfile, type World,
} from "../src/index.ts";
import { oldAutomation } from "./old-world.ts";

const world = (): World => openWorld(":memory:", CORE_MIGRATIONS);
/** Local time, as the home node's clock reads it. 2026-11-19 is a Thursday. */
const at = (day: number, hours: number, minutes = 0) => new Date(2026, 10, day, hours, minutes).getTime();
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
const tick = (w: World, now: number) => fireDueAutomations(w, { profile: "automation", now });
const kinds = (w: World, prefix: string) => listEvents(w).events.map((event) => event.kind).filter((kind) => kind.startsWith(prefix));

test("history pages through the same rule's runs even when two start at the same time", () => {
  const w = world();
  try {
    const schedule = { at: "07:30", days: EVERY_DAY };
    const brief = createAutomation(w, { template: "brief", schedule });
    const other = createAutomation(w, { template: "mail_todos", schedule });
    const options = { profile: "automation", now: at(20, 8) };
    const first = runAutomationNow(w, brief.id, "first", options);
    const foreign = runAutomationNow(w, other.id, "other", options);
    const second = runAutomationNow(w, brief.id, "second", options);
    const page = listAutomationRuns(w, brief.id, null, 1);
    assert.deepEqual(page.runs.map((run) => run.id), [second.id]);
    assert.equal(page.nextCursor, second.id);
    const older = listAutomationRuns(w, brief.id, page.nextCursor, 1);
    assert.deepEqual(older.runs.map((run) => run.id), [first.id]);
    assert.equal(older.nextCursor, null);
    assert.deepEqual(listAutomationRuns(w, brief.id, foreign.id).runs, []);
  } finally { w.close(); }
});

test("an automation's transcript stays out of chat pickers until the user follows up", () => {
  const w = world();
  try {
    const schedule = { at: "07:30", days: EVERY_DAY };
    const brief = createAutomation(w, { template: "brief", schedule });
    const custom = createAutomation(w, { name: "Morning brief", goal: "My own report", schedule });
    const auto = { profile: "automation" };
    const result = runAutomationNow(w, brief.id, "one", auto);
    const other = runAutomationNow(w, custom.id, "custom", auto);
    assert.equal(getConversation(w, result.conversationId).automationOnly, true);
    assert.equal(listAutomationRuns(w, brief.id, null).runs[0].id, result.id);
    assert.equal(getConversation(w, other.conversationId).automationOnly, true, "any automation, not only the sample");
    submitRun(w, { conversationId: result.conversationId, requestId: "followup", goal: "Why do that one first?", profile: "assistant" });
    runAutomationNow(w, brief.id, "tomorrow", auto);
    assert.equal(getConversation(w, result.conversationId).automationOnly, false);
  } finally { w.close(); }
});

test("slots: the latest due and the next, by local time and weekday", () => {
  const weekdays = { at: "07:30", days: [1, 2, 3, 4, 5] };
  assert.equal(latestSlot(weekdays, at(19, 8)), at(19, 7, 30));
  assert.equal(latestSlot(weekdays, at(19, 7)), at(18, 7, 30), "before today's slot: yesterday's");
  assert.equal(latestSlot(weekdays, at(22, 9)), at(20, 7, 30), "on Sunday: Friday's");
  assert.equal(latestSlot(weekdays, at(23, 9)), at(23, 7, 30), "on Monday after 07:30: Monday's");
  assert.equal(nextSlot(weekdays, at(20, 8)), at(23, 7, 30), "after Friday's: Monday's");
  assert.equal(nextSlot(weekdays, at(19, 7, 30)), at(20, 7, 30), "exactly at a slot: the next one");
});

test("an automation fires once per slot, into its own conversation, never for a slot already past when it was made", () => {
  const w = world();
  const automation = createAutomation(w, { name: "Inbox sweep", goal: "Tidy my todos", schedule: { at: "07:30", days: EVERY_DAY } }, at(19, 8));
  assert.deepEqual(tick(w, at(19, 8, 1)), [], "today's 07:30 had passed when it was made");

  const [first] = tick(w, at(20, 7, 30));
  assert.ok(first);
  assert.equal(first.automationId, automation.id);
  assert.equal(first.profile, "automation");
  assert.equal(first.goal, "Tidy my todos");
  assert.equal(getConversation(w, first.conversationId).title, "Inbox sweep");
  assert.deepEqual(tick(w, at(20, 7, 31)), [], "the same slot fires once");
  assert.deepEqual(tick(w, at(20, 23)), []);

  const [second] = tick(w, at(21, 7, 30));
  assert.equal(second.conversationId, first.conversationId, "every run goes to the automation's conversation");
  assert.equal(listRuns(w).length, 2);
  const [view] = listAutomations(w, at(21, 8));
  assert.equal(view.lastRun?.id, second.id);
  assert.equal(view.nextAt, new Date(at(22, 7, 30)).toISOString());
});

test("a slot missed while the node was off runs late at most once; one too late is skipped", () => {
  const w = world();
  createAutomation(w, { name: "Brief", goal: "Brief me", schedule: { at: "07:30", days: EVERY_DAY } }, at(18, 12));
  // Off from the 18th to the 21st at 09:00: three slots missed, only the latest runs, and says it is late.
  const late = tick(w, at(21, 9));
  assert.equal(late.length, 1);
  assert.match(late[0].goal, /running late/);
  assert.deepEqual(tick(w, at(21, 9, 5)), []);
  // Off from the 21st 09:00 to the 22nd 20:00: 07:30 is more than 12 hours late. Skipped, and recorded.
  assert.deepEqual(tick(w, at(22, 20)), []);
  assert.deepEqual(kinds(w, "automation."), ["automation.created", "automation.fired", "automation.skipped"]);
  assert.equal(tick(w, at(23, 7, 30)).length, 1, "and the next slot runs as usual");
});

test("off never fires; on again or rescheduled starts from the next slot, not one already past", () => {
  const w = world();
  const automation = createAutomation(w, { name: "Brief", goal: "Brief me", schedule: { at: "07:30", days: EVERY_DAY }, enabled: false }, at(18, 12));
  assert.deepEqual(tick(w, at(19, 7, 30)), []);
  updateAutomation(w, automation.id, { enabled: true }, at(19, 9));
  assert.deepEqual(tick(w, at(19, 9, 1)), [], "07:30 had passed when it was switched on");
  updateAutomation(w, automation.id, { schedule: { at: "08:00", days: EVERY_DAY } }, at(20, 9));
  assert.deepEqual(tick(w, at(20, 9, 1)), [], "08:00 had passed when it was moved there");
  assert.equal(tick(w, at(21, 8)).length, 1);
  updateAutomation(w, automation.id, { enabled: false }, at(21, 12));
  assert.deepEqual(tick(w, at(22, 8)), []);
  assert.deepEqual(kinds(w, "automation."), ["automation.created", "automation.toggled", "automation.updated", "automation.fired", "automation.toggled"]);
  assert.throws(() => updateAutomation(w, automation.id, { schedule: { at: "25:00", days: [1] } }), /HH:MM/);
  assert.throws(() => updateAutomation(w, automation.id, { schedule: { at: "08:00", days: [] } }), /weekdays/);
  assert.throws(() => updateAutomation(w, automation.id, { colour: "red" } as never), /Unknown field/);
});

test("run now: one run per request, outside the schedule", () => {
  const w = world();
  const automation = createAutomation(w, { name: "Brief", goal: "Brief me", schedule: { at: "07:30", days: EVERY_DAY } }, at(19, 8));
  const run = runAutomationNow(w, automation.id, "dev.r1", { profile: "automation", now: at(19, 10) });
  assert.equal(runAutomationNow(w, automation.id, "dev.r1", { profile: "automation", now: at(19, 10) }).id, run.id, "a retried click replays");
  assert.equal(tick(w, at(20, 7, 30)).length, 1, "the schedule is untouched");
  deleteAutomation(w, automation.id, at(20, 9));
  assert.deepEqual(listAutomations(w), []);
  assert.equal(listRuns(w).length, 2, "its runs stay");
});

const MIN = 60_000;
/** The home node's executor takes the queued run at `now`. */
const start = (w: World, now: number): Run => claimNextRun(w, "home", { now })!;
/** …and the engine fails it there (the model could not be reached), or it goes through. */
const fail = (w: World, now: number, error = "engine_failed"): Run => finishRun(w, start(w, now).id, "home", { status: "failed", error }, { now });
const succeed = (w: World, now: number): Run => finishRun(w, start(w, now).id, "home", { status: "completed", reply: "Done." }, { now });
const results = (w: World) => listNotices(w).filter((notice) => notice.kind === "run_result" && notice.payload.delivery === "inbox" && notice.state === "pending");

test("a firing that failed before doing anything is tried again after 2, 10 and 30 minutes, and told only when the last try fails", () => {
  const w = world();
  const automation = createAutomation(w, { name: "Brief", goal: "Brief me", schedule: { at: "07:30", days: EVERY_DAY } }, at(19, 6));
  const [first] = tick(w, at(19, 7, 30));
  const t0 = at(19, 7, 30) + 5_000;
  fail(w, t0);
  assert.deepEqual(results(w), [], "not told while another try is coming");
  let [view] = listAutomations(w, t0);
  assert.equal(view.lastRun?.retryAt, new Date(t0 + 2 * MIN).toISOString());

  assert.deepEqual(tick(w, t0 + 2 * MIN - 1_000), [], "not before its time");
  const [second] = tick(w, t0 + 2 * MIN);
  assert.notEqual(second.id, first.id, "a try again is a run of its own");
  assert.equal(second.conversationId, first.conversationId);
  assert.match(second.goal, /an earlier try did not go through/);
  assert.deepEqual(tick(w, t0 + 2 * MIN + 1_000), [], "one run per try");

  const t1 = t0 + 2 * MIN + 5_000;
  fail(w, t1);
  assert.deepEqual(tick(w, t1 + 10 * MIN - 1_000), []);
  assert.equal(tick(w, t1 + 10 * MIN).length, 1);
  const t2 = t1 + 10 * MIN + 5_000;
  fail(w, t2);
  assert.deepEqual(results(w), []);
  assert.equal(tick(w, t2 + 30 * MIN).length, 1);
  const t3 = t2 + 30 * MIN + 5_000;
  fail(w, t3);

  assert.equal(results(w).length, 1, "three tries again, then it is told, once");
  assert.equal(results(w)[0].payload.status, "failed");
  assert.equal(results(w)[0].payload.error, "engine_failed");
  [view] = listAutomations(w, t3);
  assert.equal(view.lastRun?.retryAt, undefined);
  assert.equal(view.lastRun?.tries, 4);
  assert.deepEqual(tick(w, t3 + 60 * MIN), [], "no fourth try again");
  assert.equal(listRuns(w).length, 4);
  assert.equal(tick(w, at(20, 7, 30)).length, 1, "the next slot fires as usual");
  assert.deepEqual(listEvents(w).events.filter((event) => event.kind === "automation.fired" && event.subject === `automation:${automation.id}`).map((event) => event.payload.retry ?? 0), [0, 1, 2, 3, 0]);
});

test("a try again that goes through is told like any result; the failures before it never are", () => {
  const w = world();
  createAutomation(w, { name: "Brief", goal: "Brief me", schedule: { at: "07:30", days: EVERY_DAY } }, at(19, 6));
  tick(w, at(19, 7, 30));
  fail(w, at(19, 7, 31));
  tick(w, at(19, 7, 33));
  succeed(w, at(19, 7, 34));
  assert.deepEqual(results(w).map((notice) => notice.payload.status), ["completed"]);
  assert.deepEqual(tick(w, at(19, 9)), []);
});

test("a firing that did something before it failed is never run again, and is told at once", () => {
  const w = world();
  createAutomation(w, { name: "Brief", goal: "Brief me", schedule: { at: "07:30", days: EVERY_DAY } }, at(19, 6));
  tick(w, at(19, 7, 30));
  const run = start(w, at(19, 7, 30));
  withCoreContext({ actor: "alfred", run: { id: run.id, owner: "home" } }, () => w.tx(() => recordDomainEvent(w, { kind: "toy.added", subject: "toy:ball", payload: {}, now: at(19, 7, 30) })));
  finishRun(w, run.id, "home", { status: "failed", error: "engine_failed" }, { now: at(19, 7, 30) + 30_000 });
  assert.equal(results(w).length, 1);
  assert.equal(listAutomations(w, at(19, 7, 31))[0].lastRun?.retryAt, undefined);
  assert.deepEqual(tick(w, at(19, 8, 30)), [], "running it again could do the same thing twice");
});

test("with no model to run with, another try cannot help: told at once, with the reason", () => {
  const w = world();
  createAutomation(w, { name: "Brief", goal: "Brief me", schedule: { at: "07:30", days: EVERY_DAY } }, at(19, 6));
  tick(w, at(19, 7, 30));
  fail(w, at(19, 7, 31), "engine_unavailable");
  assert.equal(results(w)[0]?.payload.error, "engine_unavailable");
  assert.deepEqual(tick(w, at(19, 8, 30)), []);
});

test("a new slot, a change to the rule, or switching it off ends the tries", () => {
  const w = world();
  const automation = createAutomation(w, { name: "Brief", goal: "Brief me", schedule: { at: "07:30", days: EVERY_DAY } }, at(19, 6));
  tick(w, at(19, 7, 30));
  fail(w, at(19, 7, 31));
  updateAutomation(w, automation.id, { goal: "Brief me, shorter" }, at(19, 7, 32));
  assert.equal(listAutomations(w, at(19, 7, 32))[0].lastRun?.retryAt, undefined);
  assert.deepEqual(tick(w, at(19, 7, 40)), [], "the rule was changed: its old words are not run again");

  const [next] = tick(w, at(20, 7, 30));
  fail(w, at(20, 7, 31));
  updateAutomation(w, automation.id, { enabled: false }, at(20, 7, 32));
  assert.deepEqual(tick(w, at(20, 7, 40)), [], "switched off");

  // The home node was off through the tries and the next slot: the new slot fires, not the old try.
  updateAutomation(w, automation.id, { enabled: true }, at(20, 12));
  tick(w, at(21, 7, 30));
  fail(w, at(21, 7, 31));
  const [later] = tick(w, at(22, 7, 30));
  assert.doesNotMatch(later.goal, /an earlier try/);
  assert.notEqual(later.id, next.id);
  assert.deepEqual(results(w), [], "none of these was told: the user's change, or the newer firing, is what matters");
});

test("a firing interrupted before it did anything is tried again without asking; the interrupted run is closed", () => {
  const w = world();
  createAutomation(w, { name: "Brief", goal: "Brief me", schedule: { at: "07:30", days: EVERY_DAY } }, at(19, 6));
  tick(w, at(19, 7, 30));
  const run = start(w, at(19, 7, 30));
  // The Mac slept: the executor's lease ran out.
  sweepRuns(w, { now: at(19, 7, 40) });
  assert.equal(getRun(w, run.id).run.state, "interrupted");
  assert.deepEqual(listNotices(w).filter((notice) => notice.kind === "run_interrupted"), [], "nobody is asked whether to continue");
  const [again] = tick(w, at(19, 7, 42));
  assert.ok(again);
  assert.equal(getRun(w, run.id).run.state, "cancelled", "not left to be continued beside the new try");
});

test("a held failure whose slot is by now too long ago is recorded as skipped and told after all, once", () => {
  const w = world();
  // Mondays only (the 23rd): nothing newer comes to take its place.
  createAutomation(w, { name: "Weekly", goal: "Go over my todos", schedule: { at: "07:30", days: [1] } }, at(19, 6));
  tick(w, at(23, 7, 30));
  fail(w, at(23, 7, 31));
  // Off until the next day.
  assert.deepEqual(tick(w, at(24, 9)), []);
  assert.equal(results(w).length, 1);
  assert.deepEqual(tick(w, at(24, 9, 1)), []);
  assert.equal(results(w).length, 1);
  assert.equal(listEvents(w).events.filter((event) => event.kind === "automation.skipped" && event.payload.reason === "retry_too_late").length, 1);
});

test("three firings in a row that fail are told as one notice; the ones after it are not told until one goes through", () => {
  const w = world();
  createAutomation(w, { name: "Brief", goal: "Brief me", schedule: { at: "07:30", days: EVERY_DAY } }, at(19, 6));
  const day = (d: number) => { tick(w, at(d, 7, 30)); fail(w, at(d, 7, 31), "engine_unavailable"); };
  day(19);
  day(20);
  assert.deepEqual(results(w).map((notice) => notice.payload.streak), [undefined, undefined]);
  day(21);
  assert.deepEqual(results(w).map((notice) => notice.payload.streak), [3], "one notice takes the place of the three");
  day(22);
  day(23);
  assert.equal(results(w).length, 1, "it has been said");
  tick(w, at(24, 7, 30));
  succeed(w, at(24, 7, 31));
  day(25);
  assert.deepEqual(results(w).map((notice) => [notice.payload.status, notice.payload.streak]), [["failed", 3], ["completed", undefined], ["failed", undefined]], "after one that went through, the count starts again");
});

test("the shipped automations are there from the start, off, in the user's language; deleted, one stays gone", () => {
  const w = world();
  ensureTemplates(w, at(19, 6));
  ensureTemplates(w, at(19, 6));
  const brief = listAutomations(w).find((automation) => automation.template === "brief")!;
  const mail = listAutomations(w).find((automation) => automation.template === "mail_todos")!;
  assert.equal(listAutomations(w).length, 2);
  assert.deepEqual([brief.template, brief.enabled, brief.schedule.at, brief.name], ["brief", false, "07:30", null]);
  assert.deepEqual([mail.enabled, mail.schedule.at, mail.name], [false, "09:00", null]);

  updateAutomation(w, brief.id, { enabled: true }, at(19, 6, 30));
  updateSettings(w, { locale: "zh" });
  const [run] = tick(w, at(19, 7, 30));
  assert.match(run.goal, /早报/);
  assert.equal(getConversation(w, run.conversationId).title, "早报");
  assert.equal(listEvents(w).events.find((event) => event.kind === "automation.created")?.actor, "system");

  deleteAutomation(w, brief.id);
  ensureTemplates(w);
  assert.deepEqual(listAutomations(w).map((automation) => automation.template), ["mail_todos"]);
  // Picking todos out of mail tells the run how: suggest, never follow what a mail says.
  updateAutomation(w, mail.id, { enabled: true }, at(19, 8));
  const [picking] = tick(w, at(19, 9));
  assert.match(picking.goal, /todo_suggest/);
  assert.equal(getConversation(w, picking.conversationId).title, "从邮件里挑待办");
});

test("an unattended run cannot stop to ask: external tools are refused and asking fails", async () => {
  const w = world();
  const seen: unknown[] = [];
  const engine: EnginePort = {
    async submit(request) {
      seen.push(await request.external.allow("Send an email?"));
      try { await request.tools[0].execute({}, new AbortController().signal); } catch (error) { seen.push((error as Error).message); }
      return { reply: "done" };
    },
  };
  const asking = { name: "ask_user", label: "Ask", description: "", parameters: { type: "object" }, execute: (_: unknown, __: unknown, context: { ask(request: { question: string }): Promise<string> }) => context.ask({ question: "Which?" }) };
  const profiles: Record<string, RunProfile> = { automation: { instructions: "", tools: [asking as never], unattended: true } };
  const automation = createAutomation(w, { name: "Brief", goal: "Brief me", schedule: { at: "07:30", days: EVERY_DAY } }, at(19, 6));
  runAutomationNow(w, automation.id, "dev.r1", { profile: "automation" });
  await createRunDrain(w, engine, { owner: "home", profiles }).kick();
  assert.equal(seen[0], "deny");
  assert.match(String(seen[1]), /unattended/);
  assert.equal(listRuns(w)[0].state, "completed");
});

test("a notice about an automation's run calls it by the automation's name", async () => {
  const w = world();
  ensureTemplates(w, at(19, 6));
  const brief = listAutomations(w).find((automation) => automation.template === "brief")!;
  runAutomationNow(w, brief.id, "dev.r1", { profile: "automation" });
  await createRunDrain(w, { submit: async () => ({ reply: "Two things today." }) }, { owner: "home", profiles: { automation: { instructions: "", tools: [], unattended: true } } }).kick();
  const notice = listNotices(w).find((candidate) => candidate.kind === "run_result")!;
  assert.equal(notice.payload.goal, "Morning brief");
  assert.equal(notice.payload.automationId, brief.id);
});

test("upgrading a world keeps its automations, devices and sessions as they were", () => {
  const dir = mkdtempSync(join(tmpdir(), "alfred-upgrade-"));
  const path = join(dir, "world.sqlite");
  // A world from before commands, device scopes and the second shipped automation (core:12).
  const before = openWorld(path, CORE_MIGRATIONS.filter((migration) => Number(migration.id.split(":")[1]) <= 12));
  oldAutomation(before, { id: "brief1", template: "brief", schedule: { at: "06:45", days: [1, 2, 3] }, enabled: true, at: at(19, 6) });
  oldAutomation(before, { id: "mine1", name: "Sweep", goal: "Look over my todos", schedule: { at: "08:00", days: [1] }, enabled: true, at: at(19, 6) });
  const brief = { id: "brief1", createdAt: new Date(at(19, 6)).toISOString() }, mine = { id: "mine1" };
  before.db.prepare("INSERT INTO core_devices (id, name, kind, token_hash, paired_at) VALUES ('d1', 'Phone', 'phone', ?, ?)").run("a".repeat(64), new Date().toISOString());
  before.close();

  const after = openWorld(path, CORE_MIGRATIONS);
  ensureTemplates(after, at(19, 7));
  const all = listAutomations(after);
  assert.deepEqual(all.map((automation) => automation.template ?? automation.name).sort(), ["Sweep", "brief", "mail_todos"]);
  const kept = all.find((automation) => automation.id === brief.id)!;
  assert.deepEqual([kept.enabled, kept.schedule, kept.createdAt], [true, { at: "06:45", days: [1, 2, 3] }, brief.createdAt]);
  assert.equal(all.find((automation) => automation.id === mine.id)!.goal, "Look over my todos");
  assert.deepEqual([kept.layout, kept.keep, kept.k], ["sections", "latest", "orange"], "the brief keeps how it behaved, now as its options");
  assert.deepEqual([all.find((automation) => automation.template === "mail_todos")!.notify, all.find((automation) => automation.id === mine.id)!.layout], ["changes", "text"]);
  assert.deepEqual(listDevices(after).map((device) => [device.name, device.scopes, device.devAccessRequested]), [["Phone", [], false]]);
  after.close();
});
