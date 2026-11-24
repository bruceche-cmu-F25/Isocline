import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_MIGRATIONS, listEvents as coreEvents, openWorld, type World } from "@zirma/core";
import { ServiceError, type GoogleService } from "@zirma/module-kit";
import { calendarModule, describeEvents, mapEvent, mirrorWindow, syncCalendar, type CalendarSnapshot } from "../src/index.ts";

const world = (): World => openWorld(":memory:", [...CORE_MIGRATIONS, ...calendarModule.migrations]);
/** Local time on the home node, as Google would send it (an instant). 2026-11-19 is a Thursday. */
const at = (day: number, hours: number, minutes = 0) => new Date(2026, 10, day, hours, minutes).toISOString();
const NOW = new Date(2026, 10, 19, 8, 0).getTime();
const synced = (w: World) => coreEvents(w).events.filter((event) => event.kind === "calendar.synced");

test("Google's events become ours: zones, exclusive all-day ends, midnight, cancellations, the user's answer", () => {
  const timed = mapEvent({ id: "e1", summary: " Standup ", start: { dateTime: at(19, 9) }, end: { dateTime: at(19, 9, 30) }, location: "Room 3",
    hangoutLink: "https://meet.google.com/abc", attendees: [{ self: true, responseStatus: "declined" }, {}], organizer: { email: "mia@example.com" } }, "primary", "Me")!;
  assert.deepEqual([timed.title, timed.startDate, timed.endDate, timed.allDay, timed.response, timed.attendees, timed.meeting, timed.organizer],
    ["Standup", "2026-11-19", "2026-11-19", false, "declined", 2, "https://meet.google.com/abc", "mia@example.com"]);
  const allDay = mapEvent({ id: "e2", summary: "Trip", start: { date: "2026-11-20" }, end: { date: "2026-11-23" } }, "primary", "Me")!;
  assert.deepEqual([allDay.startDate, allDay.endDate, allDay.allDay], ["2026-11-20", "2026-11-22", true], "Google's end date is the day after");
  const late = mapEvent({ id: "e3", start: { dateTime: at(19, 22) }, end: { dateTime: at(20, 0) } }, "primary", "Me")!;
  assert.deepEqual([late.title, late.endDate], ["(no title)", "2026-11-19"], "ending at midnight belongs to the day it ran");
  assert.equal(mapEvent({ id: "e4", status: "cancelled", start: { date: "2026-11-19" } }, "primary", "Me"), null);
  assert.equal(mapEvent({ id: "e5", start: {} }, "primary", "Me"), null);
  assert.equal(mapEvent({ id: "e6", start: { dateTime: at(19, 9) }, organizer: { self: true, email: "me@example.com" } }, "primary", "Me")!.organizer, null);
});

/** A Google that answers by URL; `fail` makes one account's session throw. */
function fakeGoogle(events: Record<string, unknown[]>, options: { fail?: ServiceError; accounts?: GoogleService["accounts"] } = {}): GoogleService & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    accounts: options.accounts ?? (() => [{ email: "me@example.com", capabilities: ["calRead", "mailRead"] }, { email: "mail-only@example.com", capabilities: ["mailRead"] }]),
    async session(email) {
      if (options.fail) throw options.fail;
      return {
        async send(): Promise<{ status: number; body: Record<string, unknown> }> { throw new Error("no writes in this test"); },
        async get(url) {
          calls.push(`${email} ${url.split("?")[0].split("/v3/")[1]}`);
          if (url.includes("/calendarList")) {
            return { items: [{ id: "me@example.com", summary: "me@example.com", primary: true }, { id: "team", summary: "Team", selected: true }, { id: "holidays", summary: "Holidays", selected: false }] };
          }
          const calendar = decodeURIComponent(url.split("/calendars/")[1].split("/events")[0]);
          return { items: events[calendar] ?? [] };
        },
      };
    },
  };
}

test("a sync mirrors the shown calendars of each account that may read them, and says so only when something changed", async () => {
  const w = world();
  const google = fakeGoogle({
    "me@example.com": [{ id: "a", summary: "Dentist", start: { dateTime: at(19, 15) }, end: { dateTime: at(19, 16) }, recurringEventId: "checkups" }],
    team: [{ id: "b", summary: "Offsite", start: { date: "2026-11-20" }, end: { date: "2026-11-21" } }],
  });
  await syncCalendar(w, { google }, undefined, NOW);
  assert.ok(google.calls.every((call) => call.startsWith("me@example.com")), "the mail-only account is not asked about its calendar");
  assert.ok(!google.calls.some((call) => call.includes("holidays")), "calendars the user hides in Google are left out");
  const snapshot = calendarModule.snapshot!(w) as CalendarSnapshot;
  assert.deepEqual(snapshot.events.map((event) => [event.title, event.calendar, event.k]), [["Dentist", "me@example.com", "blue"], ["Offsite", "Team", "green"]]);
  assert.deepEqual(snapshot.events.map((event) => event.recurring), ["me@example.com:checkups", undefined], "one time of an event that repeats says which");
  assert.equal(snapshot.sources[0].error, null);
  assert.equal(synced(w).length, 1);

  await syncCalendar(w, { google }, undefined, NOW + 300_000);
  assert.equal(synced(w).length, 1, "nothing changed: nothing recorded");

  const text = describeEvents(w, "2026-11-19", "2026-11-20");
  assert.match(text, /Thu 2026-11-19\n {2}15:00–16:00 Dentist \(me@example\.com\)/);
  assert.match(text, /Fri 2026-11-20\n {2}all day Offsite \(Team\)/);
});

