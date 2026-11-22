import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MorningBriefEvidence, Run } from "@alfred/protocol";
import { api } from "./api.ts";
import { readBriefEditorial, readMailRow, type MailRow } from "./briefEditorial.ts";
import { Markdown } from "./Markdown.tsx";
import { Linked } from "./Linked.tsx";
import { plainText } from "./markdown.ts";
import { Icon, type IconName } from "./shell/icons.tsx";
import { getLocale, intlLocale, t } from "./i18n/index.ts";
import "./morning-brief.css";

type BriefEvent = NonNullable<MorningBriefEvidence["calendar"]>[number];
type BriefTodo = NonNullable<MorningBriefEvidence["todos"]>[number];

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

/** A section's icon takes the colour of the page its rows come from (shell/pages.tsx). */
const PAGE_K: Partial<Record<IconName, string>> = { cal: "now", todo: "blue", mail: "teal" };

function SectionHead({ icon, title, source }: { icon: IconName; title: string; source?: string }) {
  return <header className="brief-section-head" data-k={PAGE_K[icon]}>
    <h3><Icon name={icon} />{title}</h3>
    {source && <span>{source}</span>}
  </header>;
}

function EditorialList({ rows }: { rows: string[] }) {
  return <ul className="brief-editorial-list">{rows.map((row, index) =>
    <li key={index}><Markdown text={row} /></li>)}</ul>;
}

