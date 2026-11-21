import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { StateResponse } from "@alfred/protocol";
import { api } from "./api.ts";
import { Icon, type IconName } from "./shell/icons.tsx";
import { when as ago } from "./shell/Nav.tsx";
import { todayLine, todayModel, untilText, type LineRow, type TodayEvent, type TodayModel } from "./shell/today.ts";
import { intlLocale, t } from "./i18n/index.ts";
import "./today.css";

export interface TodayProps {
  state: StateResponse;
  name: string | null;
  /** To another page, and to one thing on it (an Inbox item, a letter). */
  go(page: string, item?: string): void;
  onOpenConversation(conversationId: string, runId?: string): void;
}

/** The time, so that "in 1h 50m" and the mark of now move by themselves. */
function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    const seen = () => { if (!document.hidden) setNow(Date.now()); };
    document.addEventListener("visibilitychange", seen);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", seen); };
  }, [everyMs]);
  return now;
}

/** A link out of Alfred drawn as a button: an event's call, or the event in its calendar. */
function Out({ href, children, solid }: { href: string; children: ReactNode; solid?: boolean }) {
  return <a className="today-btn" data-solid={solid || undefined} href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
}

/** An event's place is often a web address (a problem list, a form, a room's page): then it is a way in, named by
 * its site, not a line of text to copy. */
function placeLink(location?: string): { href: string; site: string } | null {
  const text = location?.trim() ?? "";
  if (!/^https?:\/\/\S+$/i.test(text)) return null;
  try { return { href: text, site: new URL(text).hostname.replace(/^www\./, "") }; } catch { return null; }
}

/** 一句: a greeting, then the one thing that is next, with the way in under it. */
function Lede({ model, name, now, go }: { model: TodayModel; name: string | null; now: number; go: TodayProps["go"] }) {
  const hello = t(`today.hi.${model.part}`) + (name ? t("today.hi.name", { name }) : "") + t("today.stop");
  const lead: TodayEvent | undefined = model.current ?? model.next;
  const place = placeLink(lead?.event.location);
  let said: ReactNode;
  if (model.current) {
    said = <>
      <b>{t("today.now", { title: model.current.event.title })}</b><span>{t("today.now.until", { until: model.current.until })}</span>
      {model.next && <span> {t("today.then", { at: model.next.at, title: model.next.event.title })}{t("today.stop")}</span>}
    </>;
  } else if (model.next) {
    said = <><b>{t("today.next", { at: model.next.at, title: model.next.event.title })}</b><span>{t("today.next.in", { left: untilText(model.next.startMs - now) })}</span></>;
  } else if (model.calendar === "none") {
    said = <><b>{t("today.noCalendar")}</b><span>{t("today.noCalendar.hint")}</span></>;
  } else if (model.turned) {
    // Evening, and today is over: the sentence is about tomorrow.
    said = <>
      <b>{model.tomorrow ? t("today.tomorrow.first", { at: model.tomorrow.at, title: model.tomorrow.event.title }) : t("today.tomorrow.none")}</b>
      <span>{t("today.stop")}{model.passed > 0 && ` ${t("today.passed", { n: model.passed })}`}</span>
    </>;
  } else if (model.tomorrow) {
    said = <><span>{t("today.free")}{t("today.stop")}</span> <b>{t("today.tomorrow.first", { at: model.tomorrow.at, title: model.tomorrow.event.title })}</b><span>{t("today.stop")}</span></>;
  } else {
    said = <><b>{t("today.free")}</b><span>{t("today.stop")}</span></>;
  }
  return (
    <section className="today-lede">
      <p className="today-hi">{hello}</p>
      <h2 className="today-next">{said}</h2>
      {lead ? (
        <div className="today-way">
          {lead.event.meeting ? <Out href={lead.event.meeting} solid>{t("today.join")}</Out>
            : place ? <Out href={place.href} solid>{place.site}</Out>
            : lead.event.link ? <Out href={lead.event.link}>{t("today.openEvent")}</Out> : null}
          {lead.event.location && !place && <span className="today-where">{lead.event.location}</span>}
        </div>
      ) : model.calendar === "none" ? (
        <div className="today-way"><button type="button" className="today-btn" onClick={() => go("calendar.week")}>{t("page.calendar")}</button></div>
      ) : null}
      {model.calendar === "error" && <p className="today-problem">{t("today.calError")}</p>}
    </section>
  );
}

