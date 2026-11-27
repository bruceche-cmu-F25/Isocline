import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CORE_MIGRATIONS, decide, getSettings, localInstant, noticeClass, openWorld, planReminders, remindersTold, reportPresence, tellReminders,
  undeliveredNotices, updateSettings, type ReminderEvent, type ReminderMail, type ReminderTodo, type World,
} from "../src/index.ts";

const MIN = 60_000;
const T0 = new Date(2026, 10, 26, 14, 0).getTime(); // 14:00 on the home node's clock
const at = (minutes: number) => new Date(T0 + minutes * MIN).toISOString();
const world = (): World => openWorld(":memory:", CORE_MIGRATIONS);

const SETTINGS = { events: { on: true, beforeMin: 10 }, todos: { on: true, beforeMin: 60 }, mail: { senders: [] as string[], important: false, since: null as string | null } };
const event = (over: Partial<ReminderEvent> = {}): ReminderEvent => ({ id: "c:e1", title: "Group meeting", allDay: false, start: at(10), dayOff: false, ...over });
const todo = (over: Partial<ReminderTodo> = {}): ReminderTodo => ({ id: "t1", title: "Hand in essay", done: false, due: "2026-11-26", at: "15:00", fromCalendar: false, ...over });
const mail = (over: Partial<ReminderMail> = {}): ReminderMail => ({
  id: "m1", account: "me@example.com", from: "Lee", fromEmail: "lee@example.com", subject: "Draft", receivedAt: at(-2), unread: true, important: false, category: "primary", ...over,
});
const plan = (over: Partial<Parameters<typeof planReminders>[0]> = {}) =>
  planReminders({ now: T0, settings: SETTINGS, events: [], todos: [], mail: [], told: new Set(), ...over });

test("an event with a time is told its lead time before it starts, and not before", () => {
  const due = plan({ events: [event()] });
  assert.equal(due.batches.length, 1);
  assert.equal(due.batches[0].items[0].title, "Group meeting");
  assert.equal(due.batches[0].expiresAt, T0 + 10 * MIN, "it lapses when the event starts");
  const early = plan({ events: [event({ start: at(11) })] });
  assert.equal(early.batches.length, 0);
  assert.equal(early.next, T0 + MIN, "it says when to look again");
});

test("all-day events, days off, declined events and events already started are not told", () => {
  const none = plan({ events: [
    event({ id: "a", allDay: true, start: undefined }), event({ id: "b", dayOff: true }), event({ id: "c", response: "declined" }), event({ id: "d", start: at(-1) }),
  ] });
  assert.deepEqual(none.batches, []);
  assert.equal(plan({ events: [event({ response: "needsAction" })] }).batches.length, 1, "an invitation not yet answered is told");
});

test("an event added late is told at once, while it has not started", () => {
  assert.equal(plan({ events: [event({ start: at(1) })] }).batches.length, 1);
});

test("a thing told is not told again; moved to another time, it is", () => {
  const first = plan({ events: [event()] });
  const told = new Set(first.batches[0].keys);
  assert.deepEqual(plan({ events: [event()], told }).batches, []);
  assert.ok(plan({ events: [event()], told }).current.has(first.batches[0].keys[0]), "still current, so its notice is not withdrawn");
  assert.equal(plan({ now: T0 + 30 * MIN, events: [event({ start: at(35) })], told }).batches.length, 1);
});

test("todos with an hour are told; without one, from the calendar, done, suggested or archived they are not", () => {
  const due = plan({ todos: [todo()] });
  assert.equal(due.batches.length, 1);
  assert.equal(due.batches[0].expiresAt, localInstant("2026-11-26", "15:00"));
  assert.deepEqual(plan({ todos: [
    todo({ id: "a", at: undefined }), todo({ id: "b", fromCalendar: true }), todo({ id: "c", done: true }),
    todo({ id: "d", suggested: true }), todo({ id: "e", archivedAt: at(-60) }),
  ] }).batches, []);
});

test("things of one kind due in the same minute are told together; a switch turns its kind off", () => {
  const two = plan({ events: [event(), event({ id: "c:e2", title: "Call" })] });
  assert.equal(two.batches.length, 1);
  assert.equal(two.batches[0].items.length, 2);
  assert.deepEqual(plan({ events: [event()], settings: { ...SETTINGS, events: { on: false, beforeMin: 10 } } }).batches, []);
});

test("mail: only from listed senders, unread, after reminders were turned on and within the hour", () => {
  const settings = { ...SETTINGS, mail: { senders: ["lee@example.com"], important: false, since: at(-30) } };
  assert.equal(plan({ settings, mail: [mail()] }).batches.length, 1);
  assert.equal(plan({ settings, mail: [mail({ fromEmail: "LEE@example.com" })] }).batches.length, 1, "addresses match in any case");
  assert.deepEqual(plan({ settings, mail: [
    mail({ id: "a", fromEmail: "other@example.com" }), mail({ id: "b", unread: false }), mail({ id: "c", receivedAt: at(-40) }), mail({ id: "d", inInbox: false }),
  ] }).batches, []);
  assert.equal(plan({ settings, mail: [mail({ category: "updates" })] }).batches.length, 1, "a sender the user named is told whatever Gmail filed it under");
  assert.deepEqual(plan({ mail: [mail()] }).batches, [], "off with nobody listed");
});

