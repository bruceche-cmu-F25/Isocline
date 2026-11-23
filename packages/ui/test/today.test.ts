import assert from "node:assert/strict";
import { test } from "node:test";
import type { CalendarEvent, CalendarSnapshot } from "@alfred/module-calendar/types";
import type { MailMessage, MailSnapshot } from "@alfred/module-mail/types";
import type { Todo, TodoSnapshot } from "@alfred/module-todo/types";
import { PROTOCOL_VERSION, type Conversation, type Proposal, type Run, type StateResponse } from "@alfred/protocol";
import { setLocale } from "../src/i18n/dict.ts";
import { machineMail, todayFocus, todayLine, todayModel, todaySummary, untilText } from "../src/shell/today.ts";

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
    areas: [{ id: "learn", name: { zh: "学习", en: "Learning" }, k: "violet" }], settings: { locale: "en", preferredName: null, model: null, thinking: null, firstRunAt: null },
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
  assert.equal(todaySummary(day, at(8, 10)), "2 events today", "the top bar counts the day; the page's first sentence says what is next");

  const during = todayModel(day, at(10, 30));
  assert.equal(during.current?.event.title, "Group meeting");
  assert.equal(during.next?.event.title, "Class");
  assert.deepEqual(during.rows.map((row) => [row.kind === "event" && row.event.title, row.past, row.kind === "event" && row.now]), [["Group meeting", false, true], ["Class", false, false]]);
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
  assert.equal(todaySummary(day, at(21, 5)), "1 event today");
  assert.equal(todayModel(state(), at(9)).calendar, "none", "no calendar connected: said, not shown as a free day");
});

test("in the evening, once nothing with an hour is left, the page turns to tomorrow and keeps what is still open today", () => {
  setLocale("en");
  const tomorrow = { startDate: "2026-11-21", endDate: "2026-11-21", start: iso(10, 0, 21), end: iso(11, 0, 21) };
  const events = [event("a", "Group meeting", 10, 11), event("b", "Outing", 17, 19), event("t", "Practice", 0, 0, tomorrow)];
  const todos = [todo("1", "Hand in homework", { due: DAY, at: "12:00" }), todo("2", "Call home", { due: DAY }), todo("3", "Pack", { due: "2026-11-21" }), todo("4", "Send form", { due: "2026-11-21", at: "09:00" })];
  const evening = todayModel(state({ events, todos }), at(20, 24));
  assert.equal(evening.turned, true);
  assert.equal(evening.passed, 2);
  assert.deepEqual(evening.unfinished.map(({ todo, at }) => [todo.title, at]), [["Hand in homework", "12:00"], ["Call home", undefined]]);
  assert.deepEqual(evening.ahead.rows.map((row) => (row.kind === "event" ? row.event.title : `${row.at} ${row.todo.title}`)), ["09:00 Send form", "Practice"]);
  assert.deepEqual(evening.ahead.loose.map(({ todo }) => todo.title), ["Pack"]);
  assert.ok(evening.ahead.rows.every((row) => !row.past));
  assert.equal(todaySummary(state({ events, todos }), at(20, 24)), "2 events today · 2 todos");

  assert.equal(todayModel(state({ events, todos }), at(16)).turned, false, "an afternoon with an event still ahead stays on today");
  assert.equal(todayModel(state({ events: [events[0]], todos }), at(15)).turned, false, "an afternoon with nothing left is not an evening yet");
  const dueTonight = [...todos, todo("5", "Submit by ten", { due: DAY, at: "22:00" })];
  assert.equal(todayModel(state({ events, todos: dueTonight }), at(20, 24)).turned, false, "a todo due at an hour still to come keeps the evening on today");
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
  assert.equal(todaySummary(day, at(8, 10)), "1 event today · 2 waiting on you");
  assert.deepEqual(model.doing.map((item) => [item.title, item.sub]), [["Sort invoices", "Goal r2"]], "a run waiting on the user is under what waits, not under in progress");

  const again = todayModel({ ...day, proposals: [proposal, { ...proposal, id: "p2", createdAt: iso(7, 30) }] }, at(8, 10));
  assert.equal(again.waiting.count, 3, "the count is everything that waits");
  assert.equal(again.waiting.top.filter((item) => item.title === "Clear two overdue todos?").length, 1, "the same thing proposed twice is one row");
  assert.equal(todayLine(again).moreWaiting, 1);
});

