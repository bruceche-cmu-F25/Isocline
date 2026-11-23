/** Changing the user's Google Calendar: adding an event (holding time), moving one they organize, answering an
 * invitation. A run never does these itself (level `external`): it proposes them, and on the user's yes each becomes
 * an outbound change (core/outbound.ts), which the home node hands to `deliverCalendar` one at a time. All of them
 * are safe to deliver again: a new event carries its own id, and a move or an answer that Google already shows counts
 * as done.
 *
 * The user needs no proposal for their own hand: on the calendar page they add an event (`calendar.create`), change
 * one they organize (`calendar.edit`) or delete it (`calendar.delete`, which only they can do: a run has no tool for
 * it), and saving, or confirming the delete, is the yes. Those go out the same way, quietly: the page shows them
 * on their way (`pendingChanges`), and only one that fails is told.
 *
 * And a proposal that waits is theirs to adjust: an event Alfred proposed, drawn on the page where it would land, can
 * be dragged to another time before they say yes (`calendar.retime`). The proposal stays a proposal.
 */
import { randomInt } from "node:crypto";
import { amendProposal, enqueueOutbound, getProposal, listOutbound, localeOf, localeTag, ProposalStateError, userLocale, type Locale, type Outbound, type Proposal, type World } from "@alfred/core";
import { defineOp, defineQuery, defineTool, Type, type Delivered, type GoogleSession, type ModuleServices } from "@alfred/module-kit";
import { addDays, mapEvent, type GoogleEvent } from "./google.ts";
import { colourOf, colourSeries, putEvent } from "./mirror.ts";
import type { CalendarPending, CalendarWhen } from "./types.ts";

const API = "https://www.googleapis.com/calendar/v3";
const RESPONSES = ["accepted", "declined", "tentative"] as const;
type Response = (typeof RESPONSES)[number];

type When = CalendarWhen;
export interface AddInput { account: string; calendarId: string; calendar: string; title: string; when: When; location?: string; notes?: string }
export interface MoveInput { account: string; calendarId: string; eventId: string; title: string; etag: string | null; when: When; notify: boolean; attendees: number }
/** What the user changed of an event, by hand: only what is named is set. `title` is what it was called before. */
export interface EditInput { account: string; calendarId: string; eventId: string; title: string; changes: { title?: string; when?: When; location?: string; notes?: string }; notify: boolean; attendees: number }
/** An event the user deleted by hand. `at`: when it was, for the words. */
export interface DeleteInput { account: string; calendarId: string; eventId: string; title: string; at: string; notify: boolean; attendees: number }
export interface RespondInput { account: string; calendarId: string; eventId: string; title: string; response: Response; at: string }

/** Google's event ids are base32hex. Ours start with "alfred", so they are recognisable in Google too. */
export function newEventId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuv";
  return `alfred${Array.from({ length: 20 }, () => alphabet[randomInt(32)]).join("")}`;
}

function format(when: When, locale: Locale): string {
  const tag = locale === "zh" ? "zh-CN" : "en-US";
  const day = (date: Date) => date.toLocaleDateString(tag, { month: "short", day: "numeric", weekday: "short" });
  const time = (date: Date) => date.toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit", hour12: false });
  if ("date" in when) {
    const [y, m, d] = when.date.split("-").map(Number);
    const [ey, em, ed] = when.endDate.split("-").map(Number);
    const first = day(new Date(y, m - 1, d));
    return when.endDate === when.date ? first : `${first} – ${day(new Date(ey, em - 1, ed))}`;
  }
  const start = new Date(when.start), end = new Date(when.end);
  return start.toDateString() === end.toDateString() ? `${day(start)} ${time(start)}–${time(end)}` : `${day(start)} ${time(start)} – ${day(end)} ${time(end)}`;
}

