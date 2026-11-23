import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptProposal, CORE_MIGRATIONS, listNotices, listOpenProposals, listOutbound, openWorld, updateSettings, type World } from "@alfred/core";
import { applyStep, assistantTools, deliverQueued, invokeOp, runQuery, runTools, ServiceError, type GoogleService } from "@alfred/module-kit";
import { calendarModule, listEvents, syncCalendar, type CalendarSnapshot } from "../src/index.ts";
import { sameTitle } from "../src/write.ts";

const snapshotOf = (w: World) => calendarModule.snapshot!(w) as CalendarSnapshot;

const world = (): World => openWorld(":memory:", [...CORE_MIGRATIONS, ...calendarModule.migrations]);
const signal = new AbortController().signal;
const today = new Date();
const at = (dayOffset: number, hours: number, minutes = 0) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + dayOffset, hours, minutes);
const pad = (n: number) => String(n).padStart(2, "0");
const local = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
const event = (w: World, title: string) => listEvents(w, "0000-01-01", "9999-12-31").find((candidate) => candidate.title === title)!;

interface Sent { method: string; url: string; body: unknown; headers?: Record<string, string> }
/** A Google Calendar with one meeting the user organizes and one invitation; `answers` scripts the replies to changes. */
function fakeGoogle(options: { capabilities?: string[]; answers?: Array<{ status: number; body?: Record<string, unknown> } | Error>; current?: Record<string, unknown> } = {}) {
  const sent: Sent[] = [];
  const answers = [...(options.answers ?? [])];
  const google: GoogleService = {
    accounts: () => [{ email: "me@example.com", capabilities: options.capabilities ?? ["calRead", "calWrite"] }],
    async session() {
      return {
        async get(url) {
          if (url.includes("/calendarList")) return { items: [{ id: "me@example.com", summary: "Me", primary: true, accessRole: "owner" }, { id: "team", summary: "Team", selected: true, accessRole: "reader" }] };
          if (url.endsWith("/events/standup")) return options.current ?? {};
          if (url.endsWith("/events/demo")) return { etag: "\"e9\"", attendees: [{ email: "vendor@x.com", organizer: true }, { email: "me@example.com", self: true, responseStatus: "needsAction" }] };
          if (url.includes("/calendars/team/")) return { items: [] };
          return { items: [
            { id: "standup", etag: "\"e1\"", summary: "Standup", start: { dateTime: at(1, 9, 30).toISOString() }, end: { dateTime: at(1, 9, 45).toISOString() },
              organizer: { self: true, email: "me@example.com" }, attendees: [{ self: true, responseStatus: "accepted" }, { email: "a@x.com" }, { email: "b@x.com" }] },
            { id: "demo", etag: "\"e9\"", summary: "Vendor demo", start: { dateTime: at(1, 14, 30).toISOString() }, end: { dateTime: at(1, 15).toISOString() },
              organizer: { email: "vendor@x.com" }, attendees: [{ email: "vendor@x.com" }, { self: true, responseStatus: "needsAction" }] },
          ] };
        },
        async send(method, url, body, init) {
          sent.push({ method, url: url.replace("https://www.googleapis.com/calendar/v3", ""), body, ...(init?.headers ? { headers: init.headers } : {}) });
          const next = answers.shift();
          if (next instanceof Error) throw next;
          return { status: next?.status ?? 200, body: next?.body ?? { id: "created", htmlLink: "https://calendar.google.com/e" } };
        },
      };
    },
  };
  return { google, sent };
}

/** Alfred proposes `calls` the way a run does (the propose tool), and the user accepts. */
async function proposeAndAccept(w: World, calls: Array<{ tool: string; params: Record<string, unknown> }>): Promise<void> {
  const propose = assistantTools(w, [calendarModule]).find((tool) => tool.name === "propose")!;
  const said = await propose.execute({ title: "Calendar changes?", summary: "", calls }, signal);
  assert.match(said, /^Proposed/, said);
  const [proposal] = listOpenProposals(w);
  assert.equal(acceptProposal(w, proposal.id, (step) => { applyStep(w, [calendarModule], step); }).state, "executed");
}

