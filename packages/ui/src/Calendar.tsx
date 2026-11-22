import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Proposal } from "@alfred/protocol";
import type { CalendarEvent, CalendarPending, CalendarSnapshot, CalendarSource, CalendarWhen } from "@alfred/module-calendar/types";
import { api } from "./api.ts";
import { Linked, OutLink } from "./Linked.tsx";
import { SourceBar } from "./SourceBar.tsx";
import { intlLocale, t, type Key } from "./i18n/index.ts";
import type { PageLine } from "./shell/about.ts";
import { Icon } from "./shell/icons.tsx";
import { Select } from "./shell/Select.tsx";
import { PHONE, useMedia } from "./shell/layout.ts";
import { eventChange } from "./shell/say.ts";

const HOUR = 48;
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const parse = (day: string) => { const [y, m, d] = day.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (day: string, n: number) => { const date = parse(day); date.setDate(date.getDate() + n); return ymd(date); };
/** Weeks start on Monday. */
const mondayOf = (day: string) => addDays(day, -((parse(day).getDay() + 6) % 7));
const firstOf = (day: string) => `${day.slice(0, 8)}01`;
const addMonths = (first: string, n: number) => { const date = parse(first); return ymd(new Date(date.getFullYear(), date.getMonth() + n, 1)); };
const hhmm = (iso: string) => { const date = new Date(iso); return `${pad(date.getHours())}:${pad(date.getMinutes())}`; };
const minutesOf = (iso: string) => { const date = new Date(iso); return date.getHours() * 60 + date.getMinutes(); };
const key = (event: Pick<CalendarEvent, "account" | "calendarId">) => `${event.account}|${event.calendarId}`;
const same = (a: Pick<CalendarEvent, "account" | "id">, b: Pick<CalendarEvent, "account" | "id">) => a.account === b.account && a.id === b.id;
const clock = (minutes: number) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
const minutesIn = (time: string) => { const [h, m] = time.split(":").map(Number); return h * 60 + m; };
const dayDiff = (from: string, to: string) => Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000);
const instant = (day: string, time: string) => { const date = parse(day); date.setHours(0, minutesIn(time)); return date; };

/** An event as the page draws it: one of the mirror's, one on its way to Google, or the one being typed. */
type Shown = CalendarEvent & { pending?: boolean; draft?: boolean; proposed?: { id: string; step: number; steps: number } };

/** What Alfred proposes to add or move, drawn where it would land: an open proposal's calendar steps as events of
 * their own, dashed until the user says yes (on the event itself, or in the inbox). */
function proposedEvents(proposals: readonly Proposal[], sources: CalendarSource[]): Shown[] {
  return proposals.flatMap((proposal) => proposal.state !== "open" || proposal.stale ? [] : proposal.steps.flatMap((step, n): Shown[] => {
    if (step.op !== "calendar.add" && step.op !== "calendar.move") return [];
    const input = step.input as { account?: string; calendarId?: string; calendar?: string; title?: string; when?: CalendarWhen };
    if (!input?.account || !input.calendarId || !input.title || !input.when) return [];
    const calendar = sources.find((source) => source.account === input.account)?.calendars.find((candidate) => candidate.id === input.calendarId);
    return [{
      id: `proposal:${proposal.id}:${n}`, account: input.account, calendarId: input.calendarId, calendar: input.calendar ?? calendar?.name ?? "", title: input.title,
      attendees: 0, k: calendar?.k ?? "gray", editable: false, invited: false, ...whenFields(input.when), proposed: { id: proposal.id, step: n, steps: proposal.steps.length },
    }];
  }));
}

/** When an event is, as the fields of an event. */
const whenFields = (when: CalendarWhen) => "date" in when
  ? { allDay: true, startDate: when.date, endDate: when.endDate, start: undefined, end: undefined }
  : { allDay: false, start: when.start, end: when.end, startDate: ymd(new Date(when.start)), endDate: ymd(new Date(Math.max(Date.parse(when.start), Date.parse(when.end) - 1))) };

/** The mirror's events with the changes Google has not answered yet laid over them. */
function withPending(events: CalendarEvent[], pending: CalendarPending[], sources: CalendarSource[]): Shown[] {
  if (!pending.length) return events;
  const shown: Shown[] = [...events];
  for (const change of pending) {
    if (change.removed) { const at = shown.findIndex((event) => same(event, change)); if (at >= 0) shown.splice(at, 1); continue; }
    const fields = {
      ...(change.title !== undefined ? { title: change.title } : {}), ...(change.location !== undefined ? { location: change.location || undefined } : {}),
      ...(change.when ? whenFields(change.when) : {}), ...(change.k ? { k: change.k } : {}), pending: true,
    };
    const index = shown.findIndex((event) => same(event, change));
    if (index >= 0) shown[index] = { ...shown[index], ...fields };
    else if (change.added && change.when) {
      const calendar = sources.find((source) => source.account === change.account)?.calendars.find((candidate) => candidate.id === change.calendarId);
      shown.push({ id: change.id, account: change.account, calendarId: change.calendarId, calendar: calendar?.name ?? "", title: "", attendees: 0, k: calendar?.k ?? "gray", editable: false, invited: false, ...whenFields(change.when), ...fields });
    }
  }
  return shown;
}

/** An event being typed: a new one, or one of the user's being changed. Times are the fields' own text. */
interface Draft {
  event?: CalendarEvent;
  account: string;
  calendarId: string;
  title: string;
  allDay: boolean;
  /** The first day; `endDate` is the last day of a whole-day event. */
  date: string;
  endDate: string;
  start: string;
  end: string;
  /** The days a timed event runs past its first, when that is more than an end after midnight (rare; kept as it is). */
  span: number;
  location: string;
  /** Null while an event's notes have not been read: then they are left alone. `notesWere`: as they were read. */
  notes: string | null;
  notesWere: string;
}

function draftOf(event: CalendarEvent): Draft {
  const timed = !event.allDay && !!event.start;
  const start = timed ? hhmm(event.start!) : "09:00", end = timed ? hhmm(event.end!) : "10:00";
  const days = timed ? dayDiff(event.startDate, ymd(new Date(event.end!))) : 0;
  return {
    event, account: event.account, calendarId: event.calendarId, title: event.title, allDay: !timed, date: event.startDate, endDate: event.endDate,
    start, end, span: days === 1 && end <= start ? 0 : days, location: event.location ?? "", notes: null, notesWere: "",
  };
}

/** Null while the fields do not make an event (a time half typed). An end at or before the start is the next day's. */
function draftWhen(draft: Draft): CalendarWhen | null {
  if (!draft.date) return null;
  if (draft.allDay) return { date: draft.date, endDate: draft.endDate >= draft.date ? draft.endDate : draft.date };
  if (!/^\d\d:\d\d$/.test(draft.start) || !/^\d\d:\d\d$/.test(draft.end)) return null;
  const start = instant(draft.date, draft.start), end = instant(addDays(draft.date, draft.span || (draft.end <= draft.start ? 1 : 0)), draft.end);
  return end > start ? { start: start.toISOString(), end: end.toISOString() } : null;
}