const SAY = {
  zh: {
    add: (input: AddInput) => `在「${input.calendar}」加「${input.title}」：${format(input.when, "zh")}`,
    move: (input: MoveInput) => `把「${input.title}」改到 ${format(input.when, "zh")}${input.notify ? `（会通知 ${input.attendees - 1} 位参会者）` : ""}`,
    respond: (input: RespondInput) => `${{ accepted: "接受", declined: "拒绝", tentative: "暂定" }[input.response]}「${input.title}」（${input.at}）的邀请`,
    delete: (input: DeleteInput) => `删除「${input.title}」（${input.at}）${input.notify ? `（会通知 ${input.attendees - 1} 位参会者）` : ""}`,
    edit: (input: EditInput) => `改「${input.title}」${input.changes.title ? ` →「${input.changes.title}」` : ""}${input.changes.when ? `：${format(input.changes.when, "zh")}` : ""}${input.notify ? `（会通知 ${input.attendees - 1} 位参会者）` : ""}`,
  },
  en: {
    add: (input: AddInput) => `Add “${input.title}” to ${input.calendar}: ${format(input.when, "en")}`,
    move: (input: MoveInput) => `Move “${input.title}” to ${format(input.when, "en")}${input.notify ? ` (tells ${input.attendees - 1} other ${input.attendees - 1 === 1 ? "guest" : "guests"})` : ""}`,
    respond: (input: RespondInput) => `${{ accepted: "Accept", declined: "Decline", tentative: "Maybe:" }[input.response]} “${input.title}” (${input.at})`,
    delete: (input: DeleteInput) => `Delete “${input.title}” (${input.at})${input.notify ? ` (tells ${input.attendees - 1} other ${input.attendees - 1 === 1 ? "guest" : "guests"})` : ""}`,
    edit: (input: EditInput) => `Change “${input.title}”${input.changes.title ? ` → “${input.changes.title}”` : ""}${input.changes.when ? `: ${format(input.changes.when, "en")}` : ""}${input.notify ? ` (tells ${input.attendees - 1} other ${input.attendees - 1 === 1 ? "guest" : "guests"})` : ""}`,
  },
};

const Instant = Type.String({ maxLength: 40 });
const Day = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const WhenSchema = Type.Union([Type.Object({ start: Instant, end: Instant }), Type.Object({ date: Day, endDate: Day })]);
const Ids = { account: Type.String({ maxLength: 320 }), calendarId: Type.String({ maxLength: 300 }) };

function checkWhen(when: When): string | null {
  if ("date" in when) return when.endDate < when.date ? "The last day is before the first" : null;
  const start = Date.parse(when.start), end = Date.parse(when.end);
  if (Number.isNaN(start) || Number.isNaN(end)) return "Times must be dates with a time";
  if (end <= start) return "The end is not after the start";
  if (end - start > 14 * 86_400_000) return "Longer than two weeks";
  return null;
}

function queue(world: World, action: "add" | "move" | "respond", payload: AddInput | MoveInput | RespondInput): { queued: string } | { error: string } {
  const problem = "when" in payload ? checkWhen(payload.when) : null;
  if (problem) return { error: problem };
  const say = SAY[userLocale(world)];
  const preview = action === "add" ? say.add(payload as AddInput) : action === "move" ? say.move(payload as MoveInput) : say.respond(payload as RespondInput);
  const outbound = enqueueOutbound(world, { module: "calendar", action, payload: action === "add" ? { ...payload, eventId: newEventId() } : payload, preview, idempotent: true });
  return { queued: outbound.id };
}