test("a decision leads until the next event is 15 minutes away, including with no calendar connected", () => {
  const asking = run("r", "c", { state: "waiting_input", request: { id: "q", kind: "input", question: "Which train?", createdAt: iso(8) } as Run["request"] });
  const day = state({ events: [event("e", "Review", 11, 12)], runs: [asking] });
  assert.equal(todayFocus(todayModel(day, at(10, 44))).kind, "decision");
  for (const now of [at(10, 45), at(11, 10)]) {
    const focus = todayFocus(todayModel(day, now));
    assert.ok(focus.kind === "event" && focus.imminent && focus.event.event.id === "e");
  }
  const free = todayFocus(todayModel({ ...day, runs: [] }, at(9)));
  assert.ok(free.kind === "event" && !free.imminent);
  const unconnected = todayFocus(todayModel(state({ runs: [asking] }), at(9)));
  assert.ok(unconnected.kind === "decision" && unconnected.item.id === "r:r");
  assert.equal(todayFocus(todayModel(state(), at(9))).kind, "summary");
});

test("mail says how many letters came today and lists the unread ones, important first", () => {
  const day = state({ mail: [
    letter("old", 9, { receivedAt: iso(9, 0, 19) }), letter("read", 7, { unread: false }), letter("promo", 7, { category: "promotions" }),
    letter("plain", 8), letter("key", 6, { important: true }), letter("archived", 7, { inInbox: false, starred: true }),
  ] });
  const model = todayModel(day, at(8, 10));
  assert.equal(model.mail.state, "ok");
  assert.equal(model.mail.today, 4);
  assert.equal(model.mail.unread, 2);
  assert.deepEqual(model.mail.rows.map((message) => message.id), ["key", "plain"]);
  assert.equal(model.mail.machine, 0);

  // A code, a sign-in notice and a no-reply sender are counted, not listed: nobody answers them.
  const noisy = todayModel(state({ mail: [
    letter("code", 8, { from: "Cursor", fromEmail: "hi@cursor.example", subject: "Sign in to Cursor", snippet: "Your one-time code is 790140. This code expires in 10 minutes." }),
    letter("device", 8, { from: "Cursor", fromEmail: "hi@cursor.example", subject: "Unrecognized Device Detected", snippet: "Cursor detected an authentication attempt" }),
    letter("robot", 8, { fromEmail: "no-reply@shop.example", subject: "Your order" }),
    letter("zh", 8, { fromEmail: "service@bank.example", subject: "您的验证码" }),
    letter("person", 7, { subject: "Can we sign the contract Friday?" }),
  ] }), at(9));
  assert.equal(noisy.mail.unread, 5);
  assert.deepEqual(noisy.mail.rows.map((message) => message.id), ["person"]);
  assert.equal(noisy.mail.machine, 4);
  assert.equal(machineMail({ fromEmail: "leo@example.com", subject: "Re: sign off on the plan", snippet: "Could you sign it and send it back?" }), false, "a person writing about signing is still a person");
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

test("the line: what is over folds away, what waits sits at now, then the day in order, then what has no hour, then tomorrow", () => {
  setLocale("en");
  const proposal = { id: "p1", runId: "r9", conversationId: "c9", state: "pending", title: "Reply to Leo", summary: "", createdAt: iso(8), actions: [] } as unknown as Proposal;
  const day = state({
    events: [
      event("a", "Standup", 9, 10), event("b", "Group meeting", 10, 11), event("c", "Class", 14, 15),
      event("d", "Conference", 0, 0, { allDay: true, start: undefined, end: undefined }),
      event("e", "Dentist", 16, 17, { startDate: "2026-11-21", endDate: "2026-11-21", start: iso(16, 0, 21), end: iso(17, 0, 21) }),
    ],
    todos: [todo("late", "Send the form", { due: DAY, at: "09:30" }), todo("timed", "Call the bank", { due: DAY, at: "15:00" }), todo("loose", "Renew passport", { due: DAY }), todo("next", "Pack", { due: "2026-11-21" })],
    mail: [letter("m1", 8, { important: true }), letter("m2", 8), letter("m3", 8, { important: true, fromEmail: "no-reply@bank.example" })],
    proposals: [proposal],
  });
  const line = todayLine(todayModel(day, at(10, 30)));
  const said = (rows: typeof line.past) => rows.map((row) => (row.kind === "event" ? row.event.title : row.kind === "todo" ? row.todo.title : row.kind === "mail" ? row.message.id : row.item.title));
  assert.deepEqual(said(line.past), ["Standup"], "only an event that has ended is over");
  assert.deepEqual(said(line.wait), ["Reply to Leo"]);
  assert.equal(line.moreWaiting, 0);
  assert.deepEqual(said(line.ahead), ["Conference", "Send the form", "Group meeting", "Renew passport", "Class", "Call the bank"], "the whole-day event first; a todo past its hour stays, marked late");
  assert.deepEqual(line.ahead.map((row) => (row.kind === "todo" ? row.late : row.kind === "event" && row.now)), [false, true, true, false, false, false]);
  const passport = line.ahead[3];
  assert.deepEqual(passport.kind === "todo" && [passport.guess, passport.after, passport.at], ["11:00", "Group meeting", undefined], "a todo with no hour is offered the first free half hour; its own hour is not set");
  assert.deepEqual(said(line.within), ["m1"], "letters: unread, important, written by a person");
  assert.deepEqual(said(line.tomorrow), ["Dentist", "Pack"]);
  assert.equal(line.moreTomorrow, 0);
  const all = [...line.past, ...line.wait, ...line.ahead, ...line.within, ...line.tomorrow];
  assert.equal(new Set(all.map((row) => row.key)).size, all.length, "every row has its own key");
});

test("the line shows tomorrow's first few rows by day, and all of them once the evening has turned to tomorrow", () => {
  const tomorrow = (id: string, hour: number) => event(id, `T${id}`, hour, hour + 1, { startDate: "2026-11-21", endDate: "2026-11-21", start: iso(hour, 0, 21), end: iso(hour + 1, 0, 21) });
  const day = state({ events: [event("a", "Standup", 9, 10), tomorrow("1", 9), tomorrow("2", 10), tomorrow("3", 11), tomorrow("4", 12), tomorrow("5", 13)] });
  const noon = todayLine(todayModel(day, at(12)));
  assert.equal(noon.tomorrow.length, 3);
  assert.equal(noon.moreTomorrow, 2);
  const night = todayLine(todayModel(day, at(21)));
  assert.equal(night.tomorrow.length, 5);
  assert.equal(night.moreTomorrow, 0);
});

test("the line says once what runs over today and tomorrow; in the evening what covered only today is over", () => {
  const whole = (id: string, title: string, from: number, to: number) => event(id, title, 0, 0, { allDay: true, start: undefined, end: undefined, startDate: `2026-11-${from}`, endDate: `2026-11-${to}` });
  const day = state({ events: [event("a", "Standup", 9, 10), whole("trip", "Conference", 20, 22), whole("habit1", "Watch a lecture", 20, 20), whole("habit2", "Watch a lecture", 21, 21)] });
  const titles = (rows: ReturnType<typeof todayLine>["past"]) => rows.map((row) => (row.kind === "event" ? row.event.title : ""));

  const noon = todayLine(todayModel(day, at(12)));
  assert.deepEqual(titles(noon.ahead), ["Conference", "Watch a lecture"]);
  assert.equal(noon.ahead[0].kind === "event" && noon.ahead[0].through, "2026-11-22", "it says how long it runs");
  assert.deepEqual(titles(noon.tomorrow), ["Watch a lecture"], "tomorrow's own event is there; the one already said under today is not said again");

  const night = todayLine(todayModel(day, at(23, 30)));
  assert.deepEqual(titles(night.ahead), [], "nothing of today is still to come");
  assert.deepEqual(titles(night.past), ["Watch a lecture", "Standup"], "what covered only today is over with it");
  assert.deepEqual(titles(night.tomorrow), ["Conference", "Watch a lecture"]);
});

test("suggested hours: the first free half hours from now, three at most, none in the evening's turn; a todo named like an event takes that event's hour", () => {
  const todos = ["A", "B", "C", "D"].map((title) => todo(title, title, { due: DAY }));
  const day = state({ events: [event("m", "Meeting", 10, 12), event("w", "Write report", 15, 16, { meeting: "https://meet.example/w" })], todos: [...todos, todo("r", "write report ", { due: DAY })] });
  const line = todayLine(todayModel(day, at(9, 55)));
  const hours = (rows: typeof line.ahead) => rows.map((row) => (row.kind === "todo" ? `${row.todo.title.trim()} ${row.guess ?? row.at ?? "-"}${row.block ? " block" : ""}` : row.kind === "event" ? `${row.event.title} ${row.at}` : ""));
  assert.deepEqual(hours(line.ahead), ["Meeting 10:00", "A 12:00", "B 12:30", "C 13:00", "write report 15:00 block"], "nothing is offered inside the meeting; the event that is a todo's hour is drawn as that todo");
  assert.deepEqual(hours(line.within), ["D -"], "beyond three, a todo keeps no hour");
  assert.equal(line.ahead[1].kind === "todo" && line.ahead[1].after, "Meeting");

  const late = todayLine(todayModel(day, at(20, 45)));
  assert.deepEqual(hours(late.ahead), [], "after nine in the evening there is no half hour left to offer");
  const night = todayLine(todayModel(state({ events: [event("m", "Meeting", 10, 12)], todos }), at(19)));
  assert.equal(night.ahead.some((row) => row.kind === "todo" && !!row.guess), false, "once the page has turned to tomorrow nothing is offered for today");
});

test("to read: links filed under any of the user's topics and not yet looked at are on the line, with the topic's name", () => {
  const clip = (id: string, topicId: string | undefined, seen = false) => ({ id, url: `https://example.com/${id}`, title: `Clip ${id}`, titleSource: "page", platform: "web", type: "article", site: "example.com", state: seen ? "seen" : "unread", savedAt: iso(8), fetch: "done", ...(topicId ? { topicId } : {}) });
  const day = state({ modules: { link: { places: [], clips: [clip("a", "t1"), clip("b", "t2"), clip("c", "t1", true), clip("d", undefined), clip("e", "t1"), clip("f", "t1")], topics: [{ id: "t1", name: "Algorithms", area: "learn" }, { id: "t2", name: "Travel", area: "life" }] } } });
  const line = todayLine(todayModel(day, at(10)));
  assert.deepEqual(line.within.map((row) => (row.kind === "link" ? `${row.clip.id} ${row.topic}` : "")), ["a Algorithms", "b Travel"], "two at most, newest first; no area is special; not unfiled, not seen");
});

test("what today's result in sections says to start with sits at the top; any automation set to sections, the newest, not yesterday's", () => {
  setLocale("en");
  const automation = (id: string, layout: "text" | "sections", at: string, reply: string) => ({
    id, name: id, goal: "", template: null, schedule: { kind: "daily", at: "07:00" }, enabled: true, layout, keep: "latest", notify: "always", k: "orange",
    conversationId: `c-${id}`, lastSlot: null, lastRunId: `r-${id}`, createdAt: iso(6), updatedAt: iso(6), instruction: "", nextAt: null,
    lastRun: { id: `r-${id}`, state: "completed", at, reply },
  }) as unknown as NonNullable<StateResponse["automations"]>[number];
  const brief = automation("Morning brief", "sections", iso(7), "Start with the **visa form**.\n\n## Mail\n- [Due] Visa (mail:v1)");
  const weekly = automation("My week", "sections", iso(9), "Reply to Lin first.\n\n## Done\n- Two papers");
  const plain = automation("Plain", "text", iso(10), "Just words.");
  const old = automation("Yesterday's", "sections", iso(9, 0, 19), "Old advice.\n\n## A\n- x");
  const noHeading = automation("No sections", "sections", iso(11), "Only a paragraph, no heading.");
  assert.deepEqual(todayModel(state({ automations: [brief, weekly, plain, old, noHeading] }), at(12)).advice,
    { text: "Reply to Lin first.", name: "My week", k: "orange", automationId: "My week" });
  assert.equal(todayModel(state({ automations: [plain, old] }), at(12)).advice, undefined);
});