test("a run can only propose calendar changes: the tools are not offered to call, and propose names them", () => {
  const w = world();
  assert.deepEqual(runTools(w, [calendarModule]).map((tool) => tool.name), ["calendar_list"]);
  const propose = assistantTools(w, [calendarModule]).find((tool) => tool.name === "propose")!;
  assert.match(propose.description, /calendar_add, calendar_move, calendar_respond/);
});

test("holding time: proposed in the user's words, accepted, created under its own id, and safe to deliver twice", async () => {
  const w = world();
  const { google, sent } = fakeGoogle({ answers: [{ status: 503 }, { status: 409 }] });
  await syncCalendar(w, { google });
  updateSettings(w, { locale: "zh" });
  const start = at(2, 14), end = at(2, 16);
  await proposeAndAccept(w, [{ tool: "calendar_add", params: { title: "写方案", start: local(start), end: local(end) } }]);
  const [outbound] = listOutbound(w);
  assert.match(outbound.preview, /^在「Me」加「写方案」：.* 14:00–16:00$/);
  assert.equal(outbound.state, "queued");

  await deliverQueued(w, calendarModule, { google }, signal);
  assert.equal(listOutbound(w)[0].state, "queued", "Google was down: tried again next pass");
  await deliverQueued(w, calendarModule, { google }, signal);
  assert.equal(listOutbound(w)[0].state, "done", "409 on the second try: the first had made it");
  assert.equal(sent.length, 2);
  const body = sent[0].body as { id: string; summary: string; start: { dateTime: string } };
  assert.equal(sent[0].method, "POST");
  assert.equal(sent[0].url, "/calendars/me%40example.com/events?sendUpdates=none");
  assert.match(body.id, /^alfred[0-9a-v]{20}$/);
  assert.equal((sent[1].body as { id: string }).id, body.id, "the same event id both times");
  assert.deepEqual([body.summary, Date.parse(body.start.dateTime)], ["写方案", start.getTime()]);
});

