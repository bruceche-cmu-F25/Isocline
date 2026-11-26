/** Todo rules, shared by device commands and agent tools. Ported from Robin's
 * todo-domain.ts. A todo is stored whole as JSON, so fields this version does
 * not edit yet (colour, estimate, work plan…) survive an import untouched.
 */
import { createHash } from "node:crypto";
import { changedFields, isArea, localDate, unknownArea, newId, recordDomainEvent, withDefaultActor, type World } from "@zirma/module-kit";
import { CALENDAR_MODES, isDayOff, MAX_OFF_WORD, MAX_OFF_WORDS, SAMPLE_OFF_WORDS, TODO_STATUSES, type CalendarMode, type Todo, type TodoRepeat, type TodoSettings, type TodoSource, type TodoStatus } from "./types.ts";

export { CALENDAR_MODES, TODO_STATUSES, type CalendarMode, type Todo, type TodoRepeat, type TodoSettings, type TodoSource, type TodoStatus };

export interface TodoRef { id?: string; title?: string; revision?: string }
export interface TodoPatch {
  done?: boolean;
  status?: TodoStatus;
  title?: string;
  /** Empty string clears it. */
  startDate?: string;
  /** Empty string clears it. */
  due?: string;
  /** The hour it is due by on its `due` day, as HH:MM; empty string clears it. Clearing `due` clears it too. */
  at?: string;
  /** Empty string clears it; never changes `due`. */
  plannedOn?: string;
  /** Empty string clears it. */
  url?: string;
  /** One of the user's area ids (core `listAreas`); empty string clears it. */
  area?: string;
}
export type TodoResult<T> = T | { error: string };

export class TodoConflictError extends Error {
  override name = "TodoConflictError";
  constructor() { super("Task changed; reload the latest version before saving"); }
}

export const MIGRATIONS = [{
  id: "todo:1",
  sql: `
CREATE TABLE todo_items (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  position INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK (
    json_valid(payload) AND json_type(payload) = 'object'
    AND json_extract(payload, '$.id') = id
    AND json_type(payload, '$.title') = 'text'
    AND json_type(payload, '$.done') IN ('true', 'false')
    AND json_type(payload, '$.createdAt') = 'text'
  )
) STRICT;
CREATE INDEX todo_items_position ON todo_items(position);
`,
}, {
  // Todos that come from somewhere (sources.ts in spirit, kept here with the rules): one row per source thing, so it
  // makes one todo, once. `seen` is what Zirma last wrote from it, to tell its own text from the user's edits.
  id: "todo:2",
  sql: `
CREATE TABLE todo_sources (
  ref TEXT PRIMARY KEY NOT NULL CHECK (length(ref) BETWEEN 1 AND 500),
  todo_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('linked', 'dismissed', 'gone')),
  seen TEXT CHECK (seen IS NULL OR json_valid(seen)),
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE todo_settings (
  key TEXT PRIMARY KEY NOT NULL CHECK (length(key) BETWEEN 1 AND 64),
  value TEXT NOT NULL CHECK (json_valid(value))
) STRICT;
`,
}];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

function localDay(value: string, field: string): string {
  const trimmed = value.trim();
  if (!DATE.test(trimmed)) throw new Error(`${field} must be a local date as YYYY-MM-DD`);
  const [year, month, day] = trimmed.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new Error(`${field} is not a real date`);
  return trimmed;
}

function normalizeUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("url must be an http, https or mailto link"); }
  if (!["http:", "https:", "mailto:"].includes(url.protocol)) throw new Error("url must be an http, https or mailto link");
  return url.href;
}

function readAll(world: World): Todo[] {
  return world.db.prepare("SELECT payload FROM todo_items ORDER BY position").all().map((row) => JSON.parse(row.payload as string) as Todo);
}

function write(world: World, todo: Todo): void {
  world.db.prepare("UPDATE todo_items SET payload = ? WHERE id = ?").run(JSON.stringify(todo), todo.id);
}

/** A version stamp for one todo, so an edit made on a stale copy is refused. */
export function todoRevision(todo: Todo): string {
  return createHash("sha256").update(JSON.stringify(todo)).digest("hex").slice(0, 16);
}

export const todoStatus = (todo: Todo): TodoStatus => todo.done ? "done" : todo.status === "doing" ? "doing" : "todo";
/** Open, and the user's: a suggestion is not theirs until they keep it. */
const isOpen = (todo: Todo) => !todo.done && !todo.archivedAt && !todo.suggested;

/** Reads never delete history; completed and abandoned tasks stay recoverable. */
export function listTodos(world: World, options: { includeDone?: boolean; includeArchived?: boolean } = {}): Todo[] {
  return readAll(world).filter((todo) => (options.includeDone || !todo.done) && (options.includeArchived || !todo.archivedAt));
}

