import assert from "node:assert/strict";
import { test } from "node:test";
import type { CalendarEvent, CalendarSnapshot } from "@alfred/module-calendar/types";
import type { MailMessage, MailSnapshot } from "@alfred/module-mail/types";
import type { Todo, TodoSnapshot } from "@alfred/module-todo/types";
import { PROTOCOL_VERSION, type Conversation, type Proposal, type Run, type StateResponse } from "@alfred/protocol";
import { setLocale } from "../src/i18n/dict.ts";
import { todayModel, todaySummary, untilText } from "../src/shell/today.ts";

// Friday 20 November 2026, on whatever clock the test runs on: every instant below is made from local hours.
const DAY = "2026-11-20";
const at = (hour: number, minute = 0, day = 20) => new Date(2026, 10, day, hour, minute).getTime();
const iso = (hour: number, minute = 0, day = 20) => new Date(at(hour, minute, day)).toISOString();

const event = (id: string, title: string, from: number, to: number, more: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id, account: "me@example.com", calendarId: "primary", calendar: "Me", title, allDay: false, startDate: DAY, endDate: DAY,
  start: iso(from), end: iso(to), attendees: 0, k: "blue", editable: true, invited: false, ...more,
});
const todo = (id: string, title: string, more: Partial<Todo> = {}): TodoSnapshot["todos"][number] => ({ id, title, done: false, createdAt: iso(7, 0, 18), revision: "1", ...more });
const letter = (id: string, hour: number, more: Partial<MailMessage> = {}): MailMessage => ({
  id, account: "me@example.com", threadId: id, from: "Leo", fromEmail: "leo@example.com", subject: `Letter ${id}`, snippet: "", receivedAt: iso(hour),
  unread: true, important: false, starred: false, category: "primary", link: "https://mail.example/" + id, ...more,
});
const conversation = (id: string, more: Partial<Conversation> = {}): Conversation => ({
  id, title: `Conversation ${id}`, createdAt: iso(7), updatedAt: iso(8), archivedAt: null, model: null, thinking: null, busy: 0, attention: 0,
  lastGoal: null, projectId: null, mode: null, base: null, ...more,
});
const run = (id: string, conversationId: string, more: Partial<Run> = {}): Run => ({
  id, requestId: id, conversationId, goal: `Goal ${id}`, profile: "everyday", state: "running", createdAt: iso(8), updatedAt: iso(8), attempt: 1,
  leaseOwner: null, leaseUntil: null, cancelRequested: false, outcome: null, request: null, context: null, automationId: null, ...more,
});

function state(more: { events?: CalendarEvent[]; todos?: TodoSnapshot["todos"]; mail?: MailMessage[] } & Partial<StateResponse> = {}): StateResponse {
  const { events, todos, mail, ...rest } = more;
  const source = { account: "me@example.com", syncedAt: iso(8), error: null, reconnect: false };
  const calendar: CalendarSnapshot | undefined = events && ({ today: DAY, from: "2026-10-25", to: "2026-12-31", events, pending: [],
    sources: [{ ...source, canWrite: false, calendars: [] }] } as CalendarSnapshot);
  const mailbox: MailSnapshot | undefined = mail && { messages: mail, sent: [], sources: [{ ...source, canRead: true, canSend: false }] };
  return {
    protocol: PROTOCOL_VERSION, cursor: 0, conversations: [], runs: [], receipts: {}, notices: [], views: {}, proposals: [], automations: [], projects: [],
    areas: [{ id: "learn", name: { zh: "学习", en: "Learning" }, k: "violet" }], settings: { locale: "en", preferredName: null, model: null, thinking: null },
    modules: { ...(calendar ? { calendar } : {}), ...(todos ? { todo: { today: DAY, todos } } : {}), ...(mailbox ? { mail: mailbox } : {}) },
    ...rest,
  } as StateResponse;
}

test("the next thing is the first event still ahead today; one going on is said first", () => {
  setLocale("en");
  const day = state({ events: [event("b", "Class", 14, 15), event("a", "Group meeting", 10, 11, { meeting: "https://meet.example/x" }), event("no", "Declined", 9, 10, { response: "declined" })] });
  const morning = todayModel(day, at(8, 10));
  assert.equal(morning.part, "morning");
  assert.equal(morning.current, undefined);
  assert.equal(morning.next?.event.title, "Group meeting");
  assert.equal(morning.next?.at, "10:00");
  assert.equal(untilText(morning.next!.startMs - at(8, 10)), "1h 50m");
  assert.equal(todaySummary(day, at(8, 10)), "Next: Group meeting at 10:00");

  const during = todayModel(day, at(10, 30));
  assert.equal(during.current?.event.title, "Group meeting");
  assert.equal(during.next?.event.title, "Class");
  assert.deepEqual(during.rows.map((row) => [row.kind === "event" && row.event.title, row.past, row.kind === "event" && row.now]), [["Group meeting", false, true], ["Class", false, false]]);
  assert.equal(todaySummary(day, at(10, 30)), "Now: Group meeting");
  assert.ok(!morning.rows.some((row) => row.kind === "event" && row.event.title === "Declined"), "an invitation turned down is not on the day");
});

