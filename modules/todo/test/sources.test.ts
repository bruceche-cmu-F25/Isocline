import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_MIGRATIONS, listEvents, openWorld, withCoreContext, type World } from "@isocline/core";
import { invokeOp, runTools } from "@isocline/module-kit";
import {
  acceptTodo, addTodo, completeTodo, deleteTodo, isDayOff, getTodoSettings, listTodos, mirrorCalendar, SAMPLE_OFF_WORDS, setTodoSettings, suggestTodo, todoModule, todosForProposedEvents, updateTodo, type SourceEvent, type TodoSnapshot,
} from "../src/index.ts";

const world = (): World => openWorld(":memory:", [...CORE_MIGRATIONS, ...todoModule.migrations]);
const TODAY = "2026-11-19";
const event = (id: string, patch: Partial<SourceEvent> = {}): SourceEvent => ({
  id, account: "me@example.com", calendar: "Personal", title: `Event ${id}`, allDay: true, startDate: "2026-11-21", endDate: "2026-11-21", ...patch,
});
const mirror = (w: World, events: SourceEvent[], mode: "off" | "allday" | "all" = "allday", healthy = ["me@example.com"]) =>
  mirrorCalendar(w, events, { today: TODAY, healthy: new Set(healthy), mode });
const titles = (w: World) => listTodos(w).map((todo) => todo.title);

test("all-day events of the next two weeks become todos, once each; timed ones only when the user asks for all", () => {
  const w = world();
  const events = [
    event("a", { title: "Tax return due", link: "https://calendar.example/a" }),
    event("b", { title: "Standup", allDay: false }),
    event("c", { title: "Conference", startDate: "2026-11-24", endDate: "2026-11-26" }),
    event("d", { title: "Far away", startDate: "2026-12-20", endDate: "2026-12-20" }),
    event("e", { title: "Yesterday", startDate: "2026-11-18", endDate: "2026-11-18" }),
    event("f", { title: "Declined party", response: "declined" }),
  ];
  assert.deepEqual(mirror(w, events, "off"), { added: 0, updated: 0, removed: 0 });
  assert.deepEqual(mirror(w, events), { added: 2, updated: 0, removed: 0 });
  const [tax, conference] = listTodos(w);
  assert.deepEqual([tax.title, tax.due, tax.startDate, tax.source], ["Tax return due", "2026-11-21", undefined,
    { kind: "calendar", ref: "calendar:me@example.com:a", label: "Personal", link: "https://calendar.example/a" }]);
  assert.deepEqual([conference.due, conference.startDate], ["2026-11-26", "2026-11-24"], "an event over several days is one ranged todo");
  assert.equal(tax.suggested, undefined, "the user's own calendar needs no yes");
  assert.deepEqual(mirror(w, events), { added: 0, updated: 0, removed: 0 }, "again changes nothing");
  assert.deepEqual(mirror(w, events, "all"), { added: 1, updated: 0, removed: 0 });
  assert.deepEqual(titles(w), ["Tax return due", "Conference", "Standup"]);
  // The mirror's changes are the system's, not the user's or a run's.
  assert.ok(listEvents(w).events.filter((entry) => entry.kind === "todo.added").every((entry) => entry.actor === "system"));
});

test("a mirrored todo follows its event until the user makes it theirs; a removed event takes an untouched todo with it", () => {
  const w = world();
  mirror(w, [event("a", { title: "Tax return due" }), event("b", { title: "Renew passport" }), event("c", { title: "Pay rent" }), event("d", { title: "Book flights" })]);
  const byTitle = (title: string) => listTodos(w, { includeDone: true, includeArchived: true }).find((todo) => todo.title === title)!;
  // The user renames one, finishes one, deletes one.
  updateTodo(w, { id: byTitle("Renew passport").id }, { title: "Renew passport (bring photos)" });
  completeTodo(w, { id: byTitle("Pay rent").id });
  deleteTodo(w, { id: byTitle("Book flights").id });

  // The calendar moves and renames all four.
  const moved = (id: string, title: string) => event(id, { title, startDate: "2026-11-25", endDate: "2026-11-25" });
  assert.deepEqual(mirror(w, [moved("a", "Tax return (extended)"), moved("b", "Passport"), moved("c", "Rent"), moved("d", "Flights")]), { added: 0, updated: 1, removed: 0 });
  assert.deepEqual([byTitle("Tax return (extended)").due], ["2026-11-25"], "the untouched one follows");
  assert.equal(byTitle("Renew passport (bring photos)").due, "2026-11-21", "the user's text and date stay");
  assert.equal(byTitle("Pay rent").done, true);
  assert.equal(listTodos(w, { includeDone: true, includeArchived: true }).some((todo) => /flights/i.test(todo.title)), false, "a deleted one is not made again");

  // An account that could not be read removes nothing; one that was read does, for the untouched todo only.
  assert.deepEqual(mirror(w, [], "allday", []), { added: 0, updated: 0, removed: 0 });
  assert.deepEqual(mirror(w, []), { added: 0, updated: 0, removed: 1 });
  assert.deepEqual(titles(w), ["Renew passport (bring photos)"]);
  assert.ok(byTitle("Tax return (extended)").archivedAt, "archived, not deleted");
  // And if the event comes back it is not a new todo: the user can restore the old one.
  assert.deepEqual(mirror(w, [moved("a", "Tax return (extended)")]), { added: 0, updated: 0, removed: 0 });
});

