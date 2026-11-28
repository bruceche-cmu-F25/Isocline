import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type { Automation, Run, StateResponse } from "@zirma/protocol";
import { api, type AutomationOptions } from "./api.ts";
import { automationTitle, hhmm, scheduleText, whenText } from "./automationText.ts";
import { AutomationHistory } from "./AutomationHistory.tsx";
import { errorText } from "./receipts.ts";
import { Icon } from "./shell/icons.tsx";
import { MicButton } from "./voice/MicButton.tsx";
import { appendDictation } from "./voice/wav.ts";
import { t, type Key } from "./i18n/index.ts";

const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
function lastText(automation: Automation): string {
  const run = automation.lastRun;
  if (!run) return t("auto.never");
  if (run.state === "queued" || run.state === "running" || run.state === "cancelling") return t("auto.lastRunning");
  // A firing that failed before doing anything is tried again (core automation-retries.ts): say when.
  if (run.retryAt) return t("auto.retryAt", { when: whenText(run.retryAt) });
  if (run.state === "failed" || run.state === "interrupted") return run.tries ? t("auto.lastFailedTries", { n: run.tries, when: whenText(run.at) }) : t("auto.lastFailed", { when: whenText(run.at) });
  return t("auto.last", { when: whenText(run.at) });
}

/** The options every automation has, and the colours it can take (core automations.ts). */
const LAYOUTS = ["text", "sections"] as const;
const KEEPS = ["all", "latest"] as const;
const NOTIFIES = ["always", "changes"] as const;
const COLOURS = ["blue", "green", "violet", "orange", "teal", "yellow", "pink", "gray"] as const;

function Choices<T extends string>({ label, value, options, onChange, text }: { label: string; value: T; options: readonly T[]; onChange(value: T): void; text(value: T): string }) {
  return (
    <div className="field" role="radiogroup" aria-label={label}>
      <span>{label}</span>
      <div className="day-picks">
        {options.map((option) => <button type="button" key={option} className="day-pick" role="radio" aria-checked={value === option} aria-pressed={value === option} onClick={() => onChange(option)}>{text(option)}</button>)}
      </div>
    </div>
  );
}

/** Making or changing one: its name, what to do, when, and how its results are shown and told. A sample (the morning
 * brief) is changed like any other: its words are shown in full, and kept as the user's once they change them. */
function AutomationForm({ automation, onDone }: { automation?: Automation; onDone(saved?: Automation): void }) {
  const template = automation?.template ?? null;
  const shownName = automation ? automationTitle(automation) : "";
  const shownGoal = automation?.instruction ?? automation?.goal ?? "";
  const [name, setName] = useState(shownName);
  const [goal, setGoal] = useState(shownGoal);
  const [options, setOptions] = useState<AutomationOptions>({
    layout: automation?.layout ?? "text", keep: automation?.keep ?? "all", notify: automation?.notify ?? "always", k: automation?.k ?? "green",
  });
  const option = <K extends keyof AutomationOptions>(key: K) => (value: AutomationOptions[K]) => setOptions((current) => ({ ...current, [key]: value }));
  const [at, setAt] = useState(automation?.schedule.at ?? "08:00");
  const [days, setDays] = useState<number[]>(automation?.schedule.days ?? EVERY_DAY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = t("auto.dayNames").split(",");
  const ready = /^\d\d:\d\d$/.test(at) && days.length > 0 && !!name.trim() && !!goal.trim();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const schedule = { at, days };
    // A sample keeps following the language until its words are changed.
    const words = {
      ...(!template || name.trim() !== shownName ? { name: name.trim() } : {}),
      ...(!template || goal.trim() !== shownGoal.trim() ? { goal: goal.trim() } : {}),
    };
    const request = automation
      ? api.updateAutomation(automation.id, { ...words, schedule, ...options })
      : api.createAutomation({ name: name.trim(), goal: goal.trim(), schedule, ...options });
    request.then((saved) => onDone(saved)).catch((reason: Error) => { setError(reason.message); setBusy(false); });
  };
  const toggleDay = (day: number) => setDays((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort());

  return (
    <form className="auto-form" onSubmit={submit} aria-label={automation ? automationTitle(automation) : t("auto.newTitle")}>
      <label className="field">
        <span>{t("auto.name")}</span>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("auto.namePlaceholder")} maxLength={60} autoFocus={!automation} />
      </label>
      <label className="field">
        <span>{t("auto.goal")}</span>
        <span className="with-mic">
          <textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder={t("auto.goalPlaceholder")} maxLength={2000} rows={3} />
          <MicButton className="small" onText={(words) => setGoal((now) => appendDictation(now, words))} />
        </span>
      </label>
      <div className="auto-when">
        <label className="field">
          <span>{t("auto.time")}</span>
          <input type="time" value={at} onChange={(event) => setAt(event.target.value)} required />
        </label>
        <div className="field" role="group" aria-label={t("auto.days")}>
          <span>{t("auto.days")}</span>
          <div className="day-picks">
            {EVERY_DAY.map((day) => (
              <button type="button" key={day} className="day-pick" aria-pressed={days.includes(day)} onClick={() => toggleDay(day)}>{names[day - 1]}</button>
            ))}
          </div>
        </div>
      </div>
      {days.length === 0 && <p className="quiet small">{t("auto.daysNeeded")}</p>}
      <details className="auto-more" open={!!automation && (options.layout !== "text" || options.keep !== "all" || options.notify !== "always")}>
        <summary><Icon name="down" />{t("auto.more")}</summary>
        <div className="auto-options">
          <Choices label={t("auto.layout")} value={options.layout} options={LAYOUTS} onChange={option("layout")} text={(value) => t(`auto.layout.${value}`)} />
          <Choices label={t("auto.keep")} value={options.keep} options={KEEPS} onChange={option("keep")} text={(value) => t(`auto.keep.${value}`)} />
          <Choices label={t("auto.notify")} value={options.notify} options={NOTIFIES} onChange={option("notify")} text={(value) => t(`auto.notify.${value}`)} />
          <div className="field" role="radiogroup" aria-label={t("auto.colour")}>
            <span>{t("auto.colour")}</span>
            <div className="auto-colours">
              {COLOURS.map((k) => <button type="button" key={k} data-k={k} className="auto-colour" role="radio" aria-checked={options.k === k} aria-label={t(`areas.k.${k}`)} onClick={() => option("k")(k)} />)}
            </div>
          </div>
        </div>
      </details>
      {error && <p className="problem small" role="alert">{error}</p>}
      <div className="auto-form-actions">
        <button type="submit" disabled={!ready || busy}>{t(automation ? "auto.save" : "auto.create")}</button>
        <button type="button" className="ghost" onClick={() => onDone()}>{t("common.cancel")}</button>
      </div>
    </form>
  );
}