export const calendarOps = [
  defineOp({
    name: "calendar.add",
    input: Type.Object({ ...Ids, calendar: Type.String({ maxLength: 120 }), title: Type.String({ minLength: 1, maxLength: 300 }), when: WhenSchema,
      location: Type.Optional(Type.String({ maxLength: 300 })), notes: Type.Optional(Type.String({ maxLength: 4000 })) }),
    run: (world, input) => queue(world, "add", input as AddInput),
  }),
  defineOp({
    name: "calendar.move",
    input: Type.Object({ ...Ids, eventId: Type.String({ maxLength: 1024 }), title: Type.String({ maxLength: 300 }), etag: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
      when: WhenSchema, notify: Type.Boolean(), attendees: Type.Integer({ minimum: 0 }) }),
    run: (world, input) => queue(world, "move", input as MoveInput),
  }),
  defineOp({
    name: "calendar.respond",
    input: Type.Object({ ...Ids, eventId: Type.String({ maxLength: 1024 }), title: Type.String({ maxLength: 300 }),
      response: Type.Union(RESPONSES.map((response) => Type.Literal(response))), at: Type.String({ maxLength: 60 }) }),
    run: (world, input) => queue(world, "respond", input as RespondInput),
  }),
  // A proposed event, moved by the user's own hand while the proposal waits (dragged on the calendar page): the step
  // keeps what it adds or moves and takes the new time, its preview is written again, and the summary says so,
  // since Alfred's own words there may name the old time.
  defineOp({
    name: "calendar.retime",
    input: Type.Object({ proposal: Type.String({ minLength: 1, maxLength: 64 }), step: Type.Integer({ minimum: 0, maximum: 19 }), when: WhenSchema }),
    run(world, input): { ok: true } | { error: DirectRefusal } {
      let proposal: Proposal;
      try { proposal = getProposal(world, input.proposal); } catch { return { error: "gone" }; }
      const step = proposal.steps[input.step];
      if (proposal.state !== "open" || !step || (step.op !== "calendar.add" && step.op !== "calendar.move")) return { error: "gone" };
      if (checkWhen(input.when as When)) return { error: "bad_time" };
      const locale = userLocale(world);
      const next = { ...(step.input as AddInput | MoveInput), when: input.when as When };
      const preview = step.op === "calendar.add" ? SAY[locale].add(next as AddInput) : SAY[locale].move(next as MoveInput);
      // One line per event the user moved, the newest in place of an older one.
      const lead = locale === "zh" ? `↪ 你把「${next.title}」` : `↪ You moved “${next.title}”`;
      const note = `${lead}${locale === "zh" ? "改到了 " : " to "}${format(next.when, locale)}`;
      const summary = [...proposal.summary.split("\n").filter((line) => !line.startsWith(lead)), note].filter(Boolean).join("\n");
      try {
        amendProposal(world, proposal.id, input.step, { ...step, input: next, preview }, summary);
      } catch (error) {
        if (error instanceof ProposalStateError) return { error: "gone" };
        throw error;
      }
      return { ok: true };
    },
  }),
  // The user's own hand, from the calendar page. What they may change is checked against the mirror here, not taken
  // from the device; a refusal is a code the page has words for.
  defineOp({
    name: "calendar.create",
    input: Type.Object({ ...Ids, title: Type.String({ minLength: 1, maxLength: 300 }), when: WhenSchema,
      location: Type.Optional(Type.String({ maxLength: 300 })), notes: Type.Optional(Type.String({ maxLength: 4000 })) }),
    run(world, input): { queued: string; id: string; k?: string } | { error: DirectRefusal } {
      const access = source(world, input.account);
      const calendar = access?.canWrite ? access.calendars.find((candidate) => candidate.id === input.calendarId && candidate.writable) : undefined;
      if (!calendar) return { error: "no_write" };
      const title = input.title.trim();
      if (!title) return { error: "nothing" };
      if (checkWhen(input.when as When)) return { error: "bad_time" };
      const location = input.location?.trim(), notes = input.notes?.trim();
      const payload: AddInput & { eventId: string } = {
        account: input.account, calendarId: calendar.id, calendar: calendar.name, title, when: input.when as When,
        ...(location ? { location } : {}), ...(notes ? { notes } : {}), eventId: newEventId(),
      };
      const outbound = enqueueOutbound(world, { module: "calendar", action: "add", payload, preview: SAY[userLocale(world)].add(payload), idempotent: true, quiet: true });
      colourSeries(world, input.account, [title]);
      return { queued: outbound.id, id: `${calendar.id}:${payload.eventId}`, k: colourOf(world, input.account, calendar.id, title) };
    },
  }),
  defineOp({
    name: "calendar.edit",
    input: Type.Object({ account: Ids.account, id: Type.String({ maxLength: 300 }), title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })), when: Type.Optional(WhenSchema),
      location: Type.Optional(Type.String({ maxLength: 300 })), notes: Type.Optional(Type.String({ maxLength: 4000 })) }),
    run(world, input): { queued: string; k?: string } | { error: DirectRefusal } {
      const row = world.db.prepare("SELECT * FROM calendar_events WHERE account = ? AND id = ?").get(input.account, input.id) as Row | undefined;
      if (!row) return { error: "gone" };
      const access = source(world, row.account);
      if (!access?.canWrite || !access.calendars.find((calendar) => calendar.id === row.calendar_id)?.writable) return { error: "no_write" };
      if (row.organizer_self !== 1) return { error: "not_yours" };
      const title = input.title?.trim();
      const changes: EditInput["changes"] = {
        ...(title && title !== row.title ? { title } : {}), ...(input.when ? { when: input.when as When } : {}),
        ...(input.location !== undefined ? { location: input.location.trim() } : {}), ...(input.notes !== undefined ? { notes: input.notes.trim() } : {}),
      };
      if (!Object.keys(changes).length) return { error: "nothing" };
      if (changes.when && checkWhen(changes.when)) return { error: "bad_time" };
      const payload: EditInput = {
        account: row.account, calendarId: row.calendar_id, eventId: row.id.slice(row.calendar_id.length + 1), title: row.title, changes,
        notify: row.attendees > 1, attendees: row.attendees,
      };
      const outbound = enqueueOutbound(world, { module: "calendar", action: "edit", payload, preview: SAY[userLocale(world)].edit(payload), idempotent: true, quiet: true });
      if (!changes.title) return { queued: outbound.id };
      colourSeries(world, row.account, [changes.title]);
      return { queued: outbound.id, k: colourOf(world, row.account, row.calendar_id, changes.title) };
    },
  }),
  defineOp({
    name: "calendar.delete",
    input: Type.Object({ account: Ids.account, id: Type.String({ maxLength: 300 }) }),
    run(world, input): { queued: string } | { error: DirectRefusal } {
      const row = world.db.prepare("SELECT * FROM calendar_events WHERE account = ? AND id = ?").get(input.account, input.id) as Row | undefined;
      const locale = userLocale(world);
      // A mirror refresh can find an add whose POST is still waiting for a retry. In either case the undo
      // must be delivered after the last attempt at creating this particular event.
      const creation = world.db.prepare(`SELECT id, payload FROM core_outbound
        WHERE module = 'calendar' AND action = 'add' AND state IN ('queued', 'sending', 'done')
        AND json_extract(payload, '$.account') = ? AND json_extract(payload, '$.calendarId') || ':' || json_extract(payload, '$.eventId') = ?
        ORDER BY rowid DESC LIMIT 1`).get(input.account, input.id);
      const afterId = creation?.id as string | undefined;
      if (!row) {
        if (!creation) return { error: "gone" };
        const made = JSON.parse(creation.payload as string) as AddInput & { eventId: string };
        const payload: DeleteInput = { account: made.account, calendarId: made.calendarId, eventId: made.eventId, title: made.title, at: format(made.when, locale), notify: false, attendees: 0 };
        return { queued: enqueueOutbound(world, { module: "calendar", action: "delete", payload, preview: SAY[locale].delete(payload), idempotent: true, quiet: true, afterId }).id };
      }
      const access = source(world, row.account);
      if (!access?.canWrite || !access.calendars.find((calendar) => calendar.id === row.calendar_id)?.writable) return { error: "no_write" };
      if (row.organizer_self !== 1) return { error: "not_yours" };
      const payload: DeleteInput = {
        account: row.account, calendarId: row.calendar_id, eventId: row.id.slice(row.calendar_id.length + 1), title: row.title, at: whenWas(row, locale),
        notify: row.attendees > 1, attendees: row.attendees,
      };
      const outbound = enqueueOutbound(world, { module: "calendar", action: "delete", payload, preview: SAY[locale].delete(payload), idempotent: true, quiet: true, afterId });
      return { queued: outbound.id };
    },
  }),
];