function findTodo(todos: Todo[], ref: TodoRef): TodoResult<Todo> {
  if (ref.id) return todos.find((todo) => todo.id === ref.id) ?? { error: `No todo with id "${ref.id}".` };
  if (!ref.title?.trim()) return { error: "Provide either id or title." };
  const needle = ref.title.trim().toLowerCase();
  const matches = todos.filter((todo) => todo.title.toLowerCase().includes(needle));
  if (matches.length === 0) return { error: `No todo matching "${ref.title}".` };
  if (matches.length > 1) return { error: `"${ref.title}" matches ${matches.length} todos — pass an id. Candidates: ${matches.slice(0, 8).map((todo) => `${todo.id}: ${todo.title}`).join("; ")}` };
  return matches[0];
}

/** The todo a reference names now (by id, or a distinctive part of its title). */
export function resolveTodo(world: World, ref: TodoRef): TodoResult<Todo> {
  return findTodo(readAll(world), ref);
}

function applyPatch(world: World, todo: Todo, patch: TodoPatch): void {
  if (patch.status !== undefined && !TODO_STATUSES.includes(patch.status)) throw new Error("Unknown todo status");
  if (patch.status !== undefined && patch.done !== undefined && (patch.status === "done") !== patch.done) throw new Error("status and done conflict");
  if (patch.status !== undefined || patch.done !== undefined) {
    const status = patch.status ?? (patch.done ? "done" : "todo");
    const done = status === "done";
    if (done && !todo.done) todo.completedAt = new Date().toISOString();
    if (!done) delete todo.completedAt;
    todo.done = done;
    if (done) delete todo.next;
    todo.status = status;
    delete todo.archivedAt;
  }
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new Error("title cannot be empty");
    if (title.length > 500) throw new Error("title is too long");
    todo.title = title;
  }
  if (patch.startDate !== undefined || patch.due !== undefined) {
    const startDate = patch.startDate === undefined ? todo.startDate : patch.startDate.trim() ? localDay(patch.startDate, "startDate") : undefined;
    const due = patch.due === undefined ? todo.due : patch.due.trim() ? localDay(patch.due, "due") : undefined;
    if (startDate && !due) throw new Error("due is required when startDate is set");
    if (startDate && due && startDate > due) throw new Error("startDate cannot be after due");
    // A changed deadline is reviewed on its own merits.
    if (due !== todo.due) delete todo.reviewAfter;
    if (startDate) todo.startDate = startDate; else delete todo.startDate;
    if (due) todo.due = due; else { delete todo.due; delete todo.at; }
  }
  if (patch.at !== undefined) {
    const at = patch.at.trim();
    if (at && !CLOCK.test(at)) throw new Error("at must be an hour as HH:MM (00:00–23:59)");
    if (at && !todo.due) throw new Error("at needs a due day");
    if (at) todo.at = at; else delete todo.at;
  }
  if (patch.plannedOn !== undefined) {
    if (patch.plannedOn.trim()) todo.plannedOn = localDay(patch.plannedOn, "plannedOn"); else delete todo.plannedOn;
  }
  if (patch.url !== undefined) {
    if (patch.url.trim()) todo.url = normalizeUrl(patch.url); else delete todo.url;
  }
  if (patch.area !== undefined) {
    const area = patch.area.trim();
    if (area && area !== todo.area && !isArea(world, area)) throw new Error(unknownArea(world));
    if (area) todo.area = area; else delete todo.area;
  }
}

type TodoOp = "added" | "updated" | "completed" | "deleted" | "suggested";

/** A bounded receipt of what changed, in the same transaction as the change. */
function recordTodoEvent(world: World, op: TodoOp, before: Todo | null, after: Todo | null): void {
  const todo = after ?? before!;
  const changes = before && after ? changedFields(before, after) : undefined;
  if (changes === null) return;
  recordDomainEvent(world, {
    kind: `todo.${op}`,
    subject: `todo:${todo.id}`,
    payload: { todoId: todo.id, title: todo.title.slice(0, 200), ...(changes ? { changes } : {}) },
  });
}

export function addTodo(world: World, input: { title: string } & TodoPatch): { todo: Todo; open: number } {
  return insertTodo(world, input, "added");
}

/** A to-do from a note, put on the list by the user (docs/research/notes-editor.md 3.5). The same one (by `ref`)
 * is never on the list twice: asked again, the todo already there is the answer. One the user removed from the list
 * comes back, since they asked for it again. */