test("a suggestion from mail waits to be kept; kept, edited or finished it is the user's; dropped it never comes back", () => {
  const w = world();
  const from = (id: string, subject: string) => ({ kind: "mail" as const, ref: `mail:${id}`, label: subject });
  const first = suggestTodo(w, { title: "Send the signed lease", due: "2026-11-22", source: from("m1", "Lease   for signature") });
  assert.ok("id" in first);
  assert.deepEqual([first.suggested, first.source], [true, { kind: "mail", ref: "mail:m1", label: "Lease for signature" }]);
  assert.deepEqual(suggestTodo(w, { title: "Again", source: from("m1", "Lease") }), { error: "A todo from this was already suggested." });
  suggestTodo(w, { title: "Reply to Dana about Friday", source: from("m2", "Friday?") });
  suggestTodo(w, { title: "Buy the thing", source: from("m3", "50% off today") });

  const snapshot = todoModule.snapshot!(w) as TodoSnapshot;
  assert.equal(snapshot.todos.filter((todo) => todo.suggested).length, 3);
  assert.deepEqual(snapshot.settings, { fromCalendar: "allday", offWords: [...SAMPLE_OFF_WORDS] });

  // Keep one (the device's op), edit one, drop one.
  const [lease, dana, thing] = listTodos(w);
  invokeOp(w, [todoModule], { op: "todo.accept", requestId: "r1", input: { id: lease.id } });
  updateTodo(w, { id: dana.id }, { due: "2026-11-20" });
  deleteTodo(w, { id: thing.id });
  assert.deepEqual(listTodos(w).map((todo) => [todo.title, todo.suggested]), [["Send the signed lease", undefined], ["Reply to Dana about Friday", undefined]]);
  assert.deepEqual(suggestTodo(w, { title: "Buy the thing", source: from("m3", "50% off today") }), { error: "The user already said no to a todo from this; do not suggest it again." });
  assert.equal(acceptTodo(w, { id: lease.id }) && listEvents(w).events.filter((entry) => entry.kind === "todo.updated").length, 2, "keeping twice records nothing new");
});

test("a run suggests through todo_suggest, unattended too, and sees suggestions for what they are", () => {
  const w = world();
  const tools = runTools(w, [todoModule], { askFor: [] });
  const suggest = tools.find((tool) => tool.name === "todo_suggest")!;
  assert.equal(suggest.permission, undefined, "a suggestion is easy to undo: it never asks");
  const said = withCoreContext({ actor: "alfred" }, () => suggest.execute({ title: "Submit the form", due: "2026-11-25", mailId: "18c2f", subject: "Form due Nov 25" }, new AbortController().signal));
  assert.match(String(said), /^Suggested \[ \] \S+ {2}Submit the form \(due 2026-11-25\) \(your suggestion; the user has not kept it yet\)$/);
  assert.match(String(suggest.execute({ title: "Submit the form", mailId: "18c2f", subject: "Form due Nov 25" }, new AbortController().signal)), /already suggested/);
  assert.throws(() => suggest.execute({ title: "x", mailId: "../etc", subject: "s" }, new AbortController().signal), /Invalid parameters/);

  invokeOp(w, [todoModule], { op: "todo.sources", requestId: "r2", input: { fromCalendar: "all" } });
  assert.deepEqual(getTodoSettings(w).fromCalendar, "all");
  assert.deepEqual(listEvents(w).events.filter((entry) => entry.kind === "todo.sources_set").map((entry) => entry.payload), [{ fromCalendar: "all", was: "allday" }]);
});

