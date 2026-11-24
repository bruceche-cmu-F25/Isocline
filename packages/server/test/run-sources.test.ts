import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claimNextRun, CORE_MIGRATIONS, createAutomation, deleteAutomation, finishRun, openWorld, runAutomationNow } from "@isocline/core";
import { readSources } from "../src/source-reads.ts";
import { sourcesToday, runSources } from "../src/run-sources.ts";

const date = "2026-11-20", timezone = "America/Los_Angeles";
test("brief sources use the edition day, keep actual due tasks and opened mail, and distinguish unreadable from empty", () => {
  const day = (text: string) => ({ name: "calendar_list", args: {}, text });
  const tasks = (lines: string[]) => ({ name: "todo_list", args: {}, text: `Today is ${date} (user's local date).\n${lines.join("\n")}` });
  const mail = { name: "mail_read", args: { id: "msg" }, text: "From: Example <a@example.test>\nTo: B\nDate: today\nSubject: FYI\n\nprivate body" };
  const learn = { id: "learn", name: "Learning", k: "violet" as const, sample: true };
  const result = readSources(date, timezone, [
    day("Thu 2026-11-19\n  10:00–11:30 Yesterday [past]\nFri 2026-11-20\n  …–01:00 Continuing [a]\n  all day Event (fall) [b]\nSat 2026-11-21: nothing"),
    tasks(["[ ] task7  Homework (part A) [area: learn] (due today) (by 12:00)", "[ ] old  Call (in progress) (overdue, was due 2026-11-17)",
      "[ ] range  Read (2026-11-18 – 2026-11-20)", "[ ] done-soon  Later (due tomorrow)", "[x] past  Done (was due 2026-11-16)",
      "[ ] maybe  Proposed (due today) (your suggestion; the user has not kept it yet)", "[ ] track  Open-ended (planned 2026-11-20, not a deadline)"]),
    mail, mail, { name: "mail_read", args: { id: "other" }, text: "No such message" },
  ], [learn]);
  assert.deepEqual(result, {
    date, timezone,
    calendar: [{ id: "a", title: "Continuing", allDay: false, start: null, end: "01:00" }, { id: "b", title: "Event (fall)", allDay: true, start: null, end: null }],
    todos: [{ id: "task7", title: "Homework (part A)", due: date, at: "12:00", overdue: false, area: learn },
      { id: "old", title: "Call", due: "2026-11-17", overdue: true }, { id: "range", title: "Read", due: date, overdue: false }],
    mail: [{ id: "msg", from: "Example <a@example.test>", subject: "FYI" }],
  });
  assert.deepEqual(readSources(date, timezone, [day("Fri 2026-11-20: nothing"), tasks(["No open todos."]), { name: "mail_list", args: {}, text: "No mail matches." }]),
    { date, timezone, calendar: [], todos: [], mail: [] });
  assert.deepEqual(readSources(date, timezone, [day("Fri 2026-11-20: nothing\nCould not read a@example.test just now (offline); this may be out of date."),
    tasks(["Unknown format"]), { name: "mail_list", args: {}, text: "The user's mail is not connected." }]), { date, timezone, calendar: null, todos: null, mail: null });
});

