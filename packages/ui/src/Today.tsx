import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { StateResponse } from "@alfred/protocol";
import { Icon } from "./shell/icons.tsx";
import { kindColour } from "./shell/inbox.ts";
import { when } from "./shell/Nav.tsx";
import { todayModel, untilText, type TodayEvent, type TodayModel, type TodayRow } from "./shell/today.ts";
import { intlLocale, t } from "./i18n/index.ts";
import "./today.css";

export interface TodayProps {
  state: StateResponse;
  name: string | null;
  /** To another page, and to one thing on it (an Inbox item, a letter). */
  go(page: string, item?: string): void;
  onOpenConversation(conversationId: string, runId?: string): void;
}

/** The time, so that "in 1h 50m" and the line of now move by themselves. */
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
  return <a className="today-btn" data-solid={solid || undefined} href={href} target="_blank" rel="noreferrer noopener" onClick={(event) => event.stopPropagation()}>{children}</a>;
}

function Head({ title, note, to, onTo, count }: { title: string; note?: string; to?: string; onTo?: () => void; count?: number }) {
  return (
    <h2 className="today-h">
      <b>{title}</b>
      {count ? <span className="today-n" data-k="warm">{count}</span> : null}
      {note && <span className="today-note">{note}</span>}
      {to && onTo && <button type="button" className="today-more" onClick={onTo}>{to}<Icon name="down" /></button>}
    </h2>
  );
}

/** The first line: a greeting and what is next, with the way in under it. */
function Lede({ model, name, now, go }: { model: TodayModel; name: string | null; now: number; go: TodayProps["go"] }) {
  const hello = t(`today.hi.${model.part}`) + (name ? t("today.hi.name", { name }) : "") + t("today.stop");
  const lead: TodayEvent | undefined = model.current ?? model.next;
  let said: ReactNode;
  if (model.current) {
    said = <><b>{t("today.now", { title: model.current.event.title })}</b><span>{t("today.now.until", { until: model.current.until })}</span></>;
  } else if (model.next) {
    said = <><b>{t("today.next", { at: model.next.at, title: model.next.event.title })}</b><span>{t("today.next.in", { left: untilText(model.next.startMs - now) })}</span></>;
  } else if (model.calendar === "none") {
    said = <><b>{t("today.noCalendar")}</b><span>{t("today.noCalendar.hint")}</span></>;
  } else {
    said = <><b>{t("today.free")}</b><span>{model.tomorrow ? t("today.free.tomorrow", { at: model.tomorrow.at, title: model.tomorrow.event.title }) : t("today.stop")}</span></>;
  }
  return (
    <section className="today-lede">
      <p className="today-hello">{hello} {said}</p>
      {model.current && model.next && <p className="today-then">{t("today.then", { at: model.next.at, title: model.next.event.title })}</p>}
      {lead ? (
        <div className="today-way">
          {lead.event.meeting ? <Out href={lead.event.meeting} solid>{t("today.join")}</Out> : lead.event.link ? <Out href={lead.event.link}>{t("today.openEvent")}</Out> : null}
          {lead.event.location && <span className="today-where">{lead.event.location}</span>}
        </div>
      ) : model.calendar === "none" ? (
        <div className="today-way"><button type="button" className="today-btn" onClick={() => go("calendar.week")}>{t("page.calendar")}</button></div>
      ) : null}
      {model.calendar === "error" && <p className="today-problem">{t("today.calError")}</p>}
    </section>
  );
}

function DayRow({ row, go }: { row: TodayRow; go: TodayProps["go"] }) {
  if (row.kind === "event") {
    const { event } = row;
    return (
      <li className="today-row" data-past={row.past || undefined} data-now={row.now || undefined}>
        <button type="button" className="today-line" onClick={() => go("calendar.week")}>
          <span className="today-at">{row.at}<small>{row.until}</small></span>
          <span className="today-mk"><i data-k={event.k} /></span>
          <span className="today-body"><span className="today-title">{event.title}</span>{event.location && <span className="today-meta">{event.location}</span>}</span>
        </button>
        {event.meeting && !row.past && <Out href={event.meeting}>{t("today.join")}</Out>}
      </li>
    );
  }
  return (
    <li className="today-row" data-late={row.past || undefined}>
      <button type="button" className="today-line" onClick={() => go("todo.list")}>
        <span className="today-at">{row.at}</span>
        <span className="today-mk"><i className="today-ring" data-k={row.k ?? undefined} /></span>
        <span className="today-body"><span className="today-title">{row.todo.title}</span><span className="today-meta"><span className="today-due">{t("today.due", { at: row.at })}</span></span></span>
      </button>
    </li>
  );
}