export function addFromNote(world: World, input: { title: string; source: { kind: "note"; ref: string; label: string } }): { todo: Todo; existing: boolean } {
  if (!/^note:[^:]+:.+#[0-9a-f]+:\d+$/.test(input.source.ref)) throw new Error("Not a note's to-do");
  const linked = world.db.prepare("SELECT todo_id FROM todo_sources WHERE ref = ? AND state = 'linked'").get(input.source.ref);
  const there = linked?.todo_id ? world.db.prepare("SELECT payload FROM todo_items WHERE id = ?").get(linked.todo_id as string) : undefined;
  if (there) return { todo: JSON.parse(there.payload as string) as Todo, existing: true };
  const source: TodoSource = { kind: "note", ref: input.source.ref, label: input.source.label.replace(/\s+/g, " ").trim().slice(0, 200) };
  return { todo: insertTodo(world, { title: input.title }, "added", { source }).todo, existing: false };
}

/** A note page moved or was renamed (`from` → `to`, page paths in the library): the todos from it, and from the pages
 * under it, follow, so they still lead back to their lines. */
export function moveNoteSources(world: World, from: string, to: string): number {
  let moved = 0;
  world.tx((db) => {
    for (const row of db.prepare("SELECT ref, todo_id FROM todo_sources WHERE ref >= 'note:' AND ref < 'note;'").all()) {
      const ref = row.ref as string;
      const found = /^note:([^:]+):(.+)#([0-9a-f]+:\d+)$/.exec(ref);
      if (!found) continue;
      const [, library, page, tail] = found;
      if (page !== from && !page.startsWith(`${from}/`)) continue;
      const next = `note:${library}:${to}${page.slice(from.length)}#${tail}`;
      db.prepare("UPDATE todo_sources SET ref = ?, updated_at = ? WHERE ref = ?").run(next, new Date().toISOString(), ref);
      if (row.todo_id) {
        const item = db.prepare("SELECT payload FROM todo_items WHERE id = ?").get(row.todo_id as string);
        if (item) {
          const todo = JSON.parse(item.payload as string) as Todo;
          if (todo.source?.ref === ref) {
            todo.source = { ...todo.source, ref: next, ...(page === from ? { label: to.split("/").pop()! } : {}) };
            db.prepare("UPDATE todo_items SET payload = ? WHERE id = ?").run(JSON.stringify(todo), todo.id);
          }
        }
      }
      moved++;
    }
  });
  return moved;
}

/** What of a todo Zirma wrote from its source, kept to tell later whether the user has changed it since. */
const seenOf = (todo: Todo) => ({ title: todo.title, due: todo.due ?? null, startDate: todo.startDate ?? null, at: todo.at ?? null });

function insertTodo(world: World, input: { title: string } & TodoPatch, op: "added" | "suggested", from?: { source: TodoSource; account?: string; after?: string }): { todo: Todo; open: number } {
  if (!input.title?.trim()) throw new Error("title is required");
  const todo: Todo = { id: newId(), title: input.title.trim().slice(0, 500), done: false, status: "todo", createdAt: new Date().toISOString() };
  applyPatch(world, todo, input);
  if (from) todo.source = from.source;
  if (op === "suggested") todo.suggested = true;
  return world.tx((db) => {
    const position = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM todo_items").get()!.next as number);
    db.prepare("INSERT INTO todo_items (id, position, payload) VALUES (?, ?, ?)").run(todo.id, position, JSON.stringify(todo));
    if (from) {
      // A source has one row; what repeats weekly moves its row on to the todo of its next time.
      db.prepare(`INSERT INTO todo_sources (ref, todo_id, state, seen, updated_at) VALUES (?, ?, 'linked', ?, ?)
        ON CONFLICT(ref) DO UPDATE SET todo_id = excluded.todo_id, state = 'linked', seen = excluded.seen, updated_at = excluded.updated_at`)
        .run(from.source.ref, todo.id, JSON.stringify({ ...seenOf(todo), ...(from.account ? { account: from.account } : {}), ...(from.after ? { after: from.after } : {}) }), new Date().toISOString());
    }
    recordTodoEvent(world, op, null, todo);
    return { todo, open: readAll(world).filter(isOpen).length };
  });
}

function changeTodo<T>(world: World, ref: TodoRef, op: TodoOp, change: (todo: Todo) => T): TodoResult<T> {
  return world.tx((db) => {
    const found = findTodo(readAll(world), ref);
    // Todo keeps unknown fields, so test for the field only a todo has.
    if (!("id" in found)) return found;
    if (ref.revision !== undefined && ref.revision !== todoRevision(found)) throw new TodoConflictError();
    const before = structuredClone(found);
    const result = change(found);
    // Whoever changes or finishes a suggestion has kept it.
    if (op !== "deleted") delete found.suggested;
    if (op === "deleted") {
      db.prepare("DELETE FROM todo_items WHERE id = ?").run(found.id);
      // Removed by the user (or on their yes): its source does not make it again. (A finished time of what repeats
      // is no longer the todo its source keeps: removing that one says nothing.)
      if (found.source) db.prepare("UPDATE todo_sources SET state = 'dismissed', todo_id = NULL, updated_at = ? WHERE ref = ? AND todo_id = ?").run(new Date().toISOString(), found.source.ref, found.id);
    } else write(world, found);
    recordTodoEvent(world, op, before, op === "deleted" ? null : found);
    return result;
  });
}

export function updateTodo(world: World, ref: TodoRef, patch: TodoPatch): TodoResult<Todo> {
  return changeTodo(world, ref, "updated", (todo) => { applyPatch(world, todo, patch); return todo; });
}

/** Finishes a todo. The next time of something that repeats can be finished only once its day has come: finishing
 * one makes the time after it, so ticking ahead would use up the days to come one click at a time. */
export function completeTodo(world: World, ref: TodoRef, today = localDate(new Date())): TodoResult<{ todo: Todo; alreadyDone: boolean }> {
  const found = resolveTodo(world, ref);
  if (!("id" in found)) return found;
  if (found.source?.repeat && !found.done && found.due && (found.startDate ?? found.due) > today) {
    return { error: `"${found.title}" repeats; its next time is ${found.due} and can be ticked off on that day.` };
  }
  return changeTodo(world, ref, "completed", (todo) => {
    const alreadyDone = todo.done;
    applyPatch(world, todo, { done: true });
    return { todo, alreadyDone };
  });
}

export function deleteTodo(world: World, ref: TodoRef): TodoResult<Todo> {
  return changeTodo(world, ref, "deleted", (todo) => todo);
}

/** The user keeps a suggestion: it is their todo from now on. */
export function acceptTodo(world: World, ref: TodoRef): TodoResult<Todo> {
  return changeTodo(world, ref, "updated", (todo) => todo);
}

// ---- where todos come from, besides the user's own words ---------------------------------------------------

const DEFAULT_MODE: CalendarMode = "allday";

export function getTodoSettings(world: World): TodoSettings {
  const read = (key: string) => {
    const row = world.db.prepare("SELECT value FROM todo_settings WHERE key = ?").get(key);
    return row ? JSON.parse(row.value as string) as unknown : undefined;
  };
  const mode = read("fromCalendar") as CalendarMode | undefined;
  const words = read("offWords");
  return {
    fromCalendar: mode && CALENDAR_MODES.includes(mode) ? mode : DEFAULT_MODE,
    offWords: Array.isArray(words) ? words.filter((word): word is string => typeof word === "string") : [...SAMPLE_OFF_WORDS],
  };
}

function cleanWords(words: unknown): string[] {
  if (!Array.isArray(words) || words.length > MAX_OFF_WORDS) throw new Error(`offWords is a list of at most ${MAX_OFF_WORDS} words`);
  const seen = new Set<string>();
  return words.flatMap((word) => {
    if (typeof word !== "string") throw new Error("offWords is a list of words");
    const text = word.replace(/\s+/g, " ").trim();
    if (!text) return [];
    if (text.length > MAX_OFF_WORD || /\p{Cc}/u.test(text)) throw new Error(`A day-off word is at most ${MAX_OFF_WORD} characters`);
    const key = text.toLowerCase();
    return seen.has(key) ? [] : (seen.add(key), [text]);
  });
}

export function setTodoSettings(world: World, patch: Partial<TodoSettings>): TodoSettings {
  if (patch.fromCalendar !== undefined && !CALENDAR_MODES.includes(patch.fromCalendar)) throw new Error(`fromCalendar must be one of: ${CALENDAR_MODES.join(", ")}`);
  const words = patch.offWords !== undefined ? cleanWords(patch.offWords) : undefined;
  return world.tx((db) => {
    const before = getTodoSettings(world);
    const put = db.prepare("INSERT INTO todo_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    if (patch.fromCalendar !== undefined && patch.fromCalendar !== before.fromCalendar) {
      put.run("fromCalendar", JSON.stringify(patch.fromCalendar));
      recordDomainEvent(world, { kind: "todo.sources_set", subject: "todo:settings", payload: { fromCalendar: patch.fromCalendar, was: before.fromCalendar } });
    }
    if (words && JSON.stringify(words) !== JSON.stringify(before.offWords)) {
      put.run("offWords", JSON.stringify(words));
      recordDomainEvent(world, { kind: "todo.off_words_set", subject: "todo:settings", payload: { offWords: words, was: before.offWords } });
    }
    return getTodoSettings(world);
  });
}

/** Zirma's suggestion from one thing it read (a mail): a todo that waits, marked as a suggestion, for the user to
 * keep or drop. The same thing is suggested once: not again while its todo is there, and not after the user said no. */
export function suggestTodo(world: World, input: { title: string; due?: string; area?: string; source: TodoSource }): TodoResult<Todo> {
  return world.tx((db) => {
    const known = db.prepare("SELECT state FROM todo_sources WHERE ref = ?").get(input.source.ref);
    if (known) return { error: known.state === "dismissed" ? "The user already said no to a todo from this; do not suggest it again." : "A todo from this was already suggested." };
    const source: TodoSource = { ...input.source, label: input.source.label.replace(/\s+/g, " ").trim().slice(0, 200) };
    return insertTodo(world, { title: input.title, ...(input.due ? { due: input.due } : {}), ...(input.area ? { area: input.area } : {}) }, "suggested", { source }).todo;
  });
}

/** Letters and digits only, lower case: "交房租。" and "交房租" are one title. */
const plain = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** An open todo the new one would repeat: the same title, or one naming the other (at least two letters) due the
 * same day ("买牛奶和鸡蛋" is not "买牛奶"). */
export function sameTodo(world: World, input: { title: string; due?: string }): Todo | undefined {
  const title = plain(input.title ?? "");
  if (!title) return undefined;
  const open = readAll(world).filter(isOpen);
  return open.find((todo) => plain(todo.title) === title)
    ?? open.find((todo) => {
      const other = plain(todo.title);
      return Math.min(other.length, title.length) >= 2 && (other.includes(title) || title.includes(other)) && !!input.due && todo.due === input.due;
    });
}

/** What the calendar module's calendar.add step carries, as far as a todo needs it. */
interface ProposedEvent { title?: string; when?: { start: string; end: string } | { date: string; endDate?: string }; repeat?: unknown }

/** A proposed event as a todo: due its day, at its start; a whole-day one over several days is a range. What repeats
 * is left out (it would be one todo for every time). */
function eventTodo(input: unknown): { title: string; due: string; at?: string; startDate?: string; allDay: boolean } | null {
  const event = (input ?? {}) as ProposedEvent;
  const title = event.title?.trim();
  if (!title || !event.when || event.repeat) return null;
  if ("date" in event.when) {
    const last = event.when.endDate ?? event.when.date;
    return { title, due: last, ...(last !== event.when.date ? { startDate: event.when.date } : {}), allDay: true };
  }
  const start = new Date(event.when.start);
  const at = clockOf(event.when.start);
  return Number.isNaN(start.getTime()) || !at ? null : { title, due: localDate(start), at, allDay: false };
}

/** The user wants a meeting they mention in the calendar and on the todo list both (Bruce, 2026-11-23). When a run
 * proposes adding an event, its todo is made at once, whatever the user then says to the proposal; except what the
 * calendar would turn into a todo by itself once accepted (the `fromCalendar` setting), which would be there twice.
 * A proposal that corrects an earlier one moves that one's todo, while the user has not changed it. Returns what was
 * done, a line each, for the run. */
export function todosForProposedEvents(world: World, steps: readonly { op: string; input: unknown }[], replaced: readonly { op: string; input: unknown }[] = []): string[] {
  const mode = getTodoSettings(world).fromCalendar;
  const wanted = (event: { allDay: boolean }) => mode !== "all" && !(mode === "allday" && event.allDay);
  const adds = (list: readonly { op: string; input: unknown }[]) => list.filter((step) => step.op === "calendar.add").map((step) => eventTodo(step.input)).filter((event) => event !== null);
  const earlier = adds(replaced);
  const lines: string[] = [];
  for (const event of adds(steps)) {
    if (!wanted(event)) continue;
    const open = readAll(world).filter(isOpen);
    const exactly = (todo: Todo, as: typeof event) => todo.title === as.title && (todo.due ?? null) === as.due && (todo.at ?? null) === (as.at ?? null);
    const patch = { title: event.title, due: event.due, at: event.at ?? "", startDate: event.startDate ?? "" };
    const moved = earlier.map((before) => open.find((todo) => exactly(todo, before))).find((todo) => todo !== undefined);
    if (moved) {
      const result = updateTodo(world, { id: moved.id }, patch);
      if ("id" in result) lines.push(`Its todo moved with it: ${formatTodo(result)}. Do not add another.`);
      continue;
    }
    // One the run (or the user) has already written: the same day, and the same hour or a title that names it.
    const same = open.find((todo) => todo.due === event.due && ((event.at && todo.at === event.at) || todo.title.includes(event.title) || event.title.includes(todo.title)));
    if (same) { lines.push(`The todo list already has it: ${formatTodo(same)}.`); continue; }
    const { todo } = insertTodo(world, patch.startDate ? { title: event.title, due: event.due, startDate: event.startDate } : { title: event.title, due: event.due, ...(event.at ? { at: event.at } : {}) }, "added");
    lines.push(`A todo for it was added to the list: ${formatTodo(todo)}. Do not add another.`);
  }
  return lines;
}

/** A calendar event as the mirror needs it (the calendar module's events fit). */
export interface SourceEvent {
  id: string;
  account: string;
  /** The calendar's id at its service (tells a holiday calendar apart). */
  calendarId?: string;
  calendar: string;
  title: string;
  allDay: boolean;
  /** Local dates, inclusive. */
  startDate: string;
  endDate: string;
  /** When it starts (ISO), if it has a time. */
  start?: string;
  link?: string;
  response?: string;
  /** One time of an event that repeats: what names the repeating event. */
  recurring?: string;
}

/** How far ahead an event becomes a todo. */
export const CALENDAR_AHEAD_DAYS = 14;

function plusDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return localDate(new Date(y, m - 1, d + days));
}

