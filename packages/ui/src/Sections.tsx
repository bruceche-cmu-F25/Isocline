/** A result drawn in sections (an automation with `layout: sections`; the morning brief is one): the lead on top, then
 * one block per heading the result wrote, in its order (sections.ts). A block's icon and look come from what its rows
 * link to, never from its title: rows about events are laid on a timeline, rows about todos are split into overdue and
 * due, rows about messages are ordered by their tags and lead to the letter. docs/design/user-defined.md §3.3.
 *
 * The run's sources are the data it actually read (server run-sources.ts). A past result never takes its words,
 * times or rows from today's modules; only an event's colour and the way to a letter are today's, and only while
 * those still exist.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { RunSources, Run } from "@alfred/protocol";
import { api } from "./api.ts";
import { readSections, type RefKind, type Row, type Section } from "./sections.ts";
import { Markdown } from "./Markdown.tsx";
import { Linked } from "./Linked.tsx";
import { Icon, type IconName } from "./shell/icons.tsx";
import { intlLocale, t } from "./i18n/index.ts";
import "./morning-brief.css";

type Sources = RunSources;
type SourceEvent = NonNullable<Sources["calendar"]>[number];
type SourceTodo = NonNullable<Sources["todos"]>[number];

function shortZone(date: string, timezone: string): string {
  try {
    const day = new Date(`${date}T12:00:00Z`);
    return new Intl.DateTimeFormat(intlLocale(), { timeZone: timezone, timeZoneName: "short" })
      .formatToParts(day).find((part) => part.type === "timeZoneName")?.value ?? timezone;
  } catch {
    return timezone;
  }
}

function shortDate(date: string): string {
  // A YYYY-MM-DD deadline is a calendar day even on a device in another time zone.
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(intlLocale(), { timeZone: "UTC", month: "short", day: "numeric" });
}

/** A block's icon, and the colour of the page its rows come from (shell/pages.tsx). */
const LOOK: Record<RefKind | "none", { icon: IconName; k?: string }> = {
  event: { icon: "cal", k: "now" }, todo: { icon: "todo", k: "blue" }, mail: { icon: "mail", k: "teal" }, none: { icon: "chat" },
};

function SectionHead({ about, title, source }: { about: RefKind | null; title: string; source?: string }) {
  const look = LOOK[about ?? "none"];
  return <header className="brief-section-head" data-k={look.k}>
    <h3><Icon name={look.icon} />{title}</h3>
    {source && <span>{source}</span>}
  </header>;
}

/** The grey tags name `gray` themselves: the page around has a colour of its own to inherit. */
function KindTag({ row, today }: { row: Row; today?: string }) {
  if (row.kind === "risk") return <span className="brief-tag" data-k="now"><Icon name="shield" />{t("brief.kind.risk")}</span>;
  if (row.kind === "decide") return <span className="brief-tag" data-k="warm">{t("brief.kind.decide")}</span>;
  if (row.kind === "due") return <span className="brief-tag" data-k="gray"><Icon name="clock" />{!row.due ? t("brief.kind.due") : row.due === today ? t("brief.dueToday") : shortDate(row.due)}</span>;
  if (row.kind === "fyi") return <span className="brief-tag" data-k="gray">{t("brief.kind.fyi")}</span>;
  return <span />;
}

/** Heaviest first; rows that were not tagged stay between the dated ones and what is only for information. */
const WEIGHT = { risk: 0, decide: 1, due: 2, none: 3, fyi: 4 };
const rowId = (ref: { kind: RefKind; id: string }) => `brief-${ref.kind}-${ref.id}`;

/** Rows as written: a tag when they have one, and for a message, who it is from and the way to it. */
function Rows({ rows, sources, sort }: { rows: Row[]; sources?: Sources | null; sort?: boolean }) {
  const tagged = rows.some((row) => row.kind);
  const listed = rows.map((row, index) => ({ row, index }));
  if (sort) listed.sort((a, b) => WEIGHT[a.row.kind ?? "none"] - WEIGHT[b.row.kind ?? "none"] || a.index - b.index);
  return <ul className={tagged ? "brief-mail-rows" : "brief-editorial-list"}>{listed.map(({ row, index }) => {
    const mail = row.ref?.kind === "mail" ? row.ref.id : undefined;
    const cited = mail ? sources?.cited?.find((message) => message.id === mail) : undefined;
    const from = cited?.from ?? (mail ? sources?.mail?.find((message) => message.id === mail)?.from.replace(/\s*<[^<>]*>$/, "") : undefined);
    const body = <>
      <Markdown text={row.text} />
      {(from || cited) && <p className="brief-row-source">
        {from && <span>{t("brief.from", { name: from })}</span>}
        {cited && <a className="text-link" href={`#${new URLSearchParams({ p: "mail.inbox", item: cited.key })}`}>{t("brief.openMail")}</a>}
      </p>}
    </>;
    return <li key={index} id={row.ref ? rowId(row.ref) : undefined} data-kind={row.kind ?? undefined}>
      {tagged ? <><KindTag row={row} today={sources?.date} /><div>{body}</div></> : body}
    </li>;
  })}</ul>;
}