test("mail marked important is told only when that switch is on, and not from the quieter categories", () => {
  const settings = { ...SETTINGS, mail: { senders: [], important: true, since: at(-30) } };
  assert.equal(plan({ settings, mail: [mail({ important: true })] }).batches.length, 1);
  assert.deepEqual(plan({ settings, mail: [mail({ important: true, category: "promotions" }), mail({ id: "m2" })] }).batches, []);
});

test("several new messages are one reminder, and it lapses an hour after the last came", () => {
  const settings = { ...SETTINGS, mail: { senders: ["lee@example.com"], important: false, since: at(-30) } };
  const due = plan({ settings, mail: [mail(), mail({ id: "m2", receivedAt: at(-1) })] });
  assert.equal(due.batches.length, 1);
  assert.deepEqual(due.batches[0].keys, ["mail:m1", "mail:m2"]);
  assert.equal(due.batches[0].expiresAt, T0 - MIN + 60 * MIN);
});

test("settings: defaults, partial patches, and when mail reminders were turned on", () => {
  const w = world();
  assert.deepEqual(getSettings(w).reminders, SETTINGS);
  updateSettings(w, { reminders: { events: { beforeMin: 15 } } }, T0);
  assert.deepEqual(getSettings(w).reminders.events, { on: true, beforeMin: 15 });
  assert.throws(() => updateSettings(w, { reminders: { events: { beforeMin: 7 } } }), /beforeMin/);
  assert.throws(() => updateSettings(w, { reminders: { mail: { senders: ["not an address"] } } }), /email address/);
  updateSettings(w, { reminders: { mail: { senders: [" Lee@Example.com "] } } }, T0);
  assert.deepEqual(getSettings(w).reminders.mail, { senders: ["lee@example.com"], important: false, since: new Date(T0).toISOString() });
  updateSettings(w, { reminders: { mail: { important: true } } }, T0 + MIN);
  assert.equal(getSettings(w).reminders.mail.since, new Date(T0).toISOString(), "already on: the time it was turned on stays");
  updateSettings(w, { reminders: { mail: { senders: [], important: false } } }, T0 + 2 * MIN);
  assert.equal(getSettings(w).reminders.mail.since, null);
  assert.equal(getSettings(w).reminders.events.beforeMin, 15, "a mail patch leaves the other parts alone");
});

test("a reminder is a notice that tells and is pushed; told keys are remembered; out-of-date ones are withdrawn", () => {
  const w = world();
  const due = plan({ events: [event()] });
  assert.deepEqual(tellReminders(w, due.batches, due.current, T0), { told: 1, withdrawn: 0 });
  const [notice] = undeliveredNotices(w, T0);
  assert.equal(notice.kind, "reminder");
  assert.equal(noticeClass("reminder", notice.payload), "tells_you");
  assert.deepEqual(decide(notice, [{ id: "push", kind: "push", attending: false }], T0 + 30_000), { do: "tell", outlet: "push" });
  assert.deepEqual([...remindersTold(w, T0)], due.batches[0].keys);
  assert.equal(w.db.prepare("SELECT count(*) AS n FROM core_events WHERE kind = 'reminder.due'").get()!.n, 1);
  // The event was moved an hour later before anyone saw the reminder: it is taken back.
  const moved = plan({ now: T0 + MIN, events: [event({ start: at(70) })], told: remindersTold(w, T0 + MIN) });
  assert.deepEqual(tellReminders(w, moved.batches, moved.current, T0 + MIN), { told: 0, withdrawn: 1 });
  assert.deepEqual(undeliveredNotices(w, T0 + MIN), []);
});

test("a reminder lapses when its event starts", () => {
  const w = world();
  const due = plan({ events: [event()] });
  tellReminders(w, due.batches, due.current, T0);
  assert.equal(undeliveredNotices(w, T0 + 9 * MIN).length, 1);
  assert.equal(undeliveredNotices(w, T0 + 10 * MIN).length, 0);
});

test("coming back does not fold a reminder still in time into the welcome", () => {
  const w = world();
  reportPresence(w, { clientId: "mac", kind: "active", now: T0 - 60 * MIN });
  reportPresence(w, { clientId: "mac", kind: "away", now: T0 - 59 * MIN });
  const due = plan({ events: [event()] });
  tellReminders(w, due.batches, due.current, T0);
  const back = reportPresence(w, { clientId: "mac", kind: "active", now: T0 + MIN });
  assert.equal(back.returned, true);
  assert.deepEqual(undeliveredNotices(w, T0 + MIN).filter((notice) => notice.kind === "reminder").length, 1);
});