test("a repeating event is one event with Google's rule and the time zone; a step names the events it overlaps", async () => {
  const w = world();
  const { google, sent } = fakeGoogle();
  await syncCalendar(w, { google });
  updateSettings(w, { locale: "zh" });
  const add = calendarModule.tools.find((tool) => tool.name === "calendar_add")!;
  // Over the standup (9:30–9:45 tomorrow).
  const over = add.pin!(w, { title: "组会", start: local(at(1, 9)), end: local(at(1, 10)) } as never) as { preview: string };
  assert.match(over.preview, /（和「Standup」09:30–09:45重叠）$/);
  const free = add.pin!(w, { title: "组会", start: local(at(1, 11)), end: local(at(1, 12)) } as never) as { preview: string };
  assert.doesNotMatch(free.preview, /重叠/);
  assert.match(String((add.pin!(w, { title: "x", start: local(at(1, 11)), until: "2027-01-01" } as never) as { error: string }).error), /only for an event that repeats/);

  const last = at(30, 0);
  const until = `${last.getFullYear()}-${pad(last.getMonth() + 1)}-${pad(last.getDate())}`;
  await proposeAndAccept(w, [{ tool: "calendar_add", params: { title: "组会", start: local(at(2, 15)), end: local(at(2, 16)), repeat: "week", until } }]);
  assert.match(listOutbound(w)[0].preview, new RegExp(`15:00–16:00，每周重复到 ${until}$`));
  await deliverQueued(w, calendarModule, { google }, signal);
  const body = sent[0].body as { recurrence: string[]; start: { dateTime: string; timeZone: string }; end: { timeZone: string } };
  assert.match(body.recurrence[0], /^RRULE:FREQ=WEEKLY;UNTIL=\d{8}T\d{6}Z$/);
  assert.equal(body.start.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(body.end.timeZone, body.start.timeZone);
  assert.equal(Date.parse(body.start.dateTime), at(2, 15).getTime());
});

test("moving: only events the user organizes, guests told, refused when Google's copy changed in between", async () => {
  const w = world();
  const { google, sent } = fakeGoogle({ answers: [{ status: 412 }], current: { start: { dateTime: at(1, 11).toISOString() } } });
  await syncCalendar(w, { google });
  const move = calendarModule.tools.find((tool) => tool.name === "calendar_move")!;
  const demo = event(w, "Vendor demo"), standup = event(w, "Standup");
  assert.deepEqual([standup.editable, standup.invited, demo.editable, demo.invited], [true, false, false, true]);
  assert.match(String((move.pin!(w, { event: demo.id, start: local(at(1, 16)), end: local(at(1, 17)) } as never) as { error: string }).error), /does not organize/);

  await proposeAndAccept(w, [{ tool: "calendar_move", params: { event: standup.id, start: local(at(1, 10)), end: local(at(1, 10, 15)) } }]);
  assert.match(listOutbound(w)[0].preview, /tells 2 other guests/);
  await deliverQueued(w, calendarModule, { google }, signal);
  assert.deepEqual([sent[0].method, sent[0].url, sent[0].headers], ["PATCH", "/calendars/me%40example.com/events/standup?sendUpdates=all", { "If-Match": "\"e1\"" }]);
  assert.deepEqual([listOutbound(w)[0].state, listOutbound(w)[0].error], ["failed", "The event changed in Google since this was proposed"]);
});

test("a move cut off after Google made it counts as done, not as a conflict", async () => {
  const w = world();
  const target = { start: local(at(1, 10)), end: local(at(1, 10, 15)) };
  const { google } = fakeGoogle({ answers: [{ status: 412 }], current: { start: { dateTime: at(1, 10).toISOString() }, end: { dateTime: at(1, 10, 15).toISOString() } } });
  await syncCalendar(w, { google });
  await proposeAndAccept(w, [{ tool: "calendar_move", params: { event: event(w, "Standup").id, ...target } }]);
  await deliverQueued(w, calendarModule, { google }, signal);
  assert.equal(listOutbound(w)[0].state, "done");
});

test("answering an invitation: only the user's own answer changes, and the organizer is told", async () => {
  const w = world();
  const { google, sent } = fakeGoogle();
  await syncCalendar(w, { google });
  await proposeAndAccept(w, [{ tool: "calendar_respond", params: { event: event(w, "Vendor demo").id, response: "declined" } }]);
  assert.match(listOutbound(w)[0].preview, /^Decline “Vendor demo”/);
  await deliverQueued(w, calendarModule, { google }, signal);
  assert.equal(sent[0].url, "/calendars/me%40example.com/events/demo?sendUpdates=all");
  assert.deepEqual(sent[0].body, { attendees: [{ email: "vendor@x.com", organizer: true }, { email: "me@example.com", self: true, responseStatus: "declined" }] });
  assert.equal(listOutbound(w)[0].state, "done");
});

test("an event with only a start is proposed as one hour; moving one still needs both ends", async () => {
  const w = world();
  await syncCalendar(w, { google: fakeGoogle().google });
  updateSettings(w, { locale: "zh" });
  const add = calendarModule.tools.find((tool) => tool.name === "calendar_add")!;
  const pinned = add.pin!(w, { title: "Final", start: local(at(3, 16)) } as never) as { preview: string; input: { when: { start: string; end: string } } };
  assert.match(pinned.preview, /16:00–17:00$/);
  assert.equal(Date.parse(pinned.input.when.end) - Date.parse(pinned.input.when.start), 60 * 60_000);
  assert.match(String((add.pin!(w, { title: "Final", end: local(at(3, 17)) } as never) as { error: string }).error), /Give start and end/);

  const move = calendarModule.tools.find((tool) => tool.name === "calendar_move")!;
  assert.match(String((move.pin!(w, { event: event(w, "Standup").id, start: local(at(3, 16)) } as never) as { error: string }).error), /Give start and end/);
});

test("an event made by hand can be taken back at once: the delete goes after the add, and the page shows neither", async () => {
  const w = world();
  const { google, sent } = fakeGoogle({ answers: [{ status: 200, body: {} }, { status: 204 }] });
  await syncCalendar(w, { google });
  const start = at(2, 16), end = at(2, 17);
  const said = byHand(w, "calendar.create", { account: "me@example.com", calendarId: "me@example.com", title: "Final", when: { start: start.toISOString(), end: end.toISOString() } });
  assert.ok(byHand(w, "calendar.delete", { account: "me@example.com", id: said.id! }).queued, "not in the mirror yet, and still theirs to take back");
  assert.deepEqual(snapshotOf(w).pending.map((change) => [change.id, change.added, change.removed ?? false]), [[said.id, true, false], [said.id, false, true]]);
  await deliverQueued(w, calendarModule, { google }, signal);
  await deliverQueued(w, calendarModule, { google }, signal);
  assert.deepEqual(sent.map((request) => request.method), ["POST", "DELETE"]);
  assert.equal(listEvents(w, "0000-01-01", "9999-12-31").some((candidate) => candidate.title === "Final"), false);
  assert.deepEqual(byHand(w, "calendar.delete", { account: "me@example.com", id: "me@example.com:never" }), { error: "gone" });
});

test("an undo waits for its own add to finish retrying while unrelated calendar changes still go through", async () => {
  const w = world();
  const { google, sent } = fakeGoogle({ answers: [{ status: 503 }, { status: 200 }, { status: 409 }, { status: 204 }] });
  await syncCalendar(w, { google });
  const account = "me@example.com";
  const input = { account, calendarId: account, title: "Focus", when: { start: at(2, 16).toISOString(), end: at(2, 17).toISOString() } };
  const made = byHand(w, "calendar.create", input);
  const undo = byHand(w, "calendar.delete", { account, id: made.id! });
  byHand(w, "calendar.create", { ...input, title: "Lunch" });

  await deliverQueued(w, calendarModule, { google }, signal);
  assert.deepEqual(sent.map((request) => [request.method, (request.body as { summary: string }).summary]), [["POST", "Focus"], ["POST", "Lunch"]]);
  const waiting = listOutbound(w).find((entry) => entry.id === undo.queued)!;
  assert.deepEqual([waiting.state, waiting.attempts], ["queued", 0]);
  await deliverQueued(w, calendarModule, { google }, signal);
  assert.deepEqual(sent.map((request) => request.method), ["POST", "POST", "POST", "DELETE"]);
  assert.ok(sent.at(-1)!.url.includes(made.id!.slice(account.length + 1)));
  assert.ok(listOutbound(w).every((entry) => entry.state === "done"));
});

test("upgrading an outstanding add repeats an undo that was delivered prematurely", async () => {
  const w = world();
  const { google, sent } = fakeGoogle({ answers: [{ status: 503 }, { status: 404 }, { status: 200 }, { status: 204 }] });
  await syncCalendar(w, { google });
  const account = "me@example.com";
  const made = byHand(w, "calendar.create", { account, calendarId: account, title: "Focus", when: { start: at(2, 16).toISOString(), end: at(2, 17).toISOString() } });
  byHand(w, "calendar.delete", { account, id: made.id! });
  w.db.prepare("UPDATE core_outbound SET after_id = NULL").run();
  await deliverQueued(w, calendarModule, { google }, signal);
  assert.deepEqual(listOutbound(w).map((entry) => entry.state), ["queued", "done"]);

  w.db.exec(calendarModule.migrations.find(({ id }) => id === "calendar:6")!.sql);
  await deliverQueued(w, calendarModule, { google }, signal);
  assert.deepEqual(sent.map((request) => request.method), ["POST", "DELETE", "POST", "DELETE"]);
  assert.ok(listOutbound(w).every((entry) => entry.state === "done"));
});

test("a proposed event is the user's to move before they say yes: the step takes the new time, and accepting adds it there", async () => {
  const w = world();
  const { google, sent } = fakeGoogle({ answers: [{ status: 200, body: {} }] });
  await syncCalendar(w, { google });
  updateSettings(w, { locale: "zh" });
  const propose = assistantTools(w, [calendarModule]).find((tool) => tool.name === "propose")!;
  await propose.execute({ title: "把考试加入日历？", summary: "12月2日 16:00 考试。", calls: [{ tool: "calendar_add", params: { title: "Final", start: local(at(3, 16)), end: local(at(3, 17)) } }] }, signal);
  const [proposal] = listOpenProposals(w);
  const when = { start: at(4, 9).toISOString(), end: at(4, 10, 30).toISOString() };

  assert.deepEqual(byHand(w, "calendar.retime", { proposal: proposal.id, step: 0, when }), { ok: true });
  assert.deepEqual(byHand(w, "calendar.retime", { proposal: proposal.id, step: 0, when }), { ok: true }, "moved twice: one note, not two");
  const [moved] = listOpenProposals(w);
  assert.equal(moved.id, proposal.id, "still the same proposal, still waiting");
  assert.deepEqual((moved.steps[0].input as { when: unknown }).when, when);
  assert.match(moved.steps[0].preview, /^在「Me」加「Final」：.* 09:00–10:30$/);
  assert.match(moved.summary, /^12月2日 16:00 考试。\n↪ 你把「Final」改到了 .* 09:00–10:30$/);
  assert.equal(moved.stale, false, "their own change does not make it stale");

  assert.deepEqual(byHand(w, "calendar.retime", { proposal: proposal.id, step: 0, when: { start: when.end, end: when.start } }), { error: "bad_time" });
  assert.deepEqual(byHand(w, "calendar.retime", { proposal: proposal.id, step: 3, when }), { error: "gone" });
  assert.deepEqual(byHand(w, "calendar.retime", { proposal: "nope", step: 0, when }), { error: "gone" });

  assert.equal(acceptProposal(w, proposal.id, (step) => { applyStep(w, [calendarModule], step); }).state, "executed");
  await deliverQueued(w, calendarModule, { google }, signal);
  assert.deepEqual((sent[0].body as { start: unknown; end: unknown }).start, { dateTime: when.start });
  assert.deepEqual(byHand(w, "calendar.retime", { proposal: proposal.id, step: 0, when }), { error: "gone" }, "decided: nothing left to move");
});

test("without the user's permission to change the calendar: nothing is proposed, and nothing is sent", async () => {
  const w = world();
  const readOnly = fakeGoogle({ capabilities: ["calRead"] });
  await syncCalendar(w, { google: readOnly.google });
  const add = calendarModule.tools.find((tool) => tool.name === "calendar_add")!;
  assert.match(String((add.pin!(w, { title: "Focus", start: local(at(1, 9)), end: local(at(1, 10)) } as never) as { error: string }).error), /Settings/);

  // Allowed when proposed, taken away before delivery: refused, nothing sent.
  await syncCalendar(w, { google: fakeGoogle().google });
  await proposeAndAccept(w, [{ tool: "calendar_add", params: { title: "Focus", start: local(at(1, 9)), end: local(at(1, 10)) } }]);
  await deliverQueued(w, calendarModule, { google: readOnly.google }, signal);
  assert.equal(readOnly.sent.length, 0);
  assert.equal(listOutbound(w)[0].state, "failed");

  // Google stops honouring the account mid-delivery: failed, and says to reconnect.
  const revoked = fakeGoogle({ answers: [new ServiceError("reconnect", "Google refused the account's access")] });
  await proposeAndAccept(w, [{ tool: "calendar_add", params: { title: "Focus 2", start: local(at(1, 11)), end: local(at(1, 12)) } }]);
  await deliverQueued(w, calendarModule, { google: revoked.google }, signal);
  assert.deepEqual(listOutbound(w).map((outbound) => [outbound.state, outbound.error?.slice(0, 22)]), [["failed", "No permission to chang"], ["failed", "Google refused the acc"]]);
});

let request = 0;
/** What the calendar page sends when the user saves. */
const byHand = (w: World, op: string, input: unknown) => invokeOp(w, [calendarModule], { op, requestId: `hand-${++request}`, input }).result as { queued?: string; id?: string; k?: string; error?: string };

test("by hand: an event typed into the page goes out with no proposal, shows as on its way, and is in the mirror the moment Google answers", async () => {
  const w = world();
  const start = at(2, 14), end = at(2, 15);
  const created = { id: "", summary: "Lunch with Mia", location: "Cafe", description: "Bring the draft", etag: "\"n1\"", start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() }, htmlLink: "https://calendar.google.com/e" };
  const { google, sent } = fakeGoogle({ answers: [{ status: 200, body: created }] });
  await syncCalendar(w, { google });

  const said = byHand(w, "calendar.create", { account: "me@example.com", calendarId: "me@example.com", title: " Lunch with Mia ", when: { start: start.toISOString(), end: end.toISOString() }, location: "Cafe", notes: "Bring the draft" });
  assert.match(said.id!, /^me@example\.com:alfred[0-9a-v]{20}$/);
  assert.deepEqual(listOpenProposals(w), [], "saving was the yes");
  const [pending] = snapshotOf(w).pending;
  assert.deepEqual(pending, { id: said.id, account: "me@example.com", calendarId: "me@example.com", added: true, title: "Lunch with Mia", when: { start: start.toISOString(), end: end.toISOString() }, location: "Cafe", k: said.k });

  created.id = said.id!.slice("me@example.com:".length);
  await deliverQueued(w, calendarModule, { google }, signal);
  assert.deepEqual(sent[0].body, { id: created.id, summary: "Lunch with Mia", start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() }, location: "Cafe", description: "Bring the draft" });
  const snapshot = snapshotOf(w);
  assert.deepEqual(snapshot.pending, []);
  const lunch = snapshot.events.find((candidate) => candidate.id === said.id)!;
  assert.deepEqual([lunch.title, lunch.location, lunch.editable, lunch.k], ["Lunch with Mia", "Cafe", true, said.k], "no read of Google was needed to show it, and it kept the colour it was drawn in");
  assert.notEqual(said.k, event(w, "Standup").k, "a new series: its own colour, the one least used");
  assert.deepEqual(runQuery([calendarModule], w, "calendar.event", { account: "me@example.com", id: said.id }), { notes: "Bring the draft" });
  assert.deepEqual(listNotices(w).filter((notice) => notice.kind === "outbound"), [], "they watched it happen: no notice");
});