function AgendaTime({ event }: { event: SourceEvent }) {
  if (!event.start && !event.end) return <span>{t("brief.continues")}</span>;
  return <>
    {event.start && <time>{event.start}</time>}
    {event.end && <span className="brief-end">{t("brief.until", { time: event.end })}</span>}
  </>;
}

/** The calendar saved the title and any additional context as one display string. Keep every word
 * and only change how its final parenthetical is displayed; it can be part of the actual name. */
function EventName({ text }: { text: string }) {
  const end = text.trimEnd();
  const close = end.at(-1);
  if (close !== ")" && close !== "）") return <>{text}</>;
  const open = close === ")" ? "(" : "（";
  let depth = 0;
  for (let i = end.length - 1; i > 0; i--) {
    if (end[i] === close) depth++;
    if (end[i] !== open) continue;
    depth--;
    if (depth !== 0) continue;
    const title = end.slice(0, i).trimEnd();
    if (!title) break;
    const annotation = end.slice(i);
    if (annotation.length <= 65 && !/https?:\/\/|www\.|\S@\S/i.test(annotation)) {
      return <>{title} <span className="brief-event-aside">{annotation}</span></>;
    }
    return <>{title}<details className="brief-event-details">
      <summary aria-label={t("brief.eventDetailsFor", { title })}><Icon name="down" />{t("brief.eventDetails")}</summary>
      <div><Linked text={annotation} /></div>
    </details></>;
  }
  return <>{text}</>;
}

function Timeline({ events }: { events: SourceEvent[] }) {
  const timed = events.filter((event) => !event.allDay).sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
  const allDay = events.filter((event) => event.allDay);
  return <>
    {timed.length > 0 && <ol className="brief-timeline">{timed.map((event) =>
      <li key={event.id} data-k={event.k}><div className="brief-time"><AgendaTime event={event} /></div><div className="brief-event-name"><EventName text={event.title} /></div></li>)}</ol>}
    {allDay.length > 0 && <div className="brief-all-day">
      <h4>{t("cal.allDay")}</h4>
      <ul>{allDay.map((event) => <li key={event.id} data-k={event.k}><EventName text={event.title} /></li>)}</ul>
    </div>}
  </>;
}

/** Overdue is a missed date: red, as on the Todos page, and always beside its word and its date. */
function TodoList({ items, label, late }: { items: SourceTodo[]; label: string; late?: boolean }) {
  if (!items.length) return null;
  return <div className="brief-task-group">
    <h4 data-k={late ? "now" : undefined}>{label}</h4>
    <ul className="brief-tasks">{items.map((todo) =>
      <li key={todo.id}>
        <span className="brief-task-title" data-k={todo.area?.k}>{todo.title}{todo.area && <span className="brief-area">{todo.area.name}</span>}</span>
        {(todo.overdue || todo.at) && <span className="brief-task-due" data-late={todo.overdue || undefined} data-k={todo.overdue ? "now" : undefined}>
          {todo.overdue && <time dateTime={todo.due}>{shortDate(todo.due)}</time>}
          {todo.at && <time>{todo.at}</time>}
        </span>}
      </li>)}</ul>
  </div>;
}

