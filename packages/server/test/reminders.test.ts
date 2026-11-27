import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_MIGRATIONS, listNotices, openWorld, updateSettings, type World } from "@zirma/core";
import { calendarModule } from "@zirma/module-calendar";
import { mailModule } from "@zirma/module-mail";
import { addTodo, todoModule } from "@zirma/module-todo";
import { nextLookIn, remindNow } from "../src/reminders.ts";

const MIN = 60_000;
const modules = [calendarModule, todoModule, mailModule];
const world = (): World => openWorld(":memory:", [...CORE_MIGRATIONS, ...modules.flatMap((module) => module.migrations ?? [])]);
const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (time: number) => { const d = new Date(time); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const localHour = (time: number) => { const d = new Date(time); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

test("a todo due within the hour becomes one reminder, from the modules' own snapshots", () => {
  const w = world();
  const now = Date.now();
  // Due at the next whole minute 40 minutes on (todo hours have no seconds).
  const due = Math.ceil((now + 40 * MIN) / MIN) * MIN;
  addTodo(w, { title: "Hand in essay", due: localDate(due), at: localHour(due) });
  addTodo(w, { title: "No hour", due: localDate(due) });
  const first = remindNow(w, modules, now);
  assert.equal(first.told, 1);
  const [notice] = listNotices(w, { now });
  assert.equal(notice.kind, "reminder");
  assert.equal((notice.payload.items as Array<{ title: string }>)[0].title, "Hand in essay");
  assert.equal(remindNow(w, modules, now + MIN).told, 0, "told once");
});

test("turned off, nothing is told", () => {
  const w = world();
  const now = Date.now();
  const due = Math.ceil((now + 30 * MIN) / MIN) * MIN;
  updateSettings(w, { reminders: { todos: { on: false } } });
  addTodo(w, { title: "Hand in essay", due: localDate(due), at: localHour(due) });
  assert.equal(remindNow(w, modules, now).told, 0);
});

test("on a phone a reminder says what and when, and opens the thing's page", async () => {
  const { noticeMessage } = await import("../src/index.ts");
  const start = new Date(Date.now() + 10 * MIN + 20_000).toISOString();
  const event = { id: "n1", kind: "reminder", payload: { keys: ["event:e@x"], items: [{ source: "event", id: "c:e", title: "组会", at: start, meeting: true }] } };
  const zh = noticeMessage(event, "zh");
  assert.equal(zh.title, "10 分钟后：组会");
  assert.equal(zh.body, "有视频会议");
  assert.equal(zh.url, "/#p=calendar.week");
  assert.equal(zh.ack, true);
  assert.equal(noticeMessage(event, "en").title, "In 10 min: 组会");
  const mail = { id: "n2", kind: "reminder", payload: { keys: ["mail:m"], items: [{ source: "mail", id: "m", account: "me@example.com", title: "Draft", from: "Lee", at: new Date().toISOString() }] } };
  const said = noticeMessage(mail, "en");
  assert.equal(said.title, "Mail from Lee");
  assert.equal(said.body, "Draft");
  assert.equal(said.url, `/#p=mail.inbox&item=${encodeURIComponent("me@example.com|m")}`);
  const two = { id: "n3", kind: "reminder", payload: { keys: ["todo:a", "todo:b"], items: [
    { source: "todo", id: "a", title: "Essay", at: new Date(Date.now() + 60 * MIN + 20_000).toISOString() },
    { source: "todo", id: "b", title: "Form", at: new Date(Date.now() + 60 * MIN + 20_000).toISOString() },
  ] } };
  assert.equal(noticeMessage(two, "en").title, "Due in 1 hr: Essay, and 1 more");
});

test("the next look waits at most a minute: a thing months away does not set off a timer at once", () => {
  const now = Date.now();
  assert.equal(nextLookIn(null, now), null);
  assert.equal(nextLookIn(now + 20_000, now), 20_000);
  assert.equal(nextLookIn(now - 5, now), 0);
  assert.equal(nextLookIn(now + 40 * 24 * 60 * MIN, now), null);
});