/** The day on one line of time, with a line where now is. */
function Day({ model, now, go }: { model: TodayModel; now: number; go: TodayProps["go"] }) {
  const date = new Date(now);
  const minute = date.getHours() * 60 + date.getMinutes();
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const firstAhead = model.rows.findIndex((row) => row.minute > minute && !(row.kind === "event" && row.now));
  const nowLine = <li className="today-nowline" key="now" aria-hidden="true"><span className="today-at">{clock}</span><hr /></li>;
  const empty = !model.rows.length && !model.loose.length && !model.allDay.length && !model.late;
  const [y, m, d] = model.date.split("-").map(Number);
  const dateText = new Date(y, m - 1, d).toLocaleDateString(intlLocale(), { month: "long", day: "numeric", weekday: "short" });
  return (
    <section>
      <Head title={t("today.day")} note={dateText} to={t("page.calendar")} onTo={() => go("calendar.week")} />
      {model.allDay.length > 0 && <p className="today-allday"><span>{t("cal.allDay")}</span>{model.allDay.map((event) => event.title).join(" · ")}</p>}
      {model.rows.length > 0 && (
        <ol className="today-tl">
          {model.rows.flatMap((row, index) => [
            ...(index === firstAhead ? [nowLine] : []),
            <DayRow key={row.kind === "event" ? `e:${row.event.account}:${row.event.id}` : `t:${row.todo.id}`} row={row} go={go} />,
          ])}
          {firstAhead < 0 && nowLine}
        </ol>
      )}
      {model.loose.length > 0 && (
        <>
          <h3 className="today-sub">{t("today.loose")}</h3>
          <ul className="today-rows">
            {model.loose.map(({ todo, k }) => (
              <li key={todo.id}><button type="button" className="today-item" onClick={() => go("todo.list")}>
                <span className="today-ld"><i className="today-ring" data-k={k ?? undefined} /></span><span className="today-t">{todo.title}</span>
              </button></li>
            ))}
          </ul>
        </>
      )}
      {model.late > 0 && <button type="button" className="today-late" data-k="now" onClick={() => go("todo.list")}><i className="mark" />{t("today.late", { n: model.late })}</button>}
      {empty && <p className="today-none">{t("today.nothing")}</p>}
    </section>
  );
}

/** 今天: what is next and where to go in, written from the home node's state. One column, read top to bottom. */
export function Today({ state, name, go, onOpenConversation }: TodayProps) {
  const now = useNow();
  const model = useMemo(() => todayModel(state, now), [state, now]);
  const { waiting, mail, doing, done } = model;
  const moreWaiting = waiting.count - waiting.top.length;
  return (
    <div className="today">
      <div className="today-col">
        <Lede model={model} name={name} now={now} go={go} />

        {waiting.count > 0 && (
          <section>
            <Head title={t("today.waiting")} count={waiting.count} to={moreWaiting > 0 ? t("today.more", { n: moreWaiting }) : t("page.inbox")} onTo={() => go("core.inbox")} />
            <ul className="today-wait">
              {waiting.top.map((item) => (
                <li key={item.id}><button type="button" className="today-card" onClick={() => go("core.inbox", item.id)}>
                  <i className="mark" data-k={kindColour(item.kind)} />
                  <span className="today-t"><b>{item.title}</b>{item.summary && <span>{item.summary}</span>}</span>
                  <time dateTime={item.at}>{when(item.at)}</time>
                </button></li>
              ))}
            </ul>
          </section>
        )}

        <Day model={model} now={now} go={go} />

        {mail.state !== "none" && mail.state !== "sendOnly" && (
          <section>
            <Head title={t("page.mail")} to={t("page.mail")} onTo={() => go("mail.inbox")}
              note={mail.state === "error" ? t("today.mail.error") : !mail.today ? t("today.mail.none") : mail.unread ? t("today.mail.sum", { n: mail.today, unread: mail.unread }) : t("today.mail.read", { n: mail.today })} />
            {mail.rows.length > 0 && (
              <ul className="today-rows">
                {mail.rows.map((message) => (
                  <li key={`${message.account}|${message.id}`}><button type="button" className="today-item" onClick={() => go("mail.inbox", `${message.account}|${message.id}`)}>
                    <span className="today-ld"><Icon name="mail" /></span>
                    <span className="today-t"><b>{message.from}</b><span>{message.subject}</span></span>
                    <time dateTime={message.receivedAt}>{when(message.receivedAt)}</time>
                    {message.snippet && <span className="today-s">{message.snippet}</span>}
                  </button></li>
                ))}
              </ul>
            )}
            {mail.unread > mail.rows.length && <button type="button" className="today-more today-under" onClick={() => go("mail.inbox")}>{t("today.mail.more", { n: mail.unread - mail.rows.length })}<Icon name="down" /></button>}
          </section>
        )}

        <section>
          <Head title={t("today.doing")} />
          <ul className="today-rows">
            {doing.map(({ run, title, sub, session }) => (
              <li key={run.id}><button type="button" className="today-item" onClick={() => onOpenConversation(run.conversationId, run.id)}>
                <span className="today-ld"><i className="today-pulse" /></span>
                <span className="today-t">{title}</span>
                {session && <span className="today-tag"><Icon name="code" />{t("today.session")}</span>}
                {sub && <span className="today-s">{sub}</span>}
              </button></li>
            ))}
            {!doing.length && <li className="today-none">{t("today.doing.none")}</li>}
            {model.upcoming && (
              <li><button type="button" className="today-item" data-quiet onClick={() => go("core.automations")}>
                <span className="today-ld"><Icon name="clock" /></span><span className="today-t">{model.upcoming.name}</span><time>{model.upcoming.when}</time>
              </button></li>
            )}
          </ul>
        </section>

        <section>
          <Head title={t("today.done")} note={done.length ? t("today.done.unseen", { n: done.length }) : undefined} />
          <ul className="today-rows">
            {done.map((item) => (
              <li key={item.key}><button type="button" className="today-item" data-unseen onClick={() => (item.inbox ? go("core.inbox", item.inbox) : onOpenConversation(item.conversationId!))}>
                <span className="today-ld"><i className="mark" data-k="alfred" /></span>
                <span className="today-t">{item.title}</span>
                {item.session && <span className="today-tag"><Icon name="code" />{t("today.session")}</span>}
                <time dateTime={item.at}>{when(item.at)}</time>
                {item.sub && <span className="today-s">{item.sub}</span>}
              </button></li>
            ))}
            {!done.length && <li className="today-none">{t("today.done.none")}</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