function AgendaTime({ event }: { event: BriefEvent }) {
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

function Agenda({ events, fallback, zone }: { events: BriefEvent[] | null; fallback: string[]; zone: string }) {
  const timed = events?.filter((event) => !event.allDay).sort((a, b) => (a.start ?? "").localeCompare(b.start ?? "")) ?? [];
  const allDay = events?.filter((event) => event.allDay) ?? [];
  return <section className="brief-section brief-agenda" aria-label={t("brief.agenda")}>
    <SectionHead title={t("brief.agenda")} icon="cal" source={events ? [t("brief.calendarSource"), zone].filter(Boolean).join(" · ") : t("brief.fromAlfred")} />
    {events === null ? <EditorialList rows={fallback} /> : <>
      {timed.length > 0 && <ol className="brief-timeline">{timed.map((event) =>
        <li key={event.id} data-k={event.k}><div className="brief-time"><AgendaTime event={event} /></div><div className="brief-event-name"><EventName text={event.title} /></div></li>)}</ol>}
      {allDay.length > 0 && <div className="brief-all-day">
        <h4>{t("cal.allDay")}</h4>
        <ul>{allDay.map((event) => <li key={event.id} data-k={event.k}><EventName text={event.title} /></li>)}</ul>
      </div>}
      {!events.length && <p className="brief-empty">{t("brief.noEvents")}</p>}
    </>}
  </section>;
}

/** Overdue is a missed date: red, as on the Todos page, and always beside its word and its date. */
function TodoList({ items, label, late }: { items: BriefTodo[]; label: string; late?: boolean }) {
  if (!items.length) return null;
  return <div className="brief-task-group">
    <h4 data-k={late ? "now" : undefined}>{label}</h4>
    <ul className="brief-tasks">{items.map((todo) =>
      <li key={todo.id}>
        <span className="brief-task-title" data-k={todo.area?.k}>{todo.title}{todo.area && <span className="brief-area">{todo.area.name[getLocale()]}</span>}</span>
        {(todo.overdue || todo.at) && <span className="brief-task-due" data-late={todo.overdue || undefined} data-k={todo.overdue ? "now" : undefined}>
          {todo.overdue && <time dateTime={todo.due}>{shortDate(todo.due)}</time>}
          {todo.at && <time>{todo.at}</time>}
        </span>}
      </li>)}</ul>
  </div>;
}

function Deadlines({ todos, fallback }: { todos: BriefTodo[] | null; fallback: string[] }) {
  const hasSource = todos !== null;
  // The report may name a deadline heard in an email, or give a time the task record doesn't contain.
  const titles = new Set(todos?.map((todo) => todo.title.trim().toLocaleLowerCase()));
  const mentioned = fallback.filter((row) => !titles.has(plainText(row).trim().toLocaleLowerCase()));
  return <section className="brief-section brief-due" aria-label={t("brief.deadlines")}>
    <SectionHead title={t("brief.deadlines")} icon="todo" source={hasSource ? t("brief.todoSource") : t("brief.fromAlfred")} />
    {todos && <>
      <TodoList items={todos.filter((todo) => todo.overdue)} label={t("brief.overdue")} late />
      <TodoList items={todos.filter((todo) => !todo.overdue)} label={t("brief.dueToday")} />
      {!todos.length && <p className="brief-empty">{t("brief.noTodos")}</p>}
    </>}
    {mentioned.length > 0 && (todos?.length
      ? <Disclosure className="brief-reported" label={t("brief.reported")}><EditorialList rows={mentioned} /></Disclosure>
      : <div className="brief-reported">
        {hasSource && <h4>{t("brief.reported")}</h4>}
        <EditorialList rows={mentioned} />
      </div>)}
  </section>;
}

/** Heaviest first; rows the edition did not tag stay between the dated ones and what is only for information. */
const WEIGHT = { risk: 0, decide: 1, due: 2, none: 3, fyi: 4 };
const rowId = (mail: string) => `brief-mail-${mail}`;

/** The grey tags name `gray` themselves: the page around the brief has a colour of its own to inherit. */
function KindTag({ row, today }: { row: MailRow; today?: string }) {
  if (row.kind === "risk") return <span className="brief-tag" data-k="now"><Icon name="shield" />{t("brief.kind.risk")}</span>;
  if (row.kind === "decide") return <span className="brief-tag" data-k="warm">{t("brief.kind.decide")}</span>;
  if (row.kind === "due") return <span className="brief-tag" data-k="gray"><Icon name="clock" />{!row.due ? t("brief.kind.due") : row.due === today ? t("brief.dueToday") : shortDate(row.due)}</span>;
  if (row.kind === "fyi") return <span className="brief-tag" data-k="gray">{t("brief.kind.fyi")}</span>;
  return <span />;
}

/** The mail rows of an edition that tagged them: what each is, its words, and the letter it is about.
 * The sender and the link come from the saved record and today's mailbox; a letter that is gone has no link. */
function MailRows({ rows, evidence }: { rows: MailRow[]; evidence?: MorningBriefEvidence | null }) {
  const sorted = rows.map((row, index) => ({ row, index }))
    .sort((a, b) => WEIGHT[a.row.kind ?? "none"] - WEIGHT[b.row.kind ?? "none"] || a.index - b.index);
  return <ul className="brief-mail-rows">{sorted.map(({ row, index }) => {
    const cited = row.mail ? evidence?.cited?.find((message) => message.id === row.mail) : undefined;
    const from = cited?.from ?? (row.mail ? evidence?.mail?.find((message) => message.id === row.mail)?.from.replace(/\s*<[^<>]*>$/, "") : undefined);
    return <li key={index} id={row.mail ? rowId(row.mail) : undefined} data-kind={row.kind ?? undefined}>
      <KindTag row={row} today={evidence?.date} />
      <div>
        <Markdown text={row.text} />
        {(from || cited) && <p className="brief-row-source">
          {from && <span>{t("brief.from", { name: from })}</span>}
          {cited && <a className="text-link" href={`#${new URLSearchParams({ p: "mail.inbox", item: cited.key })}`}>{t("brief.openMail")}</a>}
        </p>}
      </div>
    </li>;
  })}</ul>;
}

function Disclosure({ className, label, children }: { className: string; label: string; children: ReactNode }) {
  return <details className={`brief-disclosure ${className}`}><summary><Icon name="down" />{label}</summary>{children}</details>;
}

/** Evidence is the data this run actually read. A historical edition never takes its words, times or rows from
 * today's modules; only an event's colour and the way to a letter are today's, and only while those still exist. */
export function MorningBrief({ run }: { run: Run }) {
  const [result, setResult] = useState<{ id: string; evidence: MorningBriefEvidence | null; error?: boolean } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    api.morningBrief(run.id).then(({ evidence }) => { if (current) setResult({ id: run.id, evidence }); })
      .catch(() => { if (current) setResult({ id: run.id, evidence: null, error: true }); });
    return () => { current = false; };
  }, [run.id, retry]);
  const reply = run.outcome?.reply ?? "";
  const edit = useMemo(() => readBriefEditorial(reply), [reply]);
  const loaded = result?.id === run.id ? result : null;
  const evidence = loaded?.evidence;
  const agenda = evidence?.calendar ?? null, todos = evidence?.todos ?? null;
  const hasAgenda = agenda !== null || edit.agenda.length > 0;
  const hasDue = todos !== null || edit.deadlines.length > 0;
  const mail = evidence?.mail;
  const mailRows = useMemo(() => edit.mail.map(readMailRow), [edit]);
  const advice = useMemo(() => edit.advice.map(readMailRow), [edit]);
  const tagged = mailRows.some((row) => row.kind || row.mail);
  const page = useRef<HTMLDivElement>(null);
  const jump = (id: string) => {
    const row = page.current?.querySelector<HTMLElement>(`#${CSS.escape(rowId(id))}`);
    if (!row) return;
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    row.setAttribute("data-flash", "");
    setTimeout(() => row.removeAttribute("data-flash"), 700);
  };
  return <div ref={page} className="morning-brief" aria-busy={!loaded} data-source-state={loaded ? (evidence ? "recorded" : "unavailable") : "loading"}>
    {edit.advice.length > 0 && <section className="brief-advice" aria-label={t("brief.start")}>
      <h3><Icon name="bulb" />{t("brief.start")}</h3>
      {advice.map((row, index) => <div key={index} className="brief-advice-row">
        <Markdown text={row.mail ? row.text : edit.advice[index]!} />
        {row.mail && mailRows.some((other) => other.mail === row.mail) && <button type="button" className="link" onClick={() => jump(row.mail!)}>{t("brief.jump")}</button>}
      </div>)}
    </section>}
    {(hasAgenda || hasDue) && <div className="brief-day" data-paired={hasAgenda && hasDue || undefined}>
      {hasAgenda && <Agenda events={agenda} fallback={edit.agenda} zone={evidence ? shortZone(evidence.date, evidence.timezone) : ""} />}
      {hasDue && <Deadlines todos={todos} fallback={edit.deadlines} />}
    </div>}
    {edit.mail.length > 0 && <section className="brief-section brief-decisions" aria-label={t("brief.decisions")}>
      <SectionHead title={t("brief.decisions")} icon="mail" />
      {tagged ? <MailRows rows={mailRows} evidence={evidence} /> : <EditorialList rows={edit.mail} />}
    </section>}
    {edit.notes.length > 0 && <section className="brief-section brief-notes" aria-label={t("brief.notes")}>
      <SectionHead title={t("brief.notes")} icon="chat" /><EditorialList rows={edit.notes} />
    </section>}
    {(!!mail?.length || edit.coverage.length > 0) && <Disclosure className="brief-sources" label={mail?.length ? t("brief.openedMail", { n: mail.length }) : t("brief.sourceNotes")}>
      {!!mail?.length && <ul className="brief-mail-sources">{mail.map((message) =>
        <li key={message.id}><strong>{message.subject || t("mail.nosubject")}</strong><span>{message.from}</span></li>)}</ul>}
      {edit.coverage.map((note, index) => <Markdown key={index} text={note} className="brief-coverage" />)}
    </Disclosure>}
    {loaded?.error && <div className="brief-retry" role="status">
      <span>{t("brief.sourceError")}</span> <button type="button" className="link" onClick={() => { setResult(null); setRetry(retry + 1); }}>{t("archive.retry")}</button>
    </div>}
    {reply && <Disclosure className="brief-original" label={t("brief.original")}><Markdown text={reply} /></Disclosure>}
    {!reply && !hasAgenda && !hasDue && <p className="brief-empty">{t(loaded ? "auto.emptyResult" : "auto.loading")}</p>}
  </div>;
}