/** Why a change typed on the calendar page was not taken: the account or calendar may not be changed, the event is
 * no longer there, someone else organizes it, its times make no event, or nothing was changed. */
export type DirectRefusal = "no_write" | "gone" | "not_yours" | "bad_time" | "nothing";

/** What a device reads when the user opens one event to change it: its description is not in the snapshot. */
export const calendarQueries = [
  defineQuery({
    name: "calendar.event",
    input: Type.Object({ account: Ids.account, id: Type.String({ maxLength: 300 }) }),
    run(world, input) {
      const row = world.db.prepare("SELECT notes FROM calendar_events WHERE account = ? AND id = ?").get(input.account, input.id);
      return row ? { notes: (row.notes as string | null) ?? "" } : { error: "not_found" };
    },
  }),
];

/** The calendar changes Google has not answered yet, as the page draws them over the mirror. */
export function pendingChanges(world: World): CalendarPending[] {
  return listOutbound(world, { module: "calendar", states: ["queued", "sending"] }).flatMap((outbound): CalendarPending[] => {
    if (outbound.action === "add") {
      const add = outbound.payload as AddInput & { eventId: string };
      const k = colourOf(world, add.account, add.calendarId, add.title);
      return [{ id: `${add.calendarId}:${add.eventId}`, account: add.account, calendarId: add.calendarId, added: true, title: add.title, when: add.when, ...(add.location ? { location: add.location } : {}), ...(k ? { k } : {}) }];
    }
    if (outbound.action === "move") {
      const move = outbound.payload as MoveInput;
      return [{ id: `${move.calendarId}:${move.eventId}`, account: move.account, calendarId: move.calendarId, added: false, when: move.when }];
    }
    if (outbound.action === "delete") {
      const gone = outbound.payload as DeleteInput;
      return [{ id: `${gone.calendarId}:${gone.eventId}`, account: gone.account, calendarId: gone.calendarId, added: false, removed: true }];
    }
    if (outbound.action === "edit") {
      const edit = outbound.payload as EditInput;
      const { title, when, location } = edit.changes;
      const k = title !== undefined ? colourOf(world, edit.account, edit.calendarId, title) : undefined;
      return [{ id: `${edit.calendarId}:${edit.eventId}`, account: edit.account, calendarId: edit.calendarId, added: false,
        ...(title !== undefined ? { title } : {}), ...(when ? { when } : {}), ...(location !== undefined ? { location } : {}), ...(k ? { k } : {}) }];
    }
    return [];
  });
}