const dayNumber = (date: string) => { const [y, m, d] = date.split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86_400_000); };

/** The weekdays and the hour of an event that repeats, from the times of it that were read. A time moved once to
 * another day is not one of its days: a weekday counts when it comes up at least half as often as the usual one. */
function repeatOf(times: readonly SourceEvent[]): TodoRepeat {
  const days = new Map<number, number>();
  for (const date of new Set(times.map((event) => event.startDate))) {
    const weekday = (dayNumber(date) + 4) % 7; // 1970-01-01 was a Thursday
    days.set(weekday, (days.get(weekday) ?? 0) + 1);
  }
  const most = Math.max(...days.values());
  const usual = [...days].filter(([, count]) => count * 2 >= most).map(([weekday]) => weekday);
  const clocks = new Map<string, number>();
  for (const event of times) {
    if (event.allDay || !event.start) continue;
    const at = new Date(event.start);
    if (Number.isNaN(at.getTime())) continue;
    const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    clocks.set(clock, (clocks.get(clock) ?? 0) + 1);
  }
  const at = [...clocks].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  return { days: usual.sort((a, b) => a - b), ...(at ? { at } : {}) };
}

/** HH:MM of an instant, by this machine's clock (the home node's, as `today` is). */
function clockOf(iso: string | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

type Seen = { title: string; due: string | null; startDate: string | null; at?: string | null; account?: string; after?: string };

/** Keeps todos in step with the calendar, one way: an event of the next two weeks (all-day ones only, or all, as
 * `mode` says; never one the user declined) is a todo due on its day, made once. While the user has not touched
 * that todo it follows the event (a new title, a new day), and leaves the list if the event is removed; once they
 * have changed it, finished it or removed it, it is theirs and is left alone. `healthy`: the accounts whose calendar
 * was read without trouble; an account that could not be read removes nothing.
 *
 * An event that repeats every week or more often is one todo, not one for each time: it stands for the next time.
 * Untouched, it moves on by itself when that day has passed (a missed class is not an overdue todo); finished, the
 * todo for the time after it is made; removed, the whole of it stays out of the list. What repeats less often
 * (monthly rent, a birthday) is a todo each time, as any event is. */
export function mirrorCalendar(
  world: World,
  events: readonly SourceEvent[],
  options: { today: string; healthy: ReadonlySet<string>; mode: CalendarMode },
): { added: number; updated: number; removed: number } {
  const done = { added: 0, updated: 0, removed: 0 };
  if (options.mode === "off") return done;
  const horizon = plusDays(options.today, CALENDAR_AHEAD_DAYS);
  const refOf = (event: SourceEvent) => `calendar:${event.account}:${event.id}`;
  const repeatRef = (event: SourceEvent) => `calendar:${event.account}:repeat:${event.recurring}`;
  // A day off (a holiday, a break) is not a thing to do: it labels its day (`daysOff`), it is never a todo.
  const words = getTodoSettings(world).offWords;
  const dayOff = (event: SourceEvent) => isDayOff(event, words);
  const covered = (event: SourceEvent) => !(options.mode === "allday" && !event.allDay) && event.response !== "declined" && !!event.title.trim() && !dayOff(event);
  const coming = (event: SourceEvent) => event.endDate >= options.today && event.startDate <= horizon;
  const shape = (event: SourceEvent) => {
    const title = event.title.trim().slice(0, 500);
    // A timed event is due the day it starts; an all-day one that spans days is a range.
    const due = event.allDay ? event.endDate : event.startDate;
    return { title, due, startDate: event.allDay && event.startDate !== event.endDate ? event.startDate : null, at: event.allDay ? null : clockOf(event.start) };
  };
  return withDefaultActor("system", () => world.tx((db) => {
    const now = new Date().toISOString();
    const rows = new Map(db.prepare("SELECT ref, todo_id, state, seen FROM todo_sources WHERE ref >= 'calendar:' AND ref < 'calendar;'").all().map((row) => [row.ref as string, row]));
    const todos = new Map(readAll(world).map((todo) => [todo.id, todo]));
    const seenOfRow = (row: { seen?: unknown }) => row.seen ? JSON.parse(row.seen as string) as Seen : null;
    const untouched = (todo: Todo, seen: Seen) => todo.title === seen.title && (todo.due ?? null) === seen.due && (todo.startDate ?? null) === seen.startDate && (todo.at ?? null) === (seen.at ?? null);
    const sameAs = (next: ReturnType<typeof shape>, seen: Seen) => next.title === seen.title && next.due === seen.due && next.startDate === seen.startDate && next.at === (seen.at ?? null);
    const fit = (todo: Todo, next: ReturnType<typeof shape>) => {
      todo.title = next.title;
      todo.due = next.due;
      if (next.startDate) todo.startDate = next.startDate; else delete todo.startDate;
      if (next.at) todo.at = next.at; else delete todo.at;
    };

    // What repeats weekly or more often: two of its times a week apart or less, or already kept as one todo (so
    // its last time, read alone, is still part of it).
    const times = new Map<string, SourceEvent[]>();
    for (const event of events) {
      if (!event.recurring || !covered(event)) continue;
      const ref = repeatRef(event);
      times.set(ref, [...(times.get(ref) ?? []), event]);
    }
    const weekly = new Map<string, SourceEvent[]>();
    const folded = new Set<string>();
    for (const [ref, all] of times) {
      all.sort((a, b) => a.startDate.localeCompare(b.startDate) || (a.start ?? "").localeCompare(b.start ?? ""));
      const days = [...new Set(all.map((event) => dayNumber(event.startDate)))];
      if (!rows.has(ref) && !days.some((day, index) => index > 0 && day - days[index - 1] <= 7)) continue;
      weekly.set(ref, all);
      for (const event of all) folded.add(refOf(event));
    }
    // Todos made of days off before they were told apart go, unless the user has made them theirs.
    const offRefs = new Set(events.filter(dayOff).map(refOf));
    const wanted = new Map<string, SourceEvent>();
    for (const event of events) {
      if (!covered(event) || !coming(event) || folded.has(refOf(event))) continue;
      wanted.set(refOf(event), event);
    }

    for (const [ref, event] of wanted) {
      const next = shape(event);
      const row = rows.get(ref);
      if (!row) {
        const source: TodoSource = { kind: "calendar", ref, label: event.calendar.slice(0, 200), ...(event.link ? { link: event.link } : {}) };
        insertTodo(world, { title: next.title, due: next.due, ...(next.startDate ? { startDate: next.startDate } : {}), ...(next.at ? { at: next.at } : {}) }, "added", { source, account: event.account });
        done.added++;
        continue;
      }
      if (row.state !== "linked") continue;
      const todo = row.todo_id ? todos.get(row.todo_id as string) : undefined;
      const seen = seenOfRow(row);
      if (!todo || todo.done || todo.archivedAt || !seen) continue;
      const same = sameAs(next, seen);
      if (!untouched(todo, seen) || same) continue;
      const before = structuredClone(todo);
      fit(todo, next);
      write(world, todo);
      db.prepare("UPDATE todo_sources SET seen = ?, updated_at = ? WHERE ref = ?").run(JSON.stringify({ ...next, account: event.account }), now, ref);
      recordTodoEvent(world, "updated", before, todo);
      done.updated++;
    }

    for (const [ref, all] of weekly) {
      const row = rows.get(ref);
      if (row && row.state !== "linked") continue;
      const repeat = repeatOf(all);
      const ahead = all.filter(coming);
      const sourceOf = (event: SourceEvent): TodoSource => ({ kind: "calendar", ref, label: event.calendar.slice(0, 200), ...(event.link ? { link: event.link } : {}), repeat });
      const make = (event: SourceEvent, kept: { area?: string; after?: string } = {}) => {
        const next = shape(event);
        insertTodo(world, { title: next.title, due: next.due, ...(next.startDate ? { startDate: next.startDate } : {}), ...(next.at ? { at: next.at } : {}), ...(kept.area ? { area: kept.area } : {}) }, "added",
          { source: sourceOf(event), account: event.account, ...(kept.after ? { after: kept.after } : {}) });
        done.added++;
      };
      if (!row) { if (ahead[0]) make(ahead[0]); continue; }
      const todo = row.todo_id ? todos.get(row.todo_id as string) : undefined;
      const seen = seenOfRow(row);
      if (!todo || todo.archivedAt || !seen) continue;
      if (todo.done) {
        // That time is done: the time after it is the todo now, in the area the user gave the last one.
        const after = seen.due ?? options.today;
        const event = ahead.find((candidate) => candidate.startDate > after);
        if (event) make(event, { area: todo.area, after });
        continue;
      }
      // Never back onto a time already done (today's, finished this morning).
      const event = ahead.find((candidate) => !seen.after || candidate.startDate > seen.after);
      if (!event || !untouched(todo, seen)) continue;
      const next = shape(event);
      const source = sourceOf(event);
      const same = sameAs(next, seen);
      if (same && JSON.stringify(todo.source) === JSON.stringify(source)) continue;
      const before = structuredClone(todo);
      fit(todo, next);
      todo.source = source;
      write(world, todo);
      db.prepare("UPDATE todo_sources SET seen = ?, updated_at = ? WHERE ref = ?").run(JSON.stringify({ ...next, account: event.account, ...(seen.after ? { after: seen.after } : {}) }), now, ref);
      recordTodoEvent(world, "updated", before, todo);
      done.updated++;
    }

    // An event that is gone from a calendar that was read: its todo goes too, unless the user has made it theirs.
    // So does a todo made for one time of what is now one todo for all its times.
    for (const [ref, row] of rows) {
      if (wanted.has(ref) || weekly.has(ref) || row.state !== "linked" || !row.todo_id) continue;
      const seen = seenOfRow(row);
      const todo = todos.get(row.todo_id as string);
      if (!seen || !todo || todo.done || todo.archivedAt || !untouched(todo, seen)) continue;
      if (!folded.has(ref) && !offRefs.has(ref)) {
        if (!seen.account || !options.healthy.has(seen.account)) continue;
        // Past its day it is simply an overdue todo; and one the mode no longer covers stays as it is.
        if (!seen.due || seen.due < options.today || seen.due > horizon) continue;
        if (events.some((event) => refOf(event) === ref || (!!event.recurring && repeatRef(event) === ref))) continue;
      }
      const before = structuredClone(todo);
      todo.archivedAt = now;
      write(world, todo);
      db.prepare("UPDATE todo_sources SET state = 'gone', updated_at = ? WHERE ref = ?").run(now, ref);
      recordTodoEvent(world, "updated", before, todo);
      done.removed++;
    }
    return done;
  }));
}

const DUE: Record<string, (due: string) => string> = {
  overdue: (due) => ` (overdue, was due ${due})`, today: () => " (due today)", tomorrow: () => " (due tomorrow)",
  upcoming: (due) => ` (due ${due})`,
};

function dueBucket(due: string, today: string): keyof typeof DUE {
  if (due < today) return "overdue";
  if (due === today) return "today";
  const [y, m, d] = today.split("-").map(Number);
  return due === localDate(new Date(y, m - 1, d + 1)) ? "tomorrow" : "upcoming";
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** One line per todo, as a model reads it. */
export function formatTodo(todo: Todo, today: string = localDate()): string {
  const box = todo.done ? "[x]" : "[ ]";
  const date = todo.startDate && todo.due && todo.startDate !== todo.due
    ? ` (${todo.startDate} – ${todo.due}${!todo.done && todo.due < today ? ", overdue" : ""})`
    : todo.due && !todo.done ? DUE[dueBucket(todo.due, today)](todo.due) : todo.due ? ` (was due ${todo.due})` : "";
  const by = todo.at && !todo.done ? ` (by ${todo.at})` : "";
  const progress = todoStatus(todo) === "doing" ? " (in progress)" : "";
  const plan = todo.plannedOn ? ` (planned ${todo.plannedOn}, not a deadline)` : "";
  const link = todo.url ? ` -> ${todo.url}` : "";
  const area = todo.area ? ` [area: ${todo.area}]` : "";
  const repeat = todo.source?.repeat;
  const repeats = repeat ? `; repeats ${repeat.days.length === 7 ? "every day" : repeat.days.map((day) => WEEKDAYS[day]).join(", ")}${repeat.at ? ` at ${repeat.at}` : ""}, this is its next time` : "";
  const from = todo.suggested ? " (your suggestion; the user has not kept it yet)" : todo.source?.kind === "calendar" ? ` (from the calendar${repeats})` : todo.source?.kind === "mail" ? " (from mail)" : todo.source?.kind === "note" ? ` (from the note ${todo.source.label})` : "";
  return `${box} ${todo.id}  ${todo.title}${area}${progress}${date}${by}${plan}${from}${link}`;
}

/** The user removed an area: its todos move to `moveTo`, or to no area. */
export function moveTodosOutOfArea(world: World, id: string, moveTo: string | null): number {
  const rows = world.db.prepare("SELECT id FROM todo_items WHERE json_extract(payload, '$.area') = ?").all(id);
  const set = moveTo
    ? world.db.prepare("UPDATE todo_items SET payload = json_set(payload, '$.area', ?) WHERE id = ?")
    : world.db.prepare("UPDATE todo_items SET payload = json_remove(payload, '$.area') WHERE id = ?");
  for (const row of rows) moveTo ? set.run(moveTo, row.id as string) : set.run(row.id as string);
  return rows.length;
}