test("by hand: changing an event sets only what was changed, tells its guests, and can turn it into whole days", async () => {
  const w = world();
  const { google, sent } = fakeGoogle();
  await syncCalendar(w, { google });
  const standup = event(w, "Standup");
  const day = `${at(3, 0).getFullYear()}-${pad(at(3, 0).getMonth() + 1)}-${pad(at(3, 0).getDate())}`;

  assert.deepEqual(byHand(w, "calendar.edit", { account: standup.account, id: standup.id, title: "Standup" }), { error: "nothing" });
  const renamed = byHand(w, "calendar.edit", { account: standup.account, id: standup.id, title: "Daily sync", location: "", when: { date: day, endDate: day } });
  const [outbound] = listOutbound(w);
  assert.deepEqual([outbound.action, outbound.quiet], ["edit", true]);
  assert.match(outbound.preview, /^Change “Standup” → “Daily sync”: .* \(tells 2 other guests\)$/);
  assert.deepEqual(snapshotOf(w).pending, [{ id: standup.id, account: standup.account, calendarId: standup.calendarId, added: false, title: "Daily sync", when: { date: day, endDate: day }, location: "", k: renamed.k }]);

  await deliverQueued(w, calendarModule, { google }, signal);
  assert.deepEqual([sent[0].method, sent[0].url, sent[0].headers], ["PATCH", "/calendars/me%40example.com/events/standup?sendUpdates=all", undefined]);
  const next = `${at(4, 0).getFullYear()}-${pad(at(4, 0).getMonth() + 1)}-${pad(at(4, 0).getDate())}`;
  assert.deepEqual(sent[0].body, { summary: "Daily sync", location: "", start: { date: day, dateTime: null, timeZone: null }, end: { date: next, dateTime: null, timeZone: null } });
  assert.equal(listOutbound(w)[0].state, "done");
});