/** "2026-11-19T14:00" in the home node's local time, as an instant. */
function localInstant(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d, h, min] = match.map(Number);
  return new Date(y, m - 1, d, h, min).toISOString();
}

/** How long a new event lasts when only its start was given: the user corrects it on the proposal, not in a question. */
const DEFAULT_MINUTES = 60;

/** `lasting`: minutes an event with a start and no end is given (a new event); without it, both are needed. */
function whenFrom(params: { start?: string; end?: string; date?: string; end_date?: string }, lasting?: number): When | { error: string } {
  if (params.date) return { date: params.date, endDate: params.end_date ?? params.date };
  const start = params.start ? localInstant(params.start) : null;
  const end = params.end ? localInstant(params.end)
    : start && lasting && params.end === undefined ? new Date(Date.parse(start) + lasting * 60_000).toISOString() : null;
  if (!start || !end) return { error: "Give start and end as YYYY-MM-DDTHH:MM (local time), or date (and end_date) for whole days." };
  return { start, end };
}

interface Row { account: string; id: string; calendar_id: string; calendar: string; title: string; etag: string | null; organizer_self: number; response: string | null; attendees: number; start_at: number | null; start_date: string }
function eventRow(world: World, ref: string): Row | null {
  return (world.db.prepare("SELECT * FROM calendar_events WHERE id = ? ORDER BY account LIMIT 1").get(ref) as Row | undefined) ?? null;
}
/** When an event of the mirror is, in a few words. */
function whenWas(row: Row, locale: Locale): string {
  return row.start_at
    ? new Date(row.start_at).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
    : row.start_date;
}
function source(world: World, account: string) {
  const row = world.db.prepare("SELECT can_write, calendars FROM calendar_sources WHERE account = ?").get(account);
  if (!row) return null;
  return { canWrite: row.can_write === 1, calendars: JSON.parse(row.calendars as string) as Array<{ id: string; name: string; writable?: boolean }> };
}
const NO_WRITE = "The user has not let Alfred change this calendar. Tell them they can turn on “Calendar: add and change” for the account in Settings.";
const PROPOSE_ONLY = "Changing the calendar is never done directly: put this call in `propose`, and it happens when the user accepts.";

const Times = {
  start: Type.Optional(Type.String({ description: "Start, YYYY-MM-DDTHH:MM in the user's local time" })),
  end: Type.Optional(Type.String({ description: "End, YYYY-MM-DDTHH:MM" })),
  date: Type.Optional(Type.String({ description: "For a whole-day event instead: YYYY-MM-DD" })),
  end_date: Type.Optional(Type.String({ description: "Last day of a whole-day event, if more than one" })),
};