test("a completed automation run reads only its actual transcript branch, prompt, tool calls and final reply, also after its rule is deleted", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "alfred-brief-sources-"));
  const world = openWorld(join(dir, "world.sqlite"), CORE_MIGRATIONS);
  t.after(() => world.close());
  const time = (ms: number) => Date.parse("2026-11-20T15:30:00.000Z") + ms;
  const stamp = (ms: number) => new Date(time(ms)).toISOString();
  const schedule = { at: "07:30", days: [5] };
  const rule = createAutomation(world, { template: "brief", schedule }, time(0));
  const run = runAutomationNow(world, rule.id, "once", { profile: "automation", now: time(10) });
  claimNextRun(world, "worker", { now: time(15) });
  const done = finishRun(world, run.id, "worker", { status: "completed", reply: "Today's report" }, { now: time(120) });
  const folder = join(dir, "engine", "sessions", run.conversationId);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "session.jsonl");
  const rec = (id: string, parentId: string, ms: number, message: unknown) => ({ type: "message", id, parentId, timestamp: stamp(ms), message });
  const text = (value: string) => [{ type: "text", text: value }];
  const prompt = (zone: string) => ({ role: "user", content: text(`Earlier context\n\n---\n\nToday is ${date} (Friday), timezone ${zone}.\n\n${run.goal}`) });
  const tool = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: {} });
  const returned = (id: string, name: string, value: string) => ({ role: "toolResult", toolName: name, toolCallId: id, content: text(value) });
  const assistant = (value: string) => ({ role: "assistant", content: text(value) });
  const transcript = [
    rec("previous", "", 0, prompt("UTC")), rec("previous-end", "previous", 9, assistant("Today's report")),
    rec("user", "previous-end", 20, prompt(timezone)),
    rec("calls", "user", 30, { role: "assistant", content: [tool("c", "calendar_list"), tool("t", "todo_list")] }),
    rec("calendar", "calls", 40, returned("c", "calendar_list", "Fri 2026-11-20\n  09:00–10:00 Original title [immutable]")),
    rec("side", "calendar", 48, returned("t", "todo_list", `Today is ${date} (user's local date).\n[ ] fake  Other branch (due today)`)),
    rec("mismatch", "calendar", 54, returned("unmatched", "todo_list", `Today is ${date} (user's local date).\nNo open todos.`)),
    rec("end", "mismatch", 110, assistant("Today's report")),
    rec("tomorrow", "end", 1000, prompt("UTC")), rec("tomorrow-end", "tomorrow", 1200, assistant("Today's report")),
  ];
  writeFileSync(file, transcript.map((row) => JSON.stringify(row)).join("\n"));
  const expected = { date, timezone, calendar: [{ id: "immutable", title: "Original title", start: "09:00", end: "10:00", allDay: false }], todos: null, mail: null };
  assert.deepEqual(await runSources(world, done), expected);
  const custom = createAutomation(world, { name: "Morning brief", goal: run.goal, schedule }, time(500));
  assert.deepEqual(await runSources(world, { ...done, automationId: custom.id }), expected, "any automation's run has its sources, not only the sample's");
  assert.equal(await runSources(world, { ...done, outcome: { ...done.outcome!, reply: "Something else" } }), null);
  deleteAutomation(world, rule.id, time(500));
  assert.deepEqual(await runSources(world, done), expected);
  renameSync(file, file + ".removed");
  assert.equal(await runSources(world, done), null);
});

test("today's colours and mail keys are added beside the record, only for what still exists", () => {
  const record = {
    date, timezone, todos: null,
    calendar: [{ id: "kept", title: "Lecture", start: "09:00", end: "10:00", allDay: false }, { id: "gone", title: "Cancelled", start: null, end: null, allDay: true }],
    mail: [{ id: "opened", from: "Example <a@example.test>", subject: "Sign-in" }],
  };
  const reply = "## Mail\n- [Risk] Check the sign-in (mail:opened)\n- [等你] 回复邀请（邮件：listed）\n- [FYI] Old notice (mail:deleted)";
  const now = {
    events: [{ id: "kept", k: "violet" }, { id: "other", k: "blue" }],
    messages: [{ id: "opened", account: "a@example.test", from: "Example", subject: "Sign-in" }, { id: "listed", account: "a@example.test", from: "Lin", subject: "Moved" },
      { id: "unrelated", account: "a@example.test", from: "Shop", subject: "Sale" }],
  };
  assert.deepEqual(sourcesToday(record, reply, now), {
    ...record,
    calendar: [{ ...record.calendar[0], k: "violet" }, record.calendar[1]],
    cited: [{ id: "opened", from: "Example", subject: "Sign-in", key: "a@example.test|opened" }, { id: "listed", from: "Lin", subject: "Moved", key: "a@example.test|listed" }],
  });
  assert.deepEqual(sourcesToday({ ...record, calendar: null, mail: null }, "No ids here.", {}), { ...record, calendar: null, mail: null });
});