/** One automation, as the page: its name and switch, when it runs and how it last went, what it does, and its runs
 * (the newest one's result is open there). */
function AutomationPage({ automation, recent, onOpenConversation, onPick }: {
  automation: Automation; recent: Run[]; onOpenConversation(conversationId: string, runId?: string): void;
  /** Go to another automation (a copy just made), or to the first one left (after deleting this one). */
  onPick(id: string | null): void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const act = <T,>(action: () => Promise<T>, then?: (result: T) => void) => {
    setBusy(true);
    setError(null);
    action().then((result) => then?.(result)).catch((reason: Error) => setError(reason.message)).finally(() => setBusy(false));
  };
  const title = automationTitle(automation);
  // Why the last run failed, when the run knows (no model yet, the model's side, a timeout).
  const why = automation.lastRun?.state === "failed" ? errorText(automation.lastRun.error) : "";
  const remove = () => {
    if (!confirming) return setConfirming(true);
    setConfirming(false);
    act(() => api.deleteAutomation(automation.id), () => onPick(null));
  };

  if (editing) return <AutomationForm automation={automation} onDone={() => setEditing(false)} />;
  return (
    <>
      <header className="auto-head" data-k={automation.k}>
        <i><Icon name="clock" /></i>
        <h2>{title}</h2>
        <button type="button" className="switch" role="switch" aria-checked={automation.enabled} disabled={busy} aria-label={t("auto.toggle", { name: title })}
          onClick={() => act(() => api.updateAutomation(automation.id, { enabled: !automation.enabled }))} />
      </header>
      <p className="auto-meta">
        <span>{scheduleText(automation.schedule)}</span>
        <span>{automation.enabled && automation.nextAt ? t("auto.next", { when: whenText(automation.nextAt) }) : t("auto.off")}</span>
        <span className="auto-last" data-state={automation.lastRun?.state}>{lastText(automation)}</span>
      </p>
      {why && <p className="auto-why">{why}</p>}
      <div className="auto-actions">
        <button type="button" className="ghost small" disabled={busy} onClick={() => act(() => api.runAutomation(automation.id))}>{t("auto.runNow")}</button>
        <button type="button" className="ghost small" disabled={busy} onClick={() => setEditing(true)}>{t("auto.edit")}</button>
        <button type="button" className="ghost small" disabled={busy} title={t("auto.copy.note")} onClick={() => act(() => api.createAutomation({
          name: t("auto.copyName", { name: title }).slice(0, 60), goal: automation.instruction, schedule: automation.schedule, enabled: false,
          layout: automation.layout, keep: automation.keep, notify: automation.notify, k: automation.k,
        }), (copy) => onPick(copy.id))}>{t("auto.copy")}</button>
        <button type="button" className={confirming ? "ghost small danger" : "ghost small"} disabled={busy} onClick={remove}>{t(confirming ? "auto.confirmDelete" : "auto.delete")}</button>
      </div>
      {error && <p className="problem small" role="alert">{error}</p>}
      <section className="auto-part" aria-label={t("auto.what")}>
        <h3>{t("auto.what")}</h3>
        <p className="auto-words">{automation.instruction}</p>
        <p className="quiet small">{t("auto.note")}</p>
      </section>
      {automation.lastRun && <AutomationHistory key={automation.lastRun.id} automation={automation} recent={recent} onOpenConversation={onOpenConversation} />}
    </>
  );
}

/** Below this page width the list and the open automation take turns (as the Chats page does). */
const NARROW = 720;
/** Which one was open, for coming back to the page: an automation's id, or `new` for the form. */
let lastPicked: string | null = null;

/** The automations page: the list of rules is the page's own side column (in the app sidebar while it has room,
 * workspace-architecture.md §6), and the page is the one picked: when, what, how it went; switch, run now, change,
 * copy, delete. */
export function Automations({ state, side, onOpenConversation }: { state: StateResponse; side: HTMLElement | null; onOpenConversation(conversationId: string, runId?: string): void }) {
  const page = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  // On a narrow page without the sidebar, whether the list is showing (else the open automation).
  const [listing, setListing] = useState(true);
  const [picked, setPicked] = useState<string | null>(lastPicked);
  const automations = state.automations ?? [];
  // Nothing picked, or the one picked is gone: the first. None at all: the form.
  const adding = picked === "new" || !automations.length;
  const open = adding ? null : automations.find((automation) => automation.id === picked) ?? automations[0]!;
  const pick = (id: string | null) => { lastPicked = id; setPicked(id); setListing(false); };

  useEffect(() => {
    const element = page.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry!.contentRect.width < NARROW));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const list = (
    <nav className="st-list au-list" aria-label={t("page.automations")}>
      <button type="button" className="st-node" aria-current={adding && automations.length ? "true" : undefined} onClick={() => pick("new")}>
        <span className="st-space" /><Icon name="plus" /><span className="st-name">{t("auto.new")}</span>
      </button>
      {automations.length === 0 && <p className="au-hint">{t("auto.sum.empty")}</p>}
      {automations.map((automation) => {
        const failed = automation.lastRun?.state === "failed" || automation.lastRun?.state === "interrupted";
        return (
          <button type="button" key={automation.id} className="st-node au-row" data-off={!automation.enabled || undefined} title={automation.instruction}
            aria-current={open?.id === automation.id ? "true" : undefined} onClick={() => pick(automation.id)}>
            <span className="st-space"><i className="au-dot" data-k={automation.k} data-failed={failed || undefined} /></span>
            <span className="st-name">{automationTitle(automation)}</span>
            <span className="st-count au-when">{automation.enabled && automation.nextAt ? hhmm(new Date(automation.nextAt)) : t("auto.off")}</span>
          </button>
        );
      })}
    </nav>
  );

  // Where the list goes: the app sidebar while it has room; else in the page, beside the open automation or, narrow,
  // instead of it.
  const listHere = !side;
  const showList = listHere && (!narrow || listing);
  const showOpen = !listHere || !narrow || !listing;
  return (
    <section className="automations" ref={page} data-narrow={narrow || undefined} data-list={listHere || undefined} aria-label={t("auto.label")}>
      {side && createPortal(list, side)}
      {showList && list}
      {showOpen && (
        <article className="auto-one" aria-label={open ? automationTitle(open) : t("auto.newTitle")}>
          {listHere && narrow && <button type="button" className="auto-back" onClick={() => setListing(true)}><Icon name="back" /><span>{t("page.automations")}</span></button>}
          {open
            ? <AutomationPage key={open.id} automation={open} recent={state.runs} onOpenConversation={onOpenConversation} onPick={pick} />
            : <>
                <h2 className="auto-new-title">{t("auto.newTitle")}</h2>
                <AutomationForm key="new" onDone={(made) => (made ? pick(made.id) : automations.length ? pick(null) : undefined)} />
              </>}
        </article>
      )}
    </section>
  );
}