test("by hand: only what the user may change, and a refusal by Google is told", async () => {
  const w = world();
  const { google } = fakeGoogle({ answers: [{ status: 403, body: { error: { message: "Forbidden" } } }] });
  await syncCalendar(w, { google });
  const when = { start: at(1, 9).toISOString(), end: at(1, 10).toISOString() };
  assert.deepEqual(byHand(w, "calendar.create", { account: "me@example.com", calendarId: "team", title: "Focus", when }), { error: "no_write" }, "a calendar they only read");
  assert.deepEqual(byHand(w, "calendar.create", { account: "me@example.com", calendarId: "me@example.com", title: "Focus", when: { start: when.end, end: when.start } }), { error: "bad_time" });
  const demo = event(w, "Vendor demo");
  assert.deepEqual(byHand(w, "calendar.edit", { account: demo.account, id: demo.id, title: "Mine now" }), { error: "not_yours" });
  assert.deepEqual(byHand(w, "calendar.edit", { account: demo.account, id: "me@example.com:nope", title: "x" }), { error: "gone" });
  assert.deepEqual(listOutbound(w), []);

  byHand(w, "calendar.edit", { account: "me@example.com", id: event(w, "Standup").id, notes: "Agenda: demo" });
  await deliverQueued(w, calendarModule, { google }, signal);
  assert.deepEqual(listNotices(w).filter((notice) => notice.kind === "outbound").map((notice) => [notice.payload.state, notice.payload.error]), [["failed", "Google refused (403) Forbidden"]]);
  assert.equal(event(w, "Standup").title, "Standup", "the mirror is as Google has it");
});