export const calendarWriteTools = [
  defineTool({
    name: "calendar_add",
    label: "Add to calendar",
    description: "Add an event to the user's Google Calendar, or hold time for something (a todo, focus work). Only through `propose`: it happens when the user accepts. Goes to their main calendar unless you name another they can change.",
    level: "external",
    parameters: Type.Object({
      title: Type.String({ maxLength: 300 }), ...Times,
      end: Type.Optional(Type.String({ description: "End, YYYY-MM-DDTHH:MM. Unknown: leave it out (one hour is assumed) and say so in the proposal's summary; do not ask." })),
      location: Type.Optional(Type.String({ maxLength: 300 })),
      notes: Type.Optional(Type.String({ maxLength: 4000, description: "Description" })),
      calendar: Type.Optional(Type.String({ description: "Calendar name, if not their main one" })),
    }),
    describe: (_world, params) => params.title,
    execute: () => PROPOSE_ONLY,
    pin(world, params) {
      const when = whenFrom(params, DEFAULT_MINUTES);
      if ("error" in when) return when;
      const accounts = world.db.prepare("SELECT account FROM calendar_sources WHERE can_write = 1 ORDER BY account").all().map((row) => row.account as string);
      if (!accounts.length) return { error: NO_WRITE };
      const options = accounts.flatMap((account) => (source(world, account)?.calendars ?? []).filter((calendar) => calendar.writable).map((calendar) => ({ account, ...calendar })));
      const target = params.calendar
        ? options.find((calendar) => calendar.name.toLowerCase() === params.calendar!.toLowerCase()) ?? options.find((calendar) => calendar.name.toLowerCase().includes(params.calendar!.toLowerCase()))
        : options[0];
      if (!target) return { error: `No calendar called ${params.calendar} that Alfred may change. Ones it may: ${options.map((calendar) => calendar.name).join(", ") || "none"}.` };
      const input: AddInput = { account: target.account, calendarId: target.id, calendar: target.name, title: params.title.trim(), when, ...(params.location ? { location: params.location } : {}), ...(params.notes ? { notes: params.notes } : {}) };
      const problem = checkWhen(when);
      if (problem) return { error: problem };
      return { op: "calendar.add", input, preview: SAY[userLocale(world)].add(input) };
    },
  }),
  defineTool({
    name: "calendar_move",
    label: "Move event",
    description: "Move an event the user organizes to another time (guests are told). Only through `propose`. The event is its id in brackets from calendar_list. For someone else's meeting, propose an answer with calendar_respond instead.",
    level: "external",
    parameters: Type.Object({ event: Type.String({ description: "The event's id from calendar_list" }), ...Times }),
    describe: (world, params) => eventRow(world, params.event)?.title ?? params.event,
    execute: () => PROPOSE_ONLY,
    pin(world, params) {
      const row = eventRow(world, params.event);
      if (!row) return { error: `No event ${params.event} in the calendar mirror. Use calendar_list for ids.` };
      const access = source(world, row.account);
      if (!access?.canWrite || !access.calendars.find((calendar) => calendar.id === row.calendar_id)?.writable) return { error: NO_WRITE };
      if (row.organizer_self !== 1) return { error: "The user does not organize this event, so it cannot be moved for everyone. Propose an answer (calendar_respond), or suggest they ask the organizer." };
      const when = whenFrom(params);
      if ("error" in when) return when;
      const problem = checkWhen(when);
      if (problem) return { error: problem };
      const input: MoveInput = {
        account: row.account, calendarId: row.calendar_id, eventId: row.id.slice(row.calendar_id.length + 1), title: row.title, etag: row.etag, when,
        notify: row.attendees > 1, attendees: row.attendees,
      };
      return { op: "calendar.move", input, preview: SAY[userLocale(world)].move(input) };
    },
  }),
  defineTool({
    name: "calendar_respond",
    label: "Answer invitation",
    description: "Accept, decline, or answer maybe to an invitation in the user's calendar (the organizer is told). Only through `propose`. The event is its id in brackets from calendar_list.",
    level: "external",
    parameters: Type.Object({ event: Type.String({ description: "The event's id from calendar_list" }), response: Type.Union(RESPONSES.map((response) => Type.Literal(response))) }),
    describe: (world, params) => eventRow(world, params.event)?.title ?? params.event,
    execute: () => PROPOSE_ONLY,
    pin(world, params) {
      const row = eventRow(world, params.event);
      if (!row) return { error: `No event ${params.event} in the calendar mirror. Use calendar_list for ids.` };
      if (!row.response || row.organizer_self === 1) return { error: "This is not an invitation the user can answer." };
      if (!source(world, row.account)?.canWrite) return { error: NO_WRITE };
      const locale = userLocale(world);
      const at = whenWas(row, locale);
      const input: RespondInput = { account: row.account, calendarId: row.calendar_id, eventId: row.id.slice(row.calendar_id.length + 1), title: row.title, response: params.response, at };
      return { op: "calendar.respond", input, preview: SAY[locale].respond(input) };
    },
  }),
];