// A weekly class on Tuesdays and Thursdays at 19:00, as Google hands it over: one event a time, the same `recurring`.
const at = (date: string, hour: number) => { const [y, m, d] = date.split("-").map(Number); return new Date(y, m - 1, d, hour).toISOString(); };
const classes = (dates: string[], patch: Partial<SourceEvent> = {}): SourceEvent[] => dates.map((date) =>
  event(`gym_${date}`, { title: "Gym", allDay: false, startDate: date, endDate: date, start: at(date, 19), recurring: "primary:gym", link: `https://calendar.example/gym/${date}`, ...patch }));
// 2026-11-19 is a Thursday.
const GYM = ["2026-11-12", "2026-11-17", "2026-11-19", "2026-11-24", "2026-11-26", "2026-12-01", "2026-12-03"];

test("an event that repeats weekly is one todo for its next time; finished, the time after it takes its place", () => {
  const w = world();
  const on = (today: string, events: SourceEvent[]) => mirrorCalendar(w, events, { today, healthy: new Set(["me@example.com"]), mode: "all" });
  const open = () => listTodos(w).map((todo) => [todo.title, todo.due]);
  // Rent repeats too, but monthly: it is a todo each time, as before.
  const rent = event("rent_12", { title: "Rent", startDate: "2026-12-01", endDate: "2026-12-01", recurring: "primary:rent" });
  assert.deepEqual(on(TODAY, [...classes(GYM), rent]), { added: 2, updated: 0, removed: 0 });
  assert.deepEqual(open(), [["Rent", "2026-12-01"], ["Gym", "2026-11-19"]]);
  const gym = listTodos(w)[1];
  assert.deepEqual(gym.source, { kind: "calendar", ref: "calendar:me@example.com:repeat:primary:gym", label: "Personal", link: "https://calendar.example/gym/2026-11-19", repeat: { days: [2, 4], at: "19:00" } });
  assert.equal(listTodos(w)[0].source!.repeat, undefined);
  assert.match(todoModule.tools!.length ? String(runTools(w, [todoModule], { askFor: [] }).find((tool) => tool.name === "todo_list")!.execute({}, new AbortController().signal)) : "", /Gym .*\(from the calendar; repeats Tue, Thu at 19:00, this is its next time\)/);
  assert.deepEqual(on(TODAY, [...classes(GYM), rent]), { added: 0, updated: 0, removed: 0 }, "again changes nothing");

  // The user files it under an area and finishes today's: Tuesday's comes, in that area, and stays Tuesday's.
  updateTodo(w, { id: gym.id }, { area: "life" });
  completeTodo(w, { id: gym.id });
  assert.deepEqual(on(TODAY, [...classes(GYM), rent]), { added: 1, updated: 0, removed: 0 });
  assert.deepEqual(open(), [["Rent", "2026-12-01"], ["Gym", "2026-11-24"]]);
  assert.equal(listTodos(w)[1].area, "life");
  assert.deepEqual(on(TODAY, [...classes(GYM), rent]), { added: 0, updated: 0, removed: 0 }, "not back onto the time that is done");

  // Tuesday passes without a tick: no overdue todo, it is Thursday's now.
  assert.deepEqual(on("2026-11-25", [...classes(GYM), rent]), { added: 0, updated: 1, removed: 0 });
  assert.deepEqual(open(), [["Rent", "2026-12-01"], ["Gym", "2026-11-26"]]);
  assert.equal(listTodos(w)[1].id, listTodos(w, { includeDone: true }).filter((todo) => todo.title === "Gym" && !todo.done)[0].id);

  // Removing the finished one says nothing; removing the open one takes the whole of it out, for good.
  deleteTodo(w, { id: gym.id });
  assert.deepEqual(on("2026-11-25", [...classes(GYM), rent]), { added: 0, updated: 0, removed: 0 });
  deleteTodo(w, { id: listTodos(w)[1].id });
  assert.deepEqual(on("2026-11-27", [...classes(GYM), rent]), { added: 0, updated: 0, removed: 0 });
  assert.deepEqual(open(), [["Rent", "2026-12-01"]]);
});