/** One block. Rows about events or todos that the run's sources have are drawn from those records; the rest as written. */
function Block({ section, sources }: { section: Section; sources?: Sources | null }) {
  const ids = (kind: RefKind) => new Set(section.rows.flatMap((row) => (row.ref?.kind === kind ? [row.ref.id] : [])));
  let recorded: ReactNode = null, rest = section.rows, source: string | undefined;
  if (section.about === "event" && sources?.calendar) {
    const cited = ids("event"), events = sources.calendar.filter((event) => cited.has(event.id));
    if (events.length) {
      recorded = <Timeline events={events} />;
      rest = section.rows.filter((row) => !(row.ref?.kind === "event" && events.some((event) => event.id === row.ref!.id)));
      source = [t("brief.calendarSource"), shortZone(sources.date, sources.timezone)].filter(Boolean).join(" · ");
    }
  } else if (section.about === "todo" && sources?.todos) {
    const cited = ids("todo"), todos = sources.todos.filter((todo) => cited.has(todo.id));
    if (todos.length) {
      recorded = <>
        <TodoList items={todos.filter((todo) => todo.overdue)} label={t("brief.overdue")} late />
        <TodoList items={todos.filter((todo) => !todo.overdue)} label={t("brief.dueToday")} />
      </>;
      rest = section.rows.filter((row) => !(row.ref?.kind === "todo" && todos.some((todo) => todo.id === row.ref!.id)));
      source = t("brief.todoSource");
    }
  }
  return <section className="brief-section" data-about={section.about ?? undefined} aria-label={section.title}>
    <SectionHead about={section.about} title={section.title} source={source} />
    {recorded}
    {rest.length > 0 && <Rows rows={rest} sources={sources} sort={section.about === "mail"} />}
  </section>;
}

function Disclosure({ className, label, children }: { className: string; label: string; children: ReactNode }) {
  return <details className={`brief-disclosure ${className}`}><summary><Icon name="down" />{label}</summary>{children}</details>;
}

export function SectionsResult({ run }: { run: Run }) {
  const [result, setResult] = useState<{ id: string; sources: Sources | null; error?: boolean } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    api.runSources(run.id).then(({ evidence }) => { if (current) setResult({ id: run.id, sources: evidence }); })
      .catch(() => { if (current) setResult({ id: run.id, sources: null, error: true }); });
    return () => { current = false; };
  }, [run.id, retry]);
  const reply = run.outcome?.reply ?? "";
  const read = useMemo(() => readSections(reply), [reply]);
  const loaded = result?.id === run.id ? result : null;
  const sources = loaded?.sources;
  const opened = sources?.mail;
  const page = useRef<HTMLDivElement>(null);
  const linked = (ref: Row["ref"]) => !!ref && read.sections.some((section) => section.rows.some((row) => row.ref?.kind === ref.kind && row.ref.id === ref.id));
  const jump = (ref: NonNullable<Row["ref"]>) => {
    const row = page.current?.querySelector<HTMLElement>(`#${CSS.escape(rowId(ref))}`);
    if (!row) return;
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    row.setAttribute("data-flash", "");
    setTimeout(() => row.removeAttribute("data-flash"), 700);
  };
  // Blocks about events and todos sit side by side when both are there, as a day does.
  const day = read.sections.filter((section) => section.about === "event" || section.about === "todo");
  const paired = day.length === 2 && day[0]!.about !== day[1]!.about && read.sections.indexOf(day[1]!) === read.sections.indexOf(day[0]!) + 1;
  const blocks: ReactNode[] = [];
  for (const [index, section] of read.sections.entries()) {
    if (paired && section === day[1]) continue;
    blocks.push(paired && section === day[0]
      ? <div key={index} className="brief-day" data-paired><Block section={section} sources={sources} /><Block section={day[1]!} sources={sources} /></div>
      : <Block key={index} section={section} sources={sources} />);
  }
  return <div ref={page} className="morning-brief" aria-busy={!loaded} data-source-state={loaded ? (sources ? "recorded" : "unavailable") : "loading"}>
    {read.lead.length > 0 && <section className="brief-advice" aria-label={t("brief.start")}>
      <h3><Icon name="bulb" />{t("brief.start")}</h3>
      {read.lead.map((row, index) => <div key={index} className="brief-advice-row">
        <Markdown text={row.text} />
        {linked(row.ref) && <button type="button" className="link" onClick={() => jump(row.ref!)}>{t("brief.jump")}</button>}
      </div>)}
    </section>}
    {blocks}
    {!!opened?.length && <Disclosure className="brief-sources" label={t("brief.openedMail", { n: opened.length })}>
      <ul className="brief-mail-sources">{opened.map((message) =>
        <li key={message.id}><strong>{message.subject || t("mail.nosubject")}</strong><span>{message.from}</span></li>)}</ul>
    </Disclosure>}
    {loaded?.error && <div className="brief-retry" role="status">
      <span>{t("brief.sourceError")}</span> <button type="button" className="link" onClick={() => { setResult(null); setRetry(retry + 1); }}>{t("archive.retry")}</button>
    </div>}
    {reply && <Disclosure className="brief-original" label={t("brief.original")}><Markdown text={reply} /></Disclosure>}
    {!reply && <p className="brief-empty">{t(loaded ? "auto.emptyResult" : "auto.loading")}</p>}
  </div>;
}