const googleTime = (when: When) => "date" in when
  ? { start: { date: when.date }, end: { date: addDays(when.endDate, 1) } }
  : { start: { dateTime: when.start }, end: { dateTime: when.end } };
/** For a change by hand, which may turn a timed event into whole days or back: the kind of time it no longer has is
 * taken away, since Google merges what a PATCH sends into what is there. */
const patchTime = (when: When) => "date" in when
  ? { start: { date: when.date, dateTime: null, timeZone: null }, end: { date: addDays(when.endDate, 1), dateTime: null, timeZone: null } }
  : { start: { dateTime: when.start, date: null }, end: { dateTime: when.end, date: null } };
const sameTime = (event: Record<string, unknown>, when: When) => {
  const time = googleTime(when);
  const start = event.start as { date?: string; dateTime?: string } | undefined, end = event.end as typeof start;
  return "date" in when
    ? start?.date === time.start.date && end?.date === time.end.date
    : Date.parse(start?.dateTime ?? "") === Date.parse(when.start) && Date.parse(end?.dateTime ?? "") === Date.parse(when.end);
};
const reason = (body: Record<string, unknown>) => {
  const message = (body.error as { message?: unknown } | undefined)?.message;
  return typeof message === "string" ? message.slice(0, 200) : "";
};

/** The event as Google answered a change with, written into the mirror at once: the page shows it without waiting
 * for the next read. An answer that is not a whole event (a test's, a 409) is left to that read. */
function store(world: World, account: string, calendarId: string, body: Record<string, unknown>): void {
  const name = source(world, account)?.calendars.find((calendar) => calendar.id === calendarId)?.name;
  const row = name ? mapEvent(body as GoogleEvent, calendarId, name) : null;
  if (!row) return;
  world.tx((db) => {
    putEvent(db, account, row);
    colourSeries(world, account);
  });
}