test("todos made one a time before are folded into the one; a renamed one stays; a weekly event that ends takes its todo with it", () => {
  const w = world();
  const on = (events: SourceEvent[], today = TODAY) => mirrorCalendar(w, events, { today, healthy: new Set(["me@example.com"]), mode: "all" });
  // As an older home node read them: no `recurring`, so one todo for each time ahead.
  const before = classes(GYM).map(({ recurring: _recurring, ...rest }) => rest);
  assert.deepEqual(on(before), { added: 5, updated: 0, removed: 0 });
  const tuesday = listTodos(w).find((todo) => todo.due === "2026-11-24")!;
  updateTodo(w, { id: tuesday.id }, { title: "Gym (legs)" });
  // Now the calendar says they are one event.
  assert.deepEqual(on(classes(GYM)), { added: 1, updated: 0, removed: 4 });
  assert.deepEqual(listTodos(w).map((todo) => [todo.title, todo.due]), [["Gym (legs)", "2026-11-24"], ["Gym", "2026-11-19"]]);
  assert.deepEqual(on(classes(GYM)), { added: 0, updated: 0, removed: 0 });

  // Its last time, read alone, is still the same one todo; and when the event is deleted the untouched todo goes.
  assert.deepEqual(on(classes(["2026-12-03"]), "2026-12-02"), { added: 0, updated: 1, removed: 0 });
  assert.deepEqual(listTodos(w).map((todo) => [todo.title, todo.due]), [["Gym (legs)", "2026-11-24"], ["Gym", "2026-12-03"]]);
  assert.deepEqual(on([], "2026-12-02"), { added: 0, updated: 0, removed: 1 });
  assert.deepEqual(titles(w), ["Gym (legs)"]);
});

test("in all-day mode a timed weekly event makes nothing; a daily all-day one is one todo, every day", () => {
  const w = world();
  const days = ["2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25"];
  const vitamins = days.map((date) => event(`vit_${date}`, { title: "Vitamins", startDate: date, endDate: date, recurring: "primary:vit" }));
  assert.deepEqual(mirror(w, [...classes(GYM), ...vitamins]), { added: 1, updated: 0, removed: 0 });
  const [todo] = listTodos(w);
  assert.deepEqual([todo.title, todo.due, todo.source!.repeat], ["Vitamins", TODAY, { days: [0, 1, 2, 3, 4, 5, 6] }]);
});

test("the next time of what repeats can be ticked off only on its day, so clicks ahead do not use up the days to come", () => {
  const w = world();
  const days = ["2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"];
  const vitamins = days.map((date) => event(`vit_${date}`, { title: "Vitamins", startDate: date, endDate: date, recurring: "primary:vit" }));
  mirror(w, vitamins);
  const today = listTodos(w)[0];
  assert.ok(!("error" in completeTodo(w, { id: today.id }, TODAY)));
  mirror(w, vitamins);
  const tomorrow = listTodos(w)[0];
  assert.equal(tomorrow.due, "2026-11-20");
  const refused = completeTodo(w, { id: tomorrow.id }, TODAY);
  assert.match("error" in refused ? refused.error : "", /can be ticked off on that day/);
  assert.equal(listTodos(w)[0].done, false);
  assert.ok(!("error" in completeTodo(w, { id: tomorrow.id }, "2026-11-20")));
  // A todo that does not repeat can be finished early, as always.
  const other = mirror(w, [event("tax", { title: "Tax return due" })]) && listTodos(w).find((todo) => todo.title === "Tax return due")!;
  assert.ok(!("error" in completeTodo(w, { id: other.id }, TODAY)));
});

test("a todo can say the hour it is due by; a timed event's todo takes the event's hour and follows it", () => {
  const w = world();
  const { todo } = addTodo(w, { title: "Final project", due: TODAY, at: "21:00" });
  assert.equal(todo.at, "21:00");
  assert.throws(() => addTodo(w, { title: "No day", at: "09:00" }), /at needs a due day/);
  assert.throws(() => updateTodo(w, { id: todo.id }, { at: "25:00" }), /HH:MM/);
  updateTodo(w, { id: todo.id }, { due: "" });
  assert.equal(listTodos(w).find((x) => x.id === todo.id)!.at, undefined, "no day, no hour");

  const start = (hour: number) => new Date(2026, 10, 21, hour, 30).toISOString();
  mirror(w, [event("talk", { title: "Talk", allDay: false, start: start(15) })], "all");
  const talk = () => listTodos(w).find((x) => x.title === "Talk")!;
  assert.deepEqual([talk().due, talk().at], ["2026-11-21", "15:30"]);
  mirror(w, [event("talk", { title: "Talk", allDay: false, start: start(17) })], "all");
  assert.equal(talk().at, "17:30", "moved with the event");
});