const eventWhen = (event: CalendarEvent): CalendarWhen => event.allDay || !event.start ? { date: event.startDate, endDate: event.endDate } : { start: event.start, end: event.end! };
const sameWhen = (a: CalendarWhen, b: CalendarWhen) => "date" in a
  ? "date" in b && a.date === b.date && a.endDate === b.endDate
  : !("date" in b) && Date.parse(a.start) === Date.parse(b.start) && Date.parse(a.end) === Date.parse(b.end);

/** A calendar the user may add to. */
interface Target { account: string; id: string; name: string; k: string }

/** An event that can be picked up and put down at another time on the week's grid: one made here in Alfred (by the
 * user or by Alfred: its id says so, modules/calendar newEventId), or one Alfred proposes and the user has not
 * answered yet; with a time, within one day, and settled. One that came from Google keeps to its editor, where
 * moving it says who will be told. */
const movable = (event: Shown) => !event.pending && !event.draft && !event.allDay && !!event.start && !!event.end && event.startDate === event.endDate
  && (!!event.proposed || (event.editable && !event.recurring && event.attendees <= 1 && event.id.slice(event.calendarId.length + 1).startsWith("alfred")));
/** In the grid: a timed event within one day. The rest (all-day, across midnight) go in the row above it. */
const inGrid = (event: CalendarEvent) => !event.allDay && !!event.start && event.startDate === event.endDate;

/** Side by side when they overlap: each event's lane and how many lanes its cluster needs. */
function lanes<E extends CalendarEvent>(events: E[]): Array<{ event: E; lane: number; of: number }> {
  const sorted = [...events].sort((a, b) => a.start!.localeCompare(b.start!) || b.end!.localeCompare(a.end!));
  const placed: Array<{ event: E; lane: number; of: number }> = [];
  let cluster: typeof placed = [], ends: string[] = [], clusterEnd = "";
  const close = () => { for (const item of cluster) item.of = ends.length; cluster = []; ends = []; };
  for (const event of sorted) {
    if (cluster.length && event.start! >= clusterEnd) close();
    let lane = ends.findIndex((end) => end <= event.start!);
    if (lane < 0) { lane = ends.length; ends.push(event.end!); } else ends[lane] = event.end!;
    clusterEnd = cluster.length ? (event.end! > clusterEnd ? event.end! : clusterEnd) : event.end!;
    const item = { event, lane, of: 1 };
    cluster.push(item);
    placed.push(item);
  }
  close();
  return placed;
}

function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  return now;
}

const whenText = (event: CalendarEvent) => event.allDay || !event.start
  ? `${event.startDate}${event.endDate !== event.startDate ? ` – ${event.endDate}` : ""} · ${t("cal.allDay")}`
  : `${parse(event.startDate).toLocaleDateString(intlLocale(), { weekday: "short", month: "short", day: "numeric" })} ${hhmm(event.start)} – ${hhmm(event.end!)}`;

/** What opens over the calendar: a card in the middle of the window, the page blurred behind it. One event's details,
 * the event being typed, and the question before a delete are all shown this way, one at a time in the same place.
 * Escape, or a click beside the card, puts it away. */