test("when today has nothing left, tomorrow's first event is named", () => {
  setLocale("en");
  const day = state({ events: [event("a", "Group meeting", 10, 11), event("t", "Discussion", 9, 10, { startDate: "2026-11-21", endDate: "2026-11-21", start: iso(9, 0, 21), end: iso(10, 0, 21) })] });
  const evening = todayModel(day, at(21, 5));
  assert.equal(evening.part, "evening");
  assert.equal(evening.next, undefined);
  assert.equal(evening.tomorrow?.event.title, "Discussion");
  assert.deepEqual(evening.rows.map((row) => row.past), [true]);
  assert.equal(todaySummary(day, at(21, 5)), "Nothing else is on today");
  assert.equal(todayModel(state(), at(9)).calendar, "none", "no calendar connected: said, not shown as a free day");
});

test("todos due at an hour sit on the day's line; those for today without one are listed after it", () => {
  const day = state({
    events: [event("a", "Group meeting", 10, 11), event("h", "Holiday", 0, 0, { allDay: true, start: undefined, end: undefined })],
    todos: [
      todo("1", "Hand in homework", { due: DAY, at: "12:00", area: "learn" }),
      todo("2", "Call home", { due: DAY }),
      todo("3", "Planned for today", { plannedOn: DAY, due: "2026-11-25" }),
      todo("4", "Overdue", { due: "2026-11-18" }),
      todo("5", "Done already", { due: DAY, done: true }),
      todo("6", "Only suggested", { due: DAY, suggested: true }),
      todo("7", "Mirrors an event", { due: DAY, source: { kind: "calendar", ref: "calendar:x", label: "Me" } }),
      todo("8", "Next week", { due: "2026-11-27" }),
    ],
  });
  const model = todayModel(day, at(8, 10));
  assert.deepEqual(model.rows.map((row) => (row.kind === "event" ? row.event.title : `${row.at} ${row.todo.title}`)), ["Group meeting", "12:00 Hand in homework"]);
  const due = model.rows[1];
  assert.ok(due.kind === "todo" && due.k === "violet" && !due.past);
  assert.deepEqual(model.loose.map(({ todo }) => todo.title), ["Call home", "Planned for today"]);
  assert.equal(model.late, 1);
  assert.deepEqual(model.allDay.map((item) => item.title), ["Holiday"]);
  const after = todayModel(day, at(13));
  assert.ok(after.rows[1].kind === "todo" && after.rows[1].past, "its hour has gone by and it is still open");
});

test("what waits is counted, and a task stuck on an answer comes before a proposal", () => {
  setLocale("en");
  const proposal = { id: "p1", title: "Clear two overdue todos?", summary: "", createdAt: iso(7), expiresAt: iso(7, 0, 26), conversationId: "c1", runId: "r0", steps: [], stale: false, state: "open" } as unknown as Proposal;
  const asking = run("r1", "c1", { state: "waiting_input", request: { id: "q", kind: "input", question: "Which train?", createdAt: iso(8) } as Run["request"] });
  const day = state({ events: [event("a", "Group meeting", 10, 11)], proposals: [proposal], runs: [asking, run("r2", "c2")], conversations: [conversation("c1"), conversation("c2", { title: "Sort invoices" })] });
  const model = todayModel(day, at(8, 10));
  assert.equal(model.waiting.count, 2);
  assert.deepEqual(model.waiting.top.map((item) => item.id), ["r:r1", "p:p1"]);
  assert.equal(todaySummary(day, at(8, 10)), "Next: Group meeting at 10:00 · 2 waiting on you");
  assert.deepEqual(model.doing.map((item) => [item.title, item.sub]), [["Sort invoices", "Goal r2"]], "a run waiting on the user is under what waits, not under in progress");
});

test("mail says how many letters came today and lists the unread ones, important first", () => {
  const day = state({ mail: [
    letter("old", 9, { receivedAt: iso(9, 0, 19) }), letter("read", 7, { unread: false }), letter("promo", 7, { category: "promotions" }),
    letter("plain", 8), letter("key", 6, { important: true }),
  ] });
  const model = todayModel(day, at(8, 10));
  assert.equal(model.mail.state, "ok");
  assert.equal(model.mail.today, 4);
  assert.equal(model.mail.unread, 2);
  assert.deepEqual(model.mail.rows.map((message) => message.id), ["key", "plain"]);
  assert.equal(todayModel(state(), at(8)).mail.state, "none");
});

test("just finished: replies not yet read, a development session marked as one", () => {
  const day = state({ conversations: [
    conversation("c1", { title: "Broadband compared", unreadReplyId: "x", lastGoal: "Compare three plans", updatedAt: iso(7, 30) }),
    conversation("c2", { title: "Add search", unreadReplyId: "y", projectId: "p", updatedAt: iso(7, 41) }),
    conversation("c3", { title: "Read already" }),
  ] });
  const model = todayModel(day, at(8, 10));
  assert.deepEqual(model.done.map((item) => [item.title, item.sub, item.session, item.conversationId]), [["Add search", "", true, "c2"], ["Broadband compared", "Compare three plans", false, "c1"]]);
});