test("a day off (a holiday calendar's day, a break, no classes) is never a todo, and one made before goes", () => {
  const w = world();
  const ordinary = event("tax", { title: "Tax return due" });
  // As an older home node made it: a todo for the break.
  mirror(w, [ordinary, event("brk", { title: "Thanksgiving Break; No Classes", startDate: "2026-11-25", endDate: "2026-11-25" })].map((e) => ({ ...e, title: e.id === "brk" ? "Old entry" : e.title })));
  assert.deepEqual(titles(w).sort(), ["Old entry", "Tax return due"]);
  const offs = [
    event("brk", { title: "Thanksgiving Break; No Classes", startDate: "2026-11-25", endDate: "2026-11-25" }),
    event("hol", { title: "Black Friday", calendarId: "en.usa#holiday@group.v.calendar.google.com", startDate: "2026-11-27", endDate: "2026-11-27" }),
    event("lunch", { title: "Lunch Break", allDay: false }),
  ];
  assert.ok(isDayOff(offs[0]) && isDayOff(offs[1]) && !isDayOff(offs[2]) && !isDayOff(ordinary));
  // The break is read again under its own title: it is a day off now, so its untouched todo goes.
  mirror(w, [ordinary, ...offs], "all");
  assert.deepEqual(titles(w).sort(), ["Lunch Break", "Tax return due"]);
});

test("the words a day off goes by are the user's: theirs replace the samples, in any language, and are checked", () => {
  const w = world();
  const fair = event("fair", { title: "Sommerferien", startDate: "2026-11-25", endDate: "2026-11-25" });
  const brk = event("brk", { title: "Spring Break", startDate: "2026-11-26", endDate: "2026-11-26" });
  mirror(w, [fair, brk], "all");
  assert.deepEqual(titles(w), ["Sommerferien"], "a sample word takes the break out");
  const saved = setTodoSettings(w, { offWords: [" Sommerferien ", "sommerferien", "", "Brückentag"] });
  assert.deepEqual(saved.offWords, ["Sommerferien", "Brückentag"], "trimmed, once each, blanks dropped");
  mirror(w, [fair, brk], "all");
  assert.deepEqual(titles(w), ["Spring Break"], "the user's list replaces the samples");
  assert.ok(isDayOff(fair, saved.offWords) && !isDayOff({ ...fair, allDay: false }, saved.offWords));
  assert.throws(() => setTodoSettings(w, { offWords: ["x".repeat(41)] }));
  assert.equal(listEvents(w).events.filter((e) => e.kind === "todo.off_words_set").length, 1);
});

test("a proposed meeting goes on the todo list at once, and moves with a corrected proposal; what the calendar would make itself is left to it", () => {
  const w = world();
  // Local wall-clock times, as the calendar module pins them (an instant).
  const at = (local: string) => new Date(local).toISOString();
  const add = (title: string, when: unknown, extra: object = {}) => ({ op: "calendar.add", input: { title, when, ...extra } });
  const meet = add("和张伟见面", { start: at("2026-11-26T14:00"), end: at("2026-11-26T15:00") });

  assert.match(todosForProposedEvents(w, [meet, { op: "mail.send", input: {} }])[0], /added/);
  assert.deepEqual(listTodos(w).map((todo) => [todo.title, todo.due, todo.at]), [["和张伟见面", "2026-11-26", "14:00"]]);
  // Proposed again (the run asked twice), or already written by the run: not twice.
  assert.match(todosForProposedEvents(w, [meet])[0], /already/);
  assert.equal(listTodos(w).length, 1);

  // "改成3点到4点": the todo follows the correction.
  const later = add("和张伟见面", { start: at("2026-11-26T15:00"), end: at("2026-11-26T16:00") });
  assert.match(todosForProposedEvents(w, [later], [meet])[0], /moved/);
  assert.deepEqual(listTodos(w).map((todo) => [todo.due, todo.at]), [["2026-11-26", "15:00"]]);

  // An all-day one becomes a todo by itself once in the calendar (the default setting); what repeats is not one todo.
  assert.deepEqual(todosForProposedEvents(w, [add("出差", { date: "2026-11-30", endDate: "2026-12-02" }), add("课", { start: at("2026-11-24T15:00"), end: at("2026-11-24T16:00") }, { repeat: { every: "week" } })]), []);
  setTodoSettings(w, { fromCalendar: "off" });
  todosForProposedEvents(w, [add("出差", { date: "2026-11-30", endDate: "2026-12-02" })]);
  const trip = listTodos(w).find((todo) => todo.title === "出差");
  assert.deepEqual([trip?.startDate, trip?.due], ["2026-11-30", "2026-12-02"]);
  // Every event becomes a todo by itself: nothing here.
  setTodoSettings(w, { fromCalendar: "all" });
  assert.deepEqual(todosForProposedEvents(w, [add("晚饭", { start: at("2026-11-27T19:00"), end: at("2026-11-27T20:00") })]), []);
});