async function deliverOne(world: World, session: GoogleSession, outbound: Outbound, signal?: AbortSignal): Promise<Delivered> {
  if (outbound.action === "add") {
    const input = outbound.payload as AddInput & { eventId: string };
    const answer = await session.send("POST", `${API}/calendars/${encodeURIComponent(input.calendarId)}/events?sendUpdates=none`, {
      id: input.eventId, summary: input.title, ...googleTime(input.when),
      ...(input.location ? { location: input.location } : {}), ...(input.notes ? { description: input.notes } : {}),
    }, { signal });
    if (answer.status === 409) return { state: "done", result: { id: input.eventId, already: true } };
    if (answer.status < 300) {
      store(world, input.account, input.calendarId, answer.body);
      return { state: "done", result: { id: answer.body.id, link: answer.body.htmlLink } };
    }
    return answer.status >= 500 ? { state: "unclear", error: `Google answered ${answer.status}` } : { state: "failed", error: `Google refused (${answer.status}) ${reason(answer.body)}`.trim() };
  }
  const input = outbound.payload as MoveInput | EditInput | DeleteInput | RespondInput;
  const url = `${API}/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`;
  if (outbound.action === "delete") {
    // Gone already (deleted in Google, or by an earlier try of this) is what was asked for.
    const answer = await session.send("DELETE", `${url}?sendUpdates=${(input as DeleteInput).notify ? "all" : "none"}`, undefined, { signal });
    if (answer.status < 300 || answer.status === 404 || answer.status === 410) {
      world.db.prepare("DELETE FROM calendar_events WHERE account = ? AND id = ?").run(input.account, `${input.calendarId}:${input.eventId}`);
      return { state: "done" };
    }
    return answer.status >= 500 ? { state: "unclear", error: `Google answered ${answer.status}` } : { state: "failed", error: `Google refused (${answer.status}) ${reason(answer.body)}`.trim() };
  }
  if (outbound.action === "edit") {
    // By the user's own hand: what they set is set, whatever Google had (no If-Match). Nothing else is touched.
    const { notify, changes } = input as EditInput;
    const answer = await session.send("PATCH", `${url}?sendUpdates=${notify ? "all" : "none"}`, {
      ...(changes.title !== undefined ? { summary: changes.title } : {}), ...(changes.location !== undefined ? { location: changes.location } : {}),
      ...(changes.notes !== undefined ? { description: changes.notes } : {}), ...(changes.when ? patchTime(changes.when) : {}),
    }, { signal });
    if (answer.status < 300) {
      store(world, input.account, input.calendarId, answer.body);
      return { state: "done" };
    }
    if (answer.status === 404 || answer.status === 410) return { state: "failed", error: "The event is no longer in the calendar" };
    return answer.status >= 500 ? { state: "unclear", error: `Google answered ${answer.status}` } : { state: "failed", error: `Google refused (${answer.status}) ${reason(answer.body)}`.trim() };
  }
  if (outbound.action === "move") {
    const move = input as MoveInput;
    const answer = await session.send("PATCH", `${url}?sendUpdates=${move.notify ? "all" : "none"}`, googleTime(move.when),
      { signal, ...(move.etag ? { headers: { "If-Match": move.etag } } : {}) });
    if (answer.status < 300) {
      store(world, input.account, input.calendarId, answer.body);
      return { state: "done" };
    }
    if (answer.status === 404 || answer.status === 410) return { state: "failed", error: "The event is no longer in the calendar" };
    if (answer.status === 412) {
      // Changed in Google since it was proposed; maybe by an earlier try of this very move.
      const current = await session.get(url, signal);
      return sameTime(current, move.when) ? { state: "done" } : { state: "failed", error: "The event changed in Google since this was proposed" };
    }
    return answer.status >= 500 ? { state: "unclear", error: `Google answered ${answer.status}` } : { state: "failed", error: `Google refused (${answer.status}) ${reason(answer.body)}`.trim() };
  }
  const respond = input as RespondInput;
  const current = await session.get(url, signal);
  const attendees = (current.attendees as Array<Record<string, unknown>> | undefined) ?? [];
  const self = attendees.find((attendee) => attendee.self);
  if (!self) return { state: "failed", error: "The user is not a guest of this event" };
  if (self.responseStatus === respond.response) return { state: "done" };
  const answer = await session.send("PATCH", `${url}?sendUpdates=all`,
    { attendees: attendees.map((attendee) => attendee.self ? { ...attendee, responseStatus: respond.response } : attendee) },
    { signal, ...(typeof current.etag === "string" ? { headers: { "If-Match": current.etag } } : {}) });
  if (answer.status < 300) {
    store(world, input.account, input.calendarId, answer.body);
    return { state: "done" };
  }
  if (answer.status === 412 || answer.status >= 500) return { state: "unclear", error: `Google answered ${answer.status}` };
  return { state: "failed", error: `Google refused (${answer.status}) ${reason(answer.body)}`.trim() };
}

/** Delivers one accepted calendar change to Google (the module's `deliver`). A session that cannot be had is thrown
 * on: the queue reads that as it does for every module. */
export async function deliverCalendar(world: World, outbound: Outbound, services: ModuleServices, signal?: AbortSignal): Promise<Delivered> {
  const google = services.google;
  const account = (outbound.payload as { account: string }).account;
  if (!google?.accounts().find((candidate) => candidate.email === account)?.capabilities.includes("calWrite")) {
    return { state: "failed", error: localeOf(world.db) === "zh" ? "没有改这个日历的权限：在设置里打开「日历：替你加和改」" : "No permission to change this calendar: turn on “Calendar: add and change” in Settings" };
  }
  return deliverOne(world, await google.session(account), outbound, signal);
}