interface RowProps {
  when?: string;
  /** How the hour reads: something waits on the user, the hour has gone by, or it is going on now. */
  tone?: "wait" | "late" | "now";
  /** What kind of thing, said by the icon of the page it lives on, in that thing's colour. */
  icon?: IconName;
  k?: string | null;
  /** A todo: its ring ticks it off. */
  onTick?: () => void;
  ticked?: boolean;
  /** Still going. */
  pulse?: boolean;
  what: string;
  why?: string;
  /** A way in that leaves Alfred: a call, a site. */
  out?: { href: string; label: string };
  past?: boolean;
  /** A line that only says there is more. */
  quiet?: boolean;
  onOpen(): void;
}

/** The one shape of row on this page: when · what kind · what it is, and a word of why · the way in. The whole row
 * opens the thing (the button's ::before covers it); the ring and the link out sit above that. */
function Row({ when, tone, icon, k, onTick, ticked, pulse, what, why, out, past, quiet, onOpen }: RowProps) {
  return (
    <li className="today-row" data-k={k ?? undefined} data-tone={tone} data-past={past || undefined} data-quiet={quiet || undefined} data-done={ticked || undefined}>
      <span className="today-when">{when}</span>
      {onTick
        ? <button type="button" className="today-kind today-tick" role="checkbox" aria-checked={!!ticked} aria-label={t("today.tick", { title: what })} disabled={ticked} onClick={onTick} />
        : <span className="today-kind">{pulse ? <i className="today-pulse" /> : icon ? <Icon name={icon} /> : null}</span>}
      <button type="button" className="today-what" onClick={onOpen}><span className="today-text"><b>{what}</b>{why && <span>{why}</span>}</span></button>
      {out && <a className="today-go" href={out.href} target="_blank" rel="noreferrer noopener">{out.label}<span aria-hidden="true"> ↗</span></a>}
    </li>
  );
}

function Rows({ rows, go, ticked, onTick }: { rows: LineRow[]; go: TodayProps["go"]; ticked: ReadonlySet<string>; onTick(id: string): void }) {
  return <>{rows.map((row) => {
    if (row.kind === "wait") {
      return <Row key={row.key} when={t("today.wait")} tone="wait" icon="inbox" k="warm" what={row.item.title} why={row.item.summary} onOpen={() => go("core.inbox", row.item.id)} />;
    }
    if (row.kind === "event") {
      const { event } = row;
      const place = placeLink(event.location);
      const out = event.meeting && !row.past ? { href: event.meeting, label: t("today.join") } : place ? { href: place.href, label: place.site } : undefined;
      const why = [row.now && row.until ? t("today.until", { until: row.until }) : "", place ? "" : event.location ?? ""].filter(Boolean).join(" · ");
      return <Row key={row.key} when={row.at ?? t("cal.allDay")} tone={row.now ? "now" : undefined} icon="cal" k={event.k} what={event.title} why={why} out={out} past={row.past} onOpen={() => go("calendar.week")} />;
    }
    if (row.kind === "todo") {
      return <Row key={row.key} when={row.at} tone={row.late ? "late" : undefined} k={row.k} what={row.todo.title} why={row.late ? t("today.overdue") : undefined}
        ticked={ticked.has(row.todo.id)} onTick={() => onTick(row.todo.id)} onOpen={() => go("todo.list")} />;
    }
    const { message } = row;
    return <Row key={row.key} icon="mail" k="teal" what={message.from} why={message.subject} onOpen={() => go("mail.inbox", `${message.account}|${message.id}`)} />;
  })}</>;
}

/** A count in words, its number in ink. */
const Counted = ({ text }: { text: string }) => <>{text.split(/(\d+)/).map((part, index) => (index % 2 ? <b key={index}>{part}</b> : part))}</>;

type Rest = "mail" | "doing" | "done";

/** 今天: the note Alfred writes about everything (docs/design/today-and-inbox.md, 3.1b). One sentence on what is
 * next; the day on one line, every row the same shape; the rest as counts that open in place. Nothing empty is shown. */