test("by hand: deleting an event the user organizes takes it out at once, tells its guests, and one already gone counts as done", async () => {
  const w = world();
  const { google, sent } = fakeGoogle({ answers: [{ status: 503 }, { status: 410 }] });
  await syncCalendar(w, { google });
  const standup = event(w, "Standup"), demo = event(w, "Vendor demo");
  assert.deepEqual(byHand(w, "calendar.delete", { account: demo.account, id: demo.id }), { error: "not_yours" });
  assert.equal(runTools(w, [calendarModule]).concat(assistantTools(w, [calendarModule])).some((tool) => /delete/.test(tool.name)), false, "a run cannot delete, even by proposing");

  byHand(w, "calendar.delete", { account: standup.account, id: standup.id });
  const [outbound] = listOutbound(w);
  assert.deepEqual([outbound.action, outbound.quiet, outbound.idempotent], ["delete", true, true]);
  assert.match(outbound.preview, /^Delete “Standup” \(.*\) \(tells 2 other guests\)$/);
  assert.deepEqual(snapshotOf(w).pending, [{ id: standup.id, account: standup.account, calendarId: standup.calendarId, added: false, removed: true }]);

  await deliverQueued(w, calendarModule, { google }, signal);
  assert.equal(listOutbound(w)[0].state, "queued", "Google was down: tried again");
  await deliverQueued(w, calendarModule, { google }, signal);
  assert.deepEqual([sent[1].method, sent[1].url, sent[1].body], ["DELETE", "/calendars/me%40example.com/events/standup?sendUpdates=all", undefined]);
  assert.equal(listOutbound(w)[0].state, "done", "410: the first try had deleted it");
  assert.equal(snapshotOf(w).events.some((candidate) => candidate.id === standup.id), false, "out of the mirror without a read");
  assert.deepEqual(listNotices(w).filter((notice) => notice.kind === "outbound"), []);
});