function Pop({ onClose, children }: { onClose(): void; children: ReactNode }) {
  useEffect(() => {
    const escape = (press: KeyboardEvent) => { if (press.key === "Escape" && !press.isComposing) onClose(); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  });
  return createPortal(
    <div className="ev-pop" role="presentation" onMouseDown={(down) => { if (down.target === down.currentTarget) onClose(); }}>{children}</div>,
    document.body,
  );
}

function EventCard({ event, onClose, onEdit, onDelete, onSay }: { event: Shown; onClose(): void; onEdit?: () => void; onDelete?: () => void; onSay?: () => void }) {
  const when = whenText(event);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Yes or no to Alfred's proposal, from where it would land. */
  const decide = (yes: boolean) => {
    if (!event.proposed) return;
    setBusy(true);
    setError(null);
    (yes ? api.accept(event.proposed.id) : api.decline(event.proposed.id)).then(onClose, (reason: Error) => { setError(reason.message); setBusy(false); });
  };
  return (
    <div className="ev-edit ev-view" data-k={event.k} role="dialog" aria-modal="true" aria-label={event.title}>
      <div className="ev-card-head">
        <b><span className="mark" data-k={event.k} />{event.title}</b>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close")} autoFocus>×</button>
      </div>
      <p>{when}</p>
      {event.location && <p><Linked text={event.location} /></p>}
      <p className="quiet">
        {event.calendar}
        {event.attendees > 1 && ` · ${t("cal.attendees", { n: event.attendees })}`}
        {event.response === "declined" && ` · ${t("cal.declined")}`}
        {event.response === "needsAction" && ` · ${t("cal.unanswered")}`}
      </p>
      <p className="ev-card-links">
        {onEdit && <button type="button" className="link" onClick={onEdit}>{t("cal.edit")}</button>}
        {/* Words about it go in the line under the page: the card steps aside. */}
        {onSay && <button type="button" className="link" onClick={onSay}>{t("say.open")}</button>}
        {onDelete && <button type="button" className="link ev-delete" onClick={onDelete}>{t("cal.delete")}</button>}
        {event.meeting && <OutLink href={event.meeting}>{t("cal.join")}</OutLink>}
        {event.link && <OutLink href={event.link}>{t("cal.open")}</OutLink>}
        {event.pending && <span className="quiet">{t("cal.pending")}</span>}
      </p>
      {event.proposed && (
        <>
          <p className="quiet">{t("cal.proposed")}</p>
          <div className="ev-foot">
            <span className={error ? "ev-error" : undefined} role={error ? "alert" : undefined}>{error}</span>
            <button type="button" className="ghost" disabled={busy} onClick={() => decide(false)}>{t("common.no")}</button>
            <button type="button" disabled={busy} onClick={() => decide(true)}>{event.proposed.steps > 1 ? t("inbox.acceptN", { n: event.proposed.steps }) : t("inbox.accept")}</button>
          </div>
        </>
      )}
    </div>
  );
}

/** Deleting an event cannot be taken back from here, so it is asked once, in the same kind of card over the page:
 * what goes, when it was, and who hears of it. */
function DeleteAsk({ event, onClose, onDeleted }: { event: CalendarEvent; onClose(): void; onDeleted(change: CalendarPending): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = () => {
    setBusy(true);
    setError(null);
    api.op("calendar.delete", { account: event.account, id: event.id }).then((response) => {
      const result = response.result as { error?: string };
      if (result.error && result.error !== "gone") return setError(t(`cal.err.${result.error}` as Key));
      onDeleted({ id: event.id, account: event.account, calendarId: event.calendarId, added: false, removed: true });
      onClose();
    }).catch((reason: Error) => setError(reason.message)).finally(() => setBusy(false));
  };
  const hint = event.attendees > 1 ? t("cal.tellsGuests", { n: event.attendees - 1 }) : event.recurring ? t("cal.deleteOne") : "";
  return (
    <div className="ev-edit ev-ask" data-k={event.k} role="alertdialog" aria-modal="true" aria-label={t("cal.deleteAsk", { title: event.title })}>
      <b>{t("cal.deleteAsk", { title: event.title })}</b>
      <p>{whenText(event)}{hint && ` · ${hint}`}</p>
      <div className="ev-foot">
        <span className={error ? "ev-error" : undefined} role={error ? "alert" : undefined}>{error}</span>
        <button type="button" className="ghost" onClick={onClose} autoFocus>{t("common.cancel")}</button>
        <button type="button" className="danger" disabled={busy} onClick={remove}>{t(busy ? "cal.deleting" : "cal.delete")}</button>
      </div>
    </div>
  );
}

/** The event being typed: its title, when it is, where it goes, and Save. Saving is the user's yes: it goes to Google
 * with no proposal in between, and `onSaved` gets what to draw until Google answers. */
function EventEditor({ draft, targets, k, range, onChange, onClose, onSaved, onDelete }: {
  draft: Draft; targets: Target[]; k: string; range: { from: string; to: string };
  onChange(next: Draft): void; onClose(): void; onSaved(change: CalendarPending): void; onDelete?: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const event = draft.event;
  const when = draftWhen(draft);
  const set = (fields: Partial<Draft>) => { setError(null); onChange({ ...draft, ...fields }); };
  /** Moving the start keeps the length. */
  const setStart = (start: string) => {
    if (!/^\d\d:\d\d$/.test(start) || !/^\d\d:\d\d$/.test(draft.start) || !/^\d\d:\d\d$/.test(draft.end)) return set({ start });
    const length = (minutesIn(draft.end) - minutesIn(draft.start) + 1440) % 1440 || 60;
    set({ start, end: clock((minutesIn(start) + length) % 1440) });
  };
  const setDate = (date: string) => set({ date, endDate: date && draft.date && draft.endDate >= draft.date ? addDays(date, dayDiff(draft.date, draft.endDate)) : date });
  const wraps = !draft.allDay && !draft.span && !!when && draft.end <= draft.start;

  const save = (submit?: FormEvent) => {
    submit?.preventDefault();
    const title = draft.title.trim(), location = draft.location.trim(), notes = draft.notes?.trim();
    if (!when || !title || saving) return;
    let op: string, input: Record<string, unknown>, change: CalendarPending;
    if (event) {
      const changes = {
        ...(title !== event.title ? { title } : {}), ...(sameWhen(when, eventWhen(event)) ? {} : { when }),
        ...(location !== (event.location ?? "") ? { location } : {}), ...(notes !== undefined && notes !== draft.notesWere.trim() ? { notes } : {}),
      };
      if (!Object.keys(changes).length) return onClose();
      op = "calendar.edit";
      input = { account: event.account, id: event.id, ...changes };
      change = { id: event.id, account: event.account, calendarId: event.calendarId, added: false, ...changes };
    } else {
      op = "calendar.create";
      input = { account: draft.account, calendarId: draft.calendarId, title, when, ...(location ? { location } : {}), ...(notes ? { notes } : {}) };
      change = { id: "", account: draft.account, calendarId: draft.calendarId, added: true, title, when, ...(location ? { location } : {}) };
    }
    setSaving(true);
    setError(null);
    api.op(op, input).then((response) => {
      const result = response.result as { id?: string; k?: string; error?: string };
      if (result.error && result.error !== "nothing") return setError(t(`cal.err.${result.error}` as Key));
      if (!result.error) onSaved({ ...change, id: result.id ?? change.id, ...(result.k ? { k: result.k } : {}) });
      onClose();
    }).catch((reason: Error) => setError(reason.message)).finally(() => setSaving(false));
  };

  const hint = event && event.attendees > 1 ? t("cal.tellsGuests", { n: event.attendees - 1 }) : event?.recurring ? t("cal.onlyThis") : "";
  return (
    <form className="ev-edit" data-k={k} role="dialog" aria-modal="true" aria-label={t(event ? "cal.edit" : "cal.newEvent")} onSubmit={save}
      onKeyDown={(press) => { if (!press.nativeEvent.isComposing && press.key === "Enter" && (press.metaKey || press.ctrlKey)) save(); }}>
      <div className="ev-card-head">
        <input className="ev-title" value={draft.title} onChange={(change) => set({ title: change.target.value })} placeholder={t("cal.title")} aria-label={t("cal.title")} maxLength={300} autoFocus />
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close")}>×</button>
      </div>
      <div className="ev-when">
        <input type="date" value={draft.date} min={event ? undefined : range.from} max={event ? undefined : range.to} onChange={(change) => setDate(change.target.value)} aria-label={t("cal.date")} required />
        {draft.allDay ? (
          <><span>–</span><input type="date" value={draft.endDate} min={draft.date} onChange={(change) => set({ endDate: change.target.value })} aria-label={t("cal.endDate")} required /></>
        ) : (
          <>
            <span className="ev-times">
              <input type="time" value={draft.start} onChange={(change) => setStart(change.target.value)} aria-label={t("cal.start")} required />
              <span>–</span>
              <input type="time" value={draft.end} onChange={(change) => set({ end: change.target.value })} aria-label={t("cal.end")} required />
            </span>
            {wraps && <span className="quiet">{t("cal.nextDay")}</span>}
            {draft.span > 0 && <span className="quiet">{t("cal.plusDays", { n: draft.span })}</span>}
          </>
        )}
        <label className="ev-allday"><input type="checkbox" aria-label={t("cal.allDay")} checked={draft.allDay} onChange={(change) => set({ allDay: change.target.checked, span: 0, endDate: draft.endDate >= draft.date ? draft.endDate : draft.date })} />{t("cal.allDay")}</label>
      </div>
      {!event && targets.length > 1 && (
        <Select className="ev-field field-select" value={`${draft.account}|${draft.calendarId}`} label={t("cal.calendar")}
          onChange={(next) => { const target = targets.find((candidate) => key({ account: candidate.account, calendarId: candidate.id }) === next); if (target) set({ account: target.account, calendarId: target.id }); }}
          options={targets.map((target) => ({ value: `${target.account}|${target.id}`, label: `${target.name}${targets.some((other) => other.account !== target.account) ? ` · ${target.account}` : ""}` }))} />
      )}
      <input className="ev-field" value={draft.location} onChange={(change) => set({ location: change.target.value })} placeholder={t("cal.location")} aria-label={t("cal.location")} maxLength={300} />
      <textarea className="ev-field" rows={2} value={draft.notes ?? ""} disabled={draft.notes === null} onChange={(change) => set({ notes: change.target.value })} placeholder={t("cal.notes")} aria-label={t("cal.notes")} maxLength={4000} />
      <div className="ev-foot">
        {onDelete && <button type="button" className="ghost ev-delete" onClick={onDelete}>{t("cal.delete")}</button>}
        <span className={error ? "ev-error" : "quiet"} role={error ? "alert" : undefined}>{error ?? hint}</span>
        <button type="button" className="ghost" onClick={onClose}>{t("common.cancel")}</button>
        <button type="submit" disabled={!when || !draft.title.trim() || saving}>{t(saving ? "cal.saving" : "cal.save")}</button>
      </div>
    </form>
  );
}

/** The calendars this device has hidden: remembered, since the card that shows them is closed most of the time. */
const HIDDEN_KEY = "alfred.calendar.hidden";
function savedHidden(): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch { return new Set(); }
}

/** At most this many colour dots on the button; the card has every calendar. */
const DOTS = 4;

/** Which calendars are shown. They are set once and then left alone, so they are not a row of the page: a small
 * button at the end of the source's row (their colours, and how many are on when some are off), and a card of them
 * under it. */
function CalendarPicker({ sources, hidden, onToggle }: { sources: CalendarSource[]; hidden: ReadonlySet<string>; onToggle(key: string): void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  const all = sources.flatMap((source) => source.calendars.map((calendar) => ({ ...calendar, key: `${source.account}|${calendar.id}` })));
  const on = all.filter((calendar) => !hidden.has(calendar.key)).length;
  const mark = (calendar: (typeof all)[number]) => (
    <span key={calendar.key} className={hidden.has(calendar.key) ? "mark dim" : "mark"} data-k={calendar.varied ? undefined : calendar.k} data-varied={calendar.varied || undefined} />
  );
  return (
    <div className="cal-pick" ref={root}>
      <button type="button" className="cal-pick-btn" aria-haspopup="menu" aria-expanded={open} aria-label={`${t("cal.calendars")} ${on}/${all.length}`} onClick={() => setOpen(!open)}>
        <span className="cal-dots">{all.slice(0, DOTS).map(mark)}</span>
        <span className="cal-pick-name">{t("cal.calendars")}</span>
        {on < all.length && <span className="count">{on}/{all.length}</span>}
        <Icon name="down" />
      </button>
      {open && (
        <div className="cal-card" role="menu" aria-label={t("cal.calendars")}>
          {sources.map((source) => (
            <div key={source.account} role="group" aria-label={source.account}>
              {sources.length > 1 && <p className="cal-card-label">{source.account}</p>}
              {source.calendars.map((calendar) => {
                const item = { ...calendar, key: `${source.account}|${calendar.id}` };
                return (
                  <button type="button" key={item.key} role="menuitemcheckbox" aria-checked={!hidden.has(item.key)} onClick={() => onToggle(item.key)} title={t("cal.hide", { name: calendar.name })}>
                    {mark(item)}<span>{calendar.name}</span><Icon name="check" />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type View = "today" | "week" | "month";
const VIEW_KEY = "alfred.calendar.view";
function savedView(): View {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === "today" || saved === "week" || saved === "month") return saved;
  } catch { /* use the device default */ }
  return window.matchMedia(PHONE).matches ? "today" : "week";
}

function AgendaEvent({ event, time, past, status, onOpen }: {
  event: Shown; time: string; past?: boolean; status?: "current" | "next"; onOpen(event: Shown): void;
}) {
  return (
    <button type="button" className="agenda-ev" data-k={event.k} data-declined={event.response === "declined" || undefined}
      data-pending={event.pending || undefined} data-draft={event.draft || undefined} data-proposed={!!event.proposed || undefined}
      data-past={past || undefined} data-status={status} onClick={() => onOpen(event)}>
      <span className="mark" data-k={event.k} /><time>{time}</time>
      <span className="agenda-title">{event.title}</span>
      {status && <small className="agenda-status">{t(`cal.status.${status}`)}</small>}
    </button>
  );
}

function timeOnDay(event: Shown, day: string) {
  if (event.allDay || !event.start || !event.end) return t("cal.allDay");
  const start = event.startDate < day ? "00:00" : hhmm(event.start);
  const end = event.endDate > day || hhmm(event.end) === "00:00" ? "24:00" : hhmm(event.end);
  return `${start}–${end}`;
}

function TodayAgenda({ events, today, now, onOpen }: { events: Shown[]; today: string; now: number; onOpen(event: Shown): void }) {
  const sorted = [...events].sort((a, b) => Number(b.allDay) - Number(a.allDay)
    || (a.start && b.start ? Date.parse(a.start) - Date.parse(b.start) : a.title.localeCompare(b.title)));
  const scheduled = sorted.filter((event) => !event.allDay && event.start && event.end && event.response !== "declined" && !event.draft && !event.proposed);
  const current = new Set(scheduled.filter((event) => Date.parse(event.start!) <= now && now < Date.parse(event.end!)));
  const next = current.size === 0 ? scheduled.find((event) => Date.parse(event.start!) > now) : undefined;
  return (
    <ol className="agenda agenda-today">
      {sorted.map((event) => {
        return (
          <li key={`${event.account}|${event.id}`}>
            <AgendaEvent event={event} time={timeOnDay(event, today)} past={!event.draft && !!event.end && Date.parse(event.end) <= now}
              status={current.has(event) ? "current" : event === next ? "next" : undefined} onOpen={onOpen} />
          </li>
        );
      })}
    </ol>
  );
}

/** How tall a day's number and one of its events are in the month, for working out how many events a day has room for. */
const MONTH_HEAD = 32, MONTH_ROW = 22;

/** A month as weeks of days: each day's events by name, as many as its box has room for, and how many more there
 * are. A day's number opens its week; an empty part of the day starts a new event on it. In a narrow page a day is
 * its number over a dot per colour, and the whole of it opens its week. */
function MonthGrid({ days, month, today, events, known, canAdd, onOpen, onAdd, onDay }: {
  days: string[]; month: string; today: string; events: Shown[];
  known(day: string): boolean; canAdd(day: string): boolean; onOpen(event: Shown): void; onAdd(day: string): void; onDay(day: string): void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(3);
  const weeks = days.length / 7;
  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () => setRoom(Math.max(2, Math.floor((element.clientHeight / weeks - MONTH_HEAD) / MONTH_ROW)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [weeks]);
  const label = (day: string, options: Intl.DateTimeFormatOptions) => parse(day).toLocaleDateString(intlLocale(), options);
  return (
    <div className="month-grid">
      <div className="mo-head">{days.slice(0, 7).map((day) => <span key={day}>{label(day, { weekday: "short" })}</span>)}</div>
      <div className="mo-body" ref={body}>
        {days.map((day) => {
          const todays = events.filter((event) => event.startDate <= day && event.endDate >= day);
          const fits = todays.length > room ? room - 1 : todays.length;
          const whole = label(day, { month: "short", day: "numeric" });
          return (
            <div key={day} className="mo-cell" data-today={day === today || undefined} data-past={day < today || undefined} data-other={!day.startsWith(month.slice(0, 7)) || undefined}
              data-weekend={parse(day).getDay() % 6 === 0 || undefined} data-unread={!known(day) || undefined} data-open={canAdd(day) || undefined}
              onClick={(click) => {
                if (click.target !== click.currentTarget) return;
                // In a narrow page (the dots are what shows) a day is one thing to tap.
                if (click.currentTarget.querySelector<HTMLElement>(".mo-dots")?.offsetParent) onDay(day);
                else if (canAdd(day)) onAdd(day);
              }}>
              <button type="button" className="mo-day" onClick={() => onDay(day)} aria-label={t("cal.openDay", { day: whole })}>{day.endsWith("-01") ? whole : parse(day).getDate()}</button>
              {todays.slice(0, fits).map((event) => inGrid(event) ? (
                <button type="button" key={event.id} className="mo-ev" data-k={event.k} data-declined={event.response === "declined" || undefined}
                  data-pending={event.pending || undefined} data-draft={event.draft || undefined} data-proposed={!!event.proposed || undefined} onClick={() => onOpen(event)}>
                  <span className="mark" data-k={event.k} /><time>{hhmm(event.start!)}</time><span>{event.title}</span>
                </button>
              ) : (
                <button type="button" key={event.id} className="ev ev-chip" data-k={event.k} data-declined={event.response === "declined" || undefined}
                  data-pending={event.pending || undefined} data-draft={event.draft || undefined} data-proposed={!!event.proposed || undefined} onClick={() => onOpen(event)}>{event.title}</button>
              ))}
              {todays.length > fits && <button type="button" className="mo-more" onClick={() => onDay(day)}>{t("cal.more", { n: todays.length - fits })}</button>}
              <span className="mo-dots" aria-hidden="true">{[...new Set(todays.map((event) => event.k))].slice(0, 4).map((k) => <span key={k} className="mark" data-k={k} />)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The calendar page: today's agenda, a week of hours, or a month of days. */
export function Calendar({ snapshot, line, proposals }: { snapshot: CalendarSnapshot | undefined; line?: PageLine; proposals?: readonly Proposal[] }) {
  const today = snapshot?.today ?? ymd(new Date());
  const phone = useMedia(PHONE);
  const [view, setView] = useState<View>(savedView);
  const [week, setWeek] = useState(() => mondayOf(today));
  /** The month shown, as its first day. */
  const [month, setMonth] = useState(() => firstOf(today));
  const [hidden, setHidden] = useState<ReadonlySet<string>>(savedHidden);
  const [picked, setPicked] = useState<Pick<CalendarEvent, "account" | "id"> | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** What was just saved, drawn until the next snapshot (which has it: on its way, or already Google's). */
  const [sent, setSent] = useState<CalendarPending[]>([]);
  const [noWrite, setNoWrite] = useState(false);
  /** The event the user is being asked about deleting. */
  const [removing, setRemoving] = useState<CalendarEvent | null>(null);
  /** While a new event is being dragged out on the grid: its day and minutes. */
  const [stretch, setStretch] = useState<{ day: string; from: number; to: number } | null>(null);
  const press = useRef<{ day: string; at: number; byMouse: boolean } | null>(null);
  /** While an event is being carried across the grid: where it would be put down. */
  const [carry, setCarry] = useState<{ event: Shown; day: string; start: number } | null>(null);
  const grip = useRef<{ event: Shown; x: number; y: number; was: number; moved: boolean } | null>(null);
  /** The click that ends a carry is not a click on the event. */
  const carried = useRef(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  /** Where proposed events were just put down, drawn there until the proposals come back with it. */
  const [retimed, setRetimed] = useState<Record<string, CalendarWhen>>({});
  useEffect(() => setRetimed({}), [proposals]);
  const scroller = useRef<HTMLDivElement>(null);
  const now = useNow();
  const sources = snapshot?.sources ?? [];
  const calendarCount = sources.reduce((sum, source) => sum + source.calendars.length, 0);
  useEffect(() => setSent([]), [snapshot]);

  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(week, index)), [week]);
  /** The month's weeks, whole: from the Monday on or before its first day. */
  const monthDays = useMemo(() => {
    const start = mondayOf(month);
    const weeks = Math.ceil((dayDiff(start, addDays(addMonths(month, 1), -1)) + 1) / 7);
    return Array.from({ length: weeks * 7 }, (_, index) => addDays(start, index));
  }, [month]);
  /** The days on the page. */
  const visible = view === "today" ? [today] : view === "month" ? monthDays : days;
  const first = visible[0], last = visible[visible.length - 1];
  /** Where a new event may go: the calendars the user may change, their main one first. And when: the days the mirror
   * holds, since an event outside them would not be seen again here. */
  const targets: Target[] = sources.flatMap((source) => source.canWrite ? source.calendars.filter((calendar) => calendar.writable).map((calendar) => ({ account: source.account, id: calendar.id, name: calendar.name, k: calendar.k })) : []);
  const range = { from: snapshot?.from ?? addDays(today, -7), to: snapshot?.to ?? addDays(today, 35) };
  const inRange = (day: string) => day >= range.from && day <= range.to;
  const outside = first > range.to || last < range.from;

  const events = useMemo(() => [
    ...withPending(snapshot?.events ?? [], [...(snapshot?.pending ?? []), ...sent], sources),
    ...proposedEvents(proposals ?? [], sources).map((event) => (retimed[event.id] ? { ...event, ...whenFields(retimed[event.id]) } : event)),
  ], [snapshot, sent, proposals, retimed]);
  const pickedEvent = picked ? events.find((event) => same(event, picked)) ?? null : null;
  const draftWhenNow = draft ? draftWhen(draft) : null;
  const draftTarget = draft && targets.find((target) => target.account === draft.account && target.id === draft.calendarId);
  const draftK = draft?.event?.k ?? draftTarget?.k ?? "gray";
  const drawn: Shown[] = draft && draftWhenNow
    ? [...events.filter((event) => !draft.event || !same(event, draft.event)), {
        ...(draft.event ?? { id: "draft", account: draft.account, calendarId: draft.calendarId, calendar: draftTarget?.name ?? "", attendees: 0, k: draftK, editable: false, invited: false }),
        title: draft.title.trim() || t("cal.newEvent"), location: draft.location.trim() || undefined, ...whenFields(draftWhenNow), draft: true,
      }]
    : events;
  const shown = drawn.filter((event) => (event.draft || event.proposed || !hidden.has(key(event))) && event.endDate >= first && event.startDate <= last)
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || Number(inGrid(a)) - Number(inGrid(b)) || (a.start ?? "").localeCompare(b.start ?? ""));
  const dayGrid = phone && view === "today" && !outside && (sources.length > 0 || shown.length > 0);
  // On a single day, timed events that cross midnight occupy just the hours they cover today.
  const onTimeline = dayGrid ? (event: Shown) => !event.allDay && !!event.start && !!event.end : inGrid;
  const timed = shown.filter(onTimeline);
  const banner = shown.filter((event) => !onTimeline(event));
  const startMinute = (event: Shown) => event.startDate < first ? 0 : minutesOf(event.start!);
  const endMinute = (event: Shown) => event.endDate > last ? 1440 : minutesOf(event.end!) || 1440;
  const nowDate = new Date(now);
  const from = Math.min(8, dayGrid ? nowDate.getHours() : 8, ...timed.map((event) => Math.floor(startMinute(event) / 60)));
  const to = Math.max(20, dayGrid ? nowDate.getHours() + 1 : 20, ...timed.map((event) => Math.ceil(endMinute(event) / 60)));
  const hours = Array.from({ length: to - from }, (_, index) => from + index);

  // Open on the morning, or on now when it is later.
  useEffect(() => {
    const at = dayGrid || week === mondayOf(today) ? Math.max(from, new Date().getHours() - 1) : Math.max(from, 8);
    if (scroller.current) scroller.current.scrollTop = (at - from) * HOUR;
  }, [week, from, today, view, dayGrid]);

  const label = (day: string, options: Intl.DateTimeFormatOptions) => parse(day).toLocaleDateString(intlLocale(), options);
  const toggle = (calendar: string) => setHidden((current) => {
    const next = new Set(current);
    if (!next.delete(calendar)) next.add(calendar);
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next])); } catch { /* this view only */ }
    return next;
  });
  const nowTop = ((nowDate.getHours() - from) * 60 + nowDate.getMinutes()) / 60 * HOUR;

  const show = (next: View, day?: string) => {
    // Today always opens on the snapshot's date. Week and month share the current browsing position.
    if (next === view && !day) return;
    const here = today >= first && today <= last;
    if (next === "month") setMonth(firstOf(day ?? (here ? today : addDays(week, 3))));
    if (next === "week") setWeek(mondayOf(day ?? (here ? today : month)));
    setView(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* this view only */ }
  };
  const step = (n: number) => (view === "month" ? setMonth(addMonths(month, n)) : setWeek(addDays(week, 7 * n)));
  const atNow = view === "month" ? month === firstOf(today) : week === mondayOf(today);
  const open = (event: Shown) => { if (event.draft) return; setDraft(null); setNoWrite(false); setPicked({ account: event.account, id: event.id }); };
  const edit = (event: CalendarEvent) => { setPicked(null); setDraft(draftOf(event)); };
  const askDelete = (event: CalendarEvent) => { setDraft(null); setRemoving(event); };
  const sentOne = (change: CalendarPending) => setSent((current) => [...current, change]);
  /** Puts an event in the line under the page: a day, an hour or "an hour later" moves it at once (shell/say.ts),
   * as saving it in the editor would; words that say more go to Alfred with the event. */
  const say = (event: Shown) => {
    if (!line) return;
    setPicked(null);
    const nextMonday = addDays(mondayOf(today), 7);
    line.attach({
      key: `cal:say:${event.account}|${event.id}`, label: event.title.length > 24 ? `${event.title.slice(0, 23)}…` : event.title, placeholder: t("say.placeholder"),
      chips: [...(event.allDay ? [] : [t("say.later")]), t("todo.tomorrow"), t("todo.nextWeekday", { day: t("todo.weekdays").split(",")[parse(nextMonday).getDay()] })],
      send: async (words) => {
        const when = eventChange(words, today, event);
        if (!when) { await line.ask(t("say.goal.event", { title: event.title, when: whenText(event), text: words }), { id: `calendar:${event.id}`, title: event.title.slice(0, 200) }); return; }
        const result = (await api.op("calendar.edit", { account: event.account, id: event.id, when })).result as { error?: string };
        if (result.error && result.error !== "nothing") throw new Error(t(`cal.err.${result.error}` as Key));
        if (!result.error) sentOne({ id: event.id, account: event.account, calendarId: event.calendarId, added: false, when });
      },
    });
  };
  /** A new event on `day` from minute `at` to `until`. One already being typed is put there instead: placing it is
   * part of typing it. An event being changed stays where its fields say. */
  const place = (day: string, at: number, until: number) => {
    if (!targets.length) return setNoWrite(sources.length > 0);
    if (!inRange(day) || draft?.event) return;
    const time = { allDay: false, date: day, endDate: day, start: clock(at), end: clock(until), span: 0 };
    setPicked(null);
    setDraft(draft ? { ...draft, ...time } : { account: targets[0].account, calendarId: targets[0].id, title: "", location: "", notes: "", notesWere: "", ...time });
  };
  /** From the button, or a day of the list: the coming hour today, nine on another day. */
  const add = (day?: string) => {
    const on = day ?? (today >= first && today <= last ? today : view === "month" && inRange(month) ? month : visible.find(inRange) ?? today);
    const at = on === today ? Math.min(23, new Date().getHours() + 1) * 60 : 9 * 60;
    place(on, at, at + 60);
  };

  // An event's notes are read when it is opened to be changed; until then (or if they cannot be) they are left alone.
  const editing = draft?.event;
  useEffect(() => {
    if (!editing) return;
    let live = true;
    api.query<{ notes?: string }>("calendar.event", { account: editing.account, id: editing.id }).then((answer) => {
      if (live && typeof answer.notes === "string") setDraft((current) => current?.event && same(current.event, editing) && current.notes === null ? { ...current, notes: answer.notes!, notesWere: answer.notes! } : current);
    }).catch(() => {});
    return () => { live = false; };
  }, [editing?.account, editing?.id]);

  // On the grid: a click on an empty hour starts an hour-long event there; with a mouse, dragging sets its length.
  const minuteAt = (column: HTMLElement, y: number) => Math.max(from * 60, Math.min(to * 60, from * 60 + (y - column.getBoundingClientRect().top) / HOUR * 60));
  const snap = (minute: number) => Math.round(minute / 15) * 15;
  const span = (anchor: number, minute: number): [number, number] => Math.abs(snap(minute) - snap(anchor)) < 15
    ? [Math.floor(anchor / 30) * 30, Math.min(24 * 60, Math.floor(anchor / 30) * 30 + 60)]
    : [Math.min(snap(anchor), snap(minute)), Math.max(snap(anchor), snap(minute))];
  const grid = (day: string) => ({
    onPointerDown(down: ReactPointerEvent<HTMLDivElement>) {
      if (down.button !== 0 || down.target !== down.currentTarget) return;
      const byMouse = down.pointerType === "mouse";
      press.current = { day, at: minuteAt(down.currentTarget, down.clientY), byMouse };
      if (byMouse && targets.length && inRange(day) && !draft?.event) down.currentTarget.setPointerCapture(down.pointerId);
    },
    onPointerMove(move: ReactPointerEvent<HTMLDivElement>) {
      const held = press.current;
      if (!held?.byMouse || held.day !== day || !move.currentTarget.hasPointerCapture(move.pointerId)) return;
      const [a, b] = span(held.at, minuteAt(move.currentTarget, move.clientY));
      if (stretch || Math.abs(snap(minuteAt(move.currentTarget, move.clientY)) - snap(held.at)) >= 15) setStretch({ day, from: a, to: b });
    },
    onPointerUp(up: ReactPointerEvent<HTMLDivElement>) {
      const held = press.current;
      press.current = null;
      setStretch(null);
      if (!held || held.day !== day || up.target !== up.currentTarget) return;
      const [a, b] = span(held.at, held.byMouse ? minuteAt(up.currentTarget, up.clientY) : held.at);
      place(day, a, b);
    },
    onPointerCancel() { press.current = null; setStretch(null); },
  });

  // On the grid, with a mouse: an event made in Alfred is carried to another hour or day and put down there. It keeps
  // its length, moves by quarter hours, and goes to Google as a change saved in the editor would. One Alfred only
  // proposes is moved the same way and stays a proposal, at its new time (calendar.retime).
  const carrier = (event: Shown) => !movable(event) ? {} : {
    onPointerDown(down: ReactPointerEvent<HTMLButtonElement>) {
      if (down.button !== 0 || down.pointerType !== "mouse") return;
      grip.current = { event, x: down.clientX, y: down.clientY, was: minutesOf(event.start!), moved: false };
      down.currentTarget.setPointerCapture(down.pointerId);
    },
    onPointerMove(move: ReactPointerEvent<HTMLButtonElement>) {
      const held = grip.current;
      if (!held || !move.currentTarget.hasPointerCapture(move.pointerId)) return;
      if (!held.moved && Math.hypot(move.clientX - held.x, move.clientY - held.y) < 5) return;
      held.moved = true;
      const length = (Date.parse(event.end!) - Date.parse(event.start!)) / 60_000;
      const start = Math.max(0, Math.min(24 * 60 - length, snap(held.was + (move.clientY - held.y) / HOUR * 60)));
      // The day whose column the pointer is over; outside the grid, the day it was last over.
      const columns = [...(move.currentTarget.closest(".wk-body")?.querySelectorAll<HTMLElement>(".wk-col") ?? [])];
      const over = columns.findIndex((column) => { const box = column.getBoundingClientRect(); return move.clientX >= box.left && move.clientX < box.right; });
      const day = over >= 0 && inRange(visible[over]) ? visible[over] : carry?.day ?? event.startDate;
      setMoveError(null);
      setCarry({ event, day, start });
    },
    onPointerUp() {
      const held = grip.current, put = carry;
      grip.current = null;
      setCarry(null);
      if (!held?.moved) return;
      // The click that may follow this release is the carry's end; any later click is a click again.
      carried.current = true;
      window.setTimeout(() => { carried.current = false; }, 80);
      if (!put || (put.day === event.startDate && put.start === held.was)) return;
      const length = Date.parse(event.end!) - Date.parse(event.start!);
      const start = instant(put.day, clock(put.start));
      const when = { start: start.toISOString(), end: new Date(start.getTime() + length).toISOString() };
      const refused = (response: { result: unknown }) => {
        const result = response.result as { error?: string };
        if (result.error && result.error !== "nothing") throw new Error(t(`cal.err.${result.error}` as Key));
      };
      if (event.proposed) {
        const forget = () => setRetimed(({ [event.id]: _, ...rest }) => rest);
        setRetimed((current) => ({ ...current, [event.id]: when }));
        api.op("calendar.retime", { proposal: event.proposed.id, step: event.proposed.step, when }).then(refused).catch((reason: Error) => { forget(); setMoveError(reason.message); });
        return;
      }
      // Drawn there at once, as one on its way; taken back if it is refused.
      const change: CalendarPending = { id: event.id, account: event.account, calendarId: event.calendarId, added: false, when };
      sentOne(change);
      api.op("calendar.edit", { account: event.account, id: event.id, when }).then(refused).catch((reason: Error) => { setSent((current) => current.filter((one) => one !== change)); setMoveError(reason.message); });
    },
    onPointerCancel() { grip.current = null; setCarry(null); },
  };

  return (
    <section className="calendar" aria-label={t("page.calendar")}>
      <SourceBar module="calendar" mark="google-calendar" sources={sources} notConnected={t("src.notConnected.cal")}>
        {calendarCount > 1 && <CalendarPicker sources={sources} hidden={hidden} onToggle={toggle} />}
      </SourceBar>
      <div className="cal-bar">
        {view !== "today" && <div className="cal-nav">
          <button type="button" className="icon-btn" onClick={() => step(-1)} aria-label={t(view === "month" ? "cal.prevMonth" : "cal.prev")}>‹</button>
          <button type="button" className="ghost small" disabled={atNow} onClick={() => (view === "month" ? setMonth(firstOf(today)) : setWeek(mondayOf(today)))}>{t(view === "month" ? "cal.thisMonth" : "cal.thisWeek")}</button>
          <button type="button" className="icon-btn" onClick={() => step(1)} aria-label={t(view === "month" ? "cal.nextMonth" : "cal.next")}>›</button>
        </div>}
        <b className="cal-period">{view === "today" ? label(today, { weekday: "short", month: "short", day: "numeric" })
          : view === "month" ? label(month, { year: "numeric", month: "long" })
          : t("cal.week", { from: label(week, { month: "short", day: "numeric" }), to: label(days[6], { month: "short", day: "numeric" }) })}</b>
        <div className="cal-tools">
          <div className="mode-switch cal-view" role="group" aria-label={t("cal.view")}>
            {(["today", "week", "month"] as const).map((each) => <button type="button" key={each} aria-pressed={view === each} onClick={() => show(each)}>{t(`cal.view.${each}`)}</button>)}
          </div>
          {sources.length > 0 && <button type="button" className="cal-add" disabled={outside || !!draft?.event} onClick={() => add()} aria-label={t("cal.newEvent")}><Icon name="plus" /><span>{t("cal.new")}</span></button>}
        </div>
      </div>
      {noWrite && !targets.length && <p className="cal-note"><span>{t("cal.noWrite")}</span><a href="#p=core.settings">{t("cal.noWrite.go")}</a></p>}
      {moveError && <p className="cal-note" role="alert"><span>{moveError}</span></p>}
      {(removing || draft || pickedEvent) && (
        <Pop onClose={() => (removing ? setRemoving(null) : draft ? setDraft(null) : setPicked(null))}>
          {removing ? <DeleteAsk event={removing} onClose={() => setRemoving(null)} onDeleted={(change) => { sentOne(change); setPicked(null); }} />
            : draft ? <EventEditor draft={draft} targets={targets} k={draftK} range={range} onChange={setDraft} onClose={() => setDraft(null)} onSaved={sentOne}
                onDelete={draft.event ? () => askDelete(draft.event!) : undefined} />
            : pickedEvent && <EventCard event={pickedEvent} onClose={() => setPicked(null)}
                onSay={line && pickedEvent.editable && !pickedEvent.pending ? () => say(pickedEvent) : undefined}
                onEdit={pickedEvent.editable && !pickedEvent.pending ? () => edit(pickedEvent) : undefined} onDelete={pickedEvent.editable && !pickedEvent.pending ? () => askDelete(pickedEvent) : undefined} />}
        </Pop>
      )}

      {view === "today" && !dayGrid && shown.length > 0 && <TodayAgenda events={shown} today={today} now={now} onOpen={open} />}
      {view === "month" && sources.length > 0 && !visible.every(inRange) && <p className="cal-note quiet">{t("cal.unread")}</p>}
      {view === "month" && (
        <MonthGrid days={monthDays} month={month} today={today} events={shown} known={inRange} canAdd={(day) => targets.length > 0 && inRange(day) && !draft?.event}
          onOpen={open} onAdd={add} onDay={(day) => show("week", day)} />
      )}
      {(view === "week" || dayGrid) && (
      <div className="week-grid" data-single-day={dayGrid || undefined} ref={scroller}>
        <div className="wk-top">
        {view === "week" && <div className="wk-head">
          <span />
          {days.map((day) => (
            <div key={day} className="wk-day" data-today={day === today || undefined} data-weekend={parse(day).getDay() % 6 === 0 || undefined}>
              {label(day, { weekday: "short" })}<b>{parse(day).getDate()}</b>
            </div>
          ))}
        </div>}
        {dayGrid && shown.length === 0 && <p className="cal-note quiet">{t("cal.emptyToday")}</p>}
        {banner.length > 0 && (
          <div className="wk-allday">
            <span>{t("cal.allDay")}</span>
            {visible.map((day) => (
              <div key={day}>
                {banner.filter((event) => event.startDate <= day && event.endDate >= day).map((event) => (
                  <button type="button" key={`${event.account}|${event.id}`} className="ev ev-chip" data-k={event.k} data-declined={event.response === "declined" || undefined}
                    data-pending={event.pending || undefined} data-draft={event.draft || undefined} data-proposed={!!event.proposed || undefined} onClick={() => open(event)}>{event.title}</button>
                ))}
              </div>
            ))}
          </div>
        )}
        </div>
        <div className="wk-body" style={{ height: hours.length * HOUR }}>
          <div className="wk-gutter">{hours.map((hour) => <div key={hour}>{pad(hour)}:00</div>)}</div>
          {visible.map((day) => (
            <div key={day} className="wk-col" data-today={day === today || undefined} data-weekend={parse(day).getDay() % 6 === 0 || undefined}
              data-open={(targets.length > 0 && inRange(day) && !draft?.event) || undefined} {...grid(day)}>
              {lanes(dayGrid ? timed : timed.filter((event) => event.startDate === day)).map(({ event, lane, of }) => {
                const start = startMinute(event), end = endMinute(event);
                const top = (start - from * 60) / 60 * HOUR;
                const length = dayGrid ? end - start : (Date.parse(event.end!) - Date.parse(event.start!)) / 60_000;
                const height = Math.max(18, length / 60 * HOUR - 2);
                const time = dayGrid || event.draft ? timeOnDay(event, day) : hhmm(event.start!);
                return (
                  <button type="button" key={`${event.account}|${event.id}`} className="ev" data-k={event.k} data-past={(!event.draft && Date.parse(event.end!) < now) || undefined}
                    data-declined={event.response === "declined" || undefined} data-pending={event.pending || undefined} data-draft={event.draft || undefined} data-proposed={!!event.proposed || undefined}
                    data-movable={movable(event) || undefined} data-carried={(carry && same(carry.event, event)) || undefined} {...carrier(event)}
                    title={event.pending ? t("cal.pending") : undefined} onClick={() => { if (carried.current) { carried.current = false; return; } open(event); }}
                    style={{ top, height, left: `calc(${(lane / of) * 100}% + 2px)`, width: `calc(${100 / of}% - 4px)` }}>
                    {event.title}<small>{time}{!event.draft && event.location && ` · ${event.location}`}</small>
                  </button>
                );
              })}
              {carry?.day === day && (
                <div className="ev ev-carry" data-k={carry.event.k} data-proposed={!!carry.event.proposed || undefined} style={{ top: (carry.start - from * 60) / 60 * HOUR, height: Math.max(18, (Date.parse(carry.event.end!) - Date.parse(carry.event.start!)) / 3_600_000 * HOUR - 2), left: 2, right: 2 }}>
                  {carry.event.title}<small>{clock(carry.start)}–{clock(carry.start + (Date.parse(carry.event.end!) - Date.parse(carry.event.start!)) / 60_000)}</small>
                </div>
              )}
              {stretch?.day === day && (
                <div className="ev ev-stretch" style={{ top: (stretch.from - from * 60) / 60 * HOUR, height: Math.max(10, (stretch.to - stretch.from) / 60 * HOUR - 2), left: 2, right: 2 }}>
                  <small>{clock(stretch.from)}–{clock(stretch.to)}</small>
                </div>
              )}
              {day === today && nowTop >= 0 && nowTop <= hours.length * HOUR && <div className="wk-now" style={{ top: nowTop }} />}
            </div>
          ))}
        </div>
      </div>
      )}

      {/* Narrow screens: the week as a list of days. */}
      {view === "week" && <ol className="agenda">
        {days.map((day) => {
          const todays = shown.filter((event) => event.startDate <= day && event.endDate >= day);
          return (
            <li key={day} data-today={day === today || undefined}>
              <h3>
                {label(day, { weekday: "short", month: "short", day: "numeric" })}
                {targets.length > 0 && inRange(day) && !draft?.event && <button type="button" className="icon-btn" onClick={() => add(day)} aria-label={t("cal.addOn", { day: label(day, { month: "short", day: "numeric" }) })}><Icon name="plus" /></button>}
              </h3>
              {todays.length === 0 ? <p className="quiet small">—</p> : todays.map((event) => (
                <AgendaEvent key={`${event.account}|${event.id}`} event={event} time={inGrid(event) ? hhmm(event.start!) : t("cal.allDay")} onOpen={open} />
              ))}
            </li>
          );
        })}
      </ol>}
      {!dayGrid && sources.length > 0 && view !== "month" && shown.length === 0 && <p className="quiet empty-list">{t(outside ? "cal.outside" : view === "today" ? "cal.emptyToday" : "cal.empty")}</p>}
    </section>
  );
}