export function Today({ state, name, go, onOpenConversation }: TodayProps) {
  const now = useNow();
  const model = useMemo(() => todayModel(state, now), [state, now]);
  const line = useMemo(() => todayLine(model), [model]);
  const [pastOpen, setPastOpen] = useState(false);
  const [rest, setRest] = useState<Rest | null>(null);
  // A todo ticked here is struck through at once; the home node's next state takes it off the line.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const tick = (id: string) => {
    setTicked((current) => new Set(current).add(id));
    api.op("todo.complete", { id }).catch(() => setTicked((current) => { const next = new Set(current); next.delete(id); return next; }));
  };
  const rows = (list: LineRow[]) => <Rows rows={list} go={go} ticked={ticked} onTick={tick} />;

  const date = new Date(now);
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const [y, m, d] = model.ahead.date.split("-").map(Number);
  const tomorrowDay = new Date(y, m - 1, d).toLocaleDateString(intlLocale(), { weekday: "short" });
  const atNow = line.past.length + line.wait.length + line.ahead.length > 0;
  const hasLine = atNow || line.within.length > 0 || line.tomorrow.length > 0;

  const { mail, doing, done } = model;
  const mailShown = mail.state === "ok" && mail.today > 0;
  const mailLeft = mail.unread - mail.machine - mail.rows.length;
  const mailOpens = mail.rows.length > 0 || mail.machine > 0;
  const hasRest = mailShown || mail.state === "error" || doing.length > 0 || done.length > 0 || model.late > 0;
  const count = (key: Rest, text: string) => (
    <button type="button" className="today-count" aria-expanded={rest === key} onClick={() => setRest(rest === key ? null : key)}><Counted text={text} /></button>
  );

  return (
    <div className="today">
      <div className="today-col">
        <Lede model={model} name={name} now={now} go={go} />

        {hasLine && (
          <ol className="today-line">
            {line.past.length > 0 && (
              <li><button type="button" className="today-fold" aria-expanded={pastOpen} onClick={() => setPastOpen(!pastOpen)}><Icon name="down" />{t("today.over", { n: line.past.length })}</button></li>
            )}
            {pastOpen && rows(line.past)}
            {atNow && <li className="today-mark" data-now>{t("today.mark.now", { at: clock })}</li>}
            {rows(line.wait)}
            {line.moreWaiting > 0 && <Row quiet what={t("today.wait.more", { n: line.moreWaiting })} onOpen={() => go("core.inbox")} />}
            {rows(line.ahead)}
            {line.within.length > 0 && <li className="today-mark">{t("today.mark.within")}</li>}
            {rows(line.within)}
            {line.tomorrow.length > 0 && <li className="today-mark">{t("today.tomorrow")} · {tomorrowDay}</li>}
            {rows(line.tomorrow)}
            {line.moreTomorrow > 0 && <Row quiet what={t("today.tomorrow.more", { n: line.moreTomorrow })} onOpen={() => go("calendar.week")} />}
          </ol>
        )}

        {hasRest && (
          <div className="today-rest">
            {mailShown && (mailOpens
              ? count("mail", mail.unread ? t("today.c.mailUnread", { n: mail.today, unread: mail.unread }) : t("today.c.mail", { n: mail.today }))
              : <button type="button" className="today-count" onClick={() => go("mail.inbox")}><Counted text={t("today.c.mail", { n: mail.today })} /></button>)}
            {mail.state === "error" && <button type="button" className="today-count" data-k="now" onClick={() => go("mail.inbox")}><b>{t("today.mail.error")}</b></button>}
            {doing.length > 0 && count("doing", t("today.c.doing", { n: doing.length }))}
            {done.length > 0 && count("done", t("today.c.done", { n: done.length }))}
            {model.late > 0 && <button type="button" className="today-count" data-k="now" onClick={() => go("todo.list")}><Counted text={t("today.late", { n: model.late })} /></button>}
          </div>
        )}
        {rest === "mail" && mailShown && (
          <ol className="today-more">
            {mail.rows.map((message) => (
              <Row key={`${message.account}|${message.id}`} when={ago(message.receivedAt)} icon="mail" k="teal" what={message.from} why={message.subject} onOpen={() => go("mail.inbox", `${message.account}|${message.id}`)} />
            ))}
            {mailLeft > 0 && <Row quiet what={t("today.mail.more", { n: mailLeft })} onOpen={() => go("mail.inbox")} />}
            {mail.machine > 0 && <Row quiet what={t("today.mail.machine", { n: mail.machine })} onOpen={() => go("mail.inbox")} />}
          </ol>
        )}
        {rest === "doing" && doing.length > 0 && (
          <ol className="today-more">
            {doing.map(({ run, title, sub, session }) => (
              <Row key={run.id} pulse what={title} why={[session ? t("today.session") : "", sub].filter(Boolean).join(" · ")} onOpen={() => onOpenConversation(run.conversationId, run.id)} />
            ))}
          </ol>
        )}
        {rest === "done" && done.length > 0 && (
          <ol className="today-more">
            {done.map((item) => (
              <Row key={item.key} when={ago(item.at)} icon="check" k="green" what={item.title} why={[item.session ? t("today.session") : "", item.sub].filter(Boolean).join(" · ")}
                onOpen={() => (item.inbox ? go("core.inbox", item.inbox) : onOpenConversation(item.conversationId!))} />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