test("an event already in the calendar at that minute is not proposed again, unless the run says it is another one", async () => {
  const w = world();
  const { google } = fakeGoogle();
  await syncCalendar(w, { google });
  const propose = assistantTools(w, [calendarModule]).find((tool) => tool.name === "propose")!;
  const ask = (params: Record<string, unknown>) => propose.execute({ title: "Add?", summary: "", calls: [{ tool: "calendar_add", params }] }, signal);
  const twin = await ask({ title: "Daily standup", start: local(at(1, 9, 30)) });
  assert.match(twin, /already has “Standup”.*again: true/);
  assert.equal(listOpenProposals(w).length, 0);
  // Another meeting at the same minute, or an overlap at another minute, is only named, not refused.
  assert.match(await ask({ title: "Coffee", start: local(at(1, 9, 30)) }), /^Proposed/);
  assert.match(await ask({ title: "Another standup", start: local(at(1, 9, 30)), again: true }), /^Proposed/);
  assert.equal(listOpenProposals(w).length, 2);
});

test("two titles are the same event when they share a name, not just the kind of thing", () => {
  assert.ok(sameTitle("和张伟开会", "和张伟同步"));
  assert.ok(sameTitle("Daily standup", "Standup"));
  assert.ok(sameTitle("牙医。", "牙医"));
  assert.ok(!sameTitle("和导师开会", "组会"));
  assert.ok(!sameTitle("和张伟开会", "和张三吃饭"));
  assert.ok(!sameTitle("Lunch with Sarah", "Lunch with Tom"));
});