test("in a calendar of the user's own each series has its own colour, and keeps it; a calendar they only read is one colour", async () => {
  const w = world();
  const event = (id: string, summary: string, day: number) => ({ id, summary, start: { dateTime: at(day, 9) }, end: { dateTime: at(day, 10) } });
  const google = (mine: unknown[]): GoogleService => ({
    accounts: () => [{ email: "me@example.com", capabilities: ["calRead"] }],
    async session() {
      return {
        async send(): Promise<{ status: number; body: Record<string, unknown> }> { throw new Error("no writes in this test"); },
        async get(url) {
          if (url.includes("/calendarList")) return { items: [{ id: "me@example.com", summary: "Me", primary: true, accessRole: "owner" }, { id: "school", summary: "School", selected: true, accessRole: "reader" }] };
          return { items: url.includes("/calendars/school/") ? [event("s1", "Exams", 20), event("s2", "Break", 21)] : mine };
        },
      };
    },
  });
  const colours = () => Object.fromEntries((calendarModule.snapshot!(w) as CalendarSnapshot).events.map((item) => [item.title, item.k]));

  await syncCalendar(w, { google: google([event("a", "Run", 19), event("b", "Read", 19), event("c", "Read", 20), event("d", " read ", 21)]) }, undefined, NOW);
  assert.deepEqual(colours(), { Read: "blue", read: "blue", Run: "orange", Exams: "green", Break: "green" }, "the series seen most chooses first, and none takes the read-only calendar's colour while another is free");
  assert.deepEqual((calendarModule.snapshot!(w) as CalendarSnapshot).sources[0].calendars.map((calendar) => [calendar.name, calendar.varied]), [["Me", true], ["School", false]]);

  await syncCalendar(w, { google: google([event("a", "Run", 19), event("e", "Lab", 20), event("f", "Lab", 21), event("g", "Lab", 22)]) }, undefined, NOW + 300_000);
  assert.deepEqual([colours().Run, colours().Lab], ["orange", "blue"], "Run keeps its colour; the new series takes the one that now carries the fewest events");
});

test("an account that cannot be read keeps its last events and says why; one disconnected leaves the mirror", async () => {
  const w = world();
  await syncCalendar(w, { google: fakeGoogle({ "me@example.com": [{ id: "a", summary: "Dentist", start: { dateTime: at(19, 15) } }] }) }, undefined, NOW);
  assert.deepEqual(await syncCalendar(w, { google: fakeGoogle({}, { fail: new ServiceError("unavailable", "Google could not be reached: fetch failed") }) }, undefined, NOW), { retrySoon: true }, "out of reach: try again soon");
  assert.deepEqual(await syncCalendar(w, { google: fakeGoogle({}, { fail: new ServiceError("reconnect", "Google refused the account's access") }) }, undefined, NOW), { retrySoon: false }, "needs the user: no retry");
  const snapshot = calendarModule.snapshot!(w) as CalendarSnapshot;
  assert.equal(snapshot.events.length, 1);
  assert.deepEqual([snapshot.sources[0].error, snapshot.sources[0].reconnect], ["Google refused the account's access", true]);
  assert.match(describeEvents(w, "2026-11-19", "2026-11-19"), /Could not read me@example\.com just now/);

  await syncCalendar(w, { google: fakeGoogle({}, { accounts: () => [] }) }, undefined, NOW);
  const empty = calendarModule.snapshot!(w) as CalendarSnapshot;
  assert.deepEqual(empty, { today: empty.today, ...mirrorWindow(empty.today), events: [], pending: [], sources: [] });
  assert.match(describeEvents(w, "2026-11-19", "2026-11-19"), /not connected/);
  await syncCalendar(w, {}, undefined, NOW);
});

test("Zirma reads the schedule with calendar_list, a week by default", async () => {
  const w = world();
  const today = new Date();
  const iso = (hours: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), hours).toISOString();
  await syncCalendar(w, { google: fakeGoogle({ "me@example.com": [{ id: "a", summary: "Review", start: { dateTime: iso(10) }, end: { dateTime: iso(11) } }] }) });
  const tool = calendarModule.tools.find((candidate) => candidate.name === "calendar_list")!;
  const text = tool.execute(w, {} as never);
  assert.match(text, /10:00–11:00 Review/);
  assert.equal(text.split("\n").filter((line) => /^\w{3} \d{4}-/.test(line)).length, 7);
});

test("the mirror holds this month and the next, whole, with a week on either side", () => {
  assert.deepEqual(mirrorWindow("2026-11-19"), { from: "2026-10-25", to: "2027-01-07" });
  assert.deepEqual(mirrorWindow("2026-12-01"), { from: "2026-11-24", to: "2027-02-07" }, "on the 1st: still a week back, and across the year");
  assert.deepEqual(mirrorWindow("2027-01-31"), { from: "2026-12-25", to: "2027-03-07" }, "February ends on its own last day");
});
