import { useEffect, useState, type FormEvent } from "react";
import type { Automation, Run, StateResponse } from "@isocline/protocol";
import { api, type AutomationOptions } from "./api.ts";
import { automationTitle, scheduleText, whenText } from "./automationText.ts";
import { AutomationHistory } from "./AutomationHistory.tsx";
import { Linked } from "./Linked.tsx";
import { plainText } from "./markdown.ts";
import { Icon } from "./shell/icons.tsx";
import { MicButton } from "./voice/MicButton.tsx";
import { appendDictation } from "./voice/wav.ts";
import { t, type Key } from "./i18n/index.ts";

const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
function lastText(automation: Automation): string {
  const run = automation.lastRun;
  if (!run) return t("auto.never");
  if (run.state === "queued" || run.state === "running" || run.state === "cancelling") return t("auto.lastRunning");
  if (run.state === "failed" || run.state === "interrupted") return t("auto.lastFailed", { when: whenText(run.at) });
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
function AutomationForm({ automation, onDone }: { automation?: Automation; onDone(): void }) {
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
    request.then(onDone).catch((reason: Error) => { setError(reason.message); setBusy(false); });
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
        <button type="button" className="ghost" onClick={onDone}>{t("common.cancel")}</button>
      </div>
    </form>
  );
}

function AutomationRow({ automation, recent, onOpenConversation }: { automation: Automation; recent: Run[]; onOpenConversation(conversationId: string, runId?: string): void }) {
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState<string | null>(null);
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
  const about = automation.goal ?? (automation.template ? t(`auto.tpl.${automation.template}.goal` as Key) : "");
  const remove = () => {
    if (!confirming) return setConfirming(true);
    setConfirming(false);
    act(() => api.deleteAutomation(automation.id));
  };

  if (editing) return <li className="auto-row editing"><AutomationForm automation={automation} onDone={() => setEditing(false)} /></li>;
  return (
    <li className="auto-row" data-enabled={automation.enabled || undefined}>
      <div className="auto-name" data-k={automation.k}>
        <i><Icon name="clock" /></i>
        <span>
          <b>{title}</b>
          <small title={about}>{about}</small>
        </span>
      </div>
      <div className="auto-sched">
        <span>{scheduleText(automation.schedule)}</span>
        <small>{automation.enabled && automation.nextAt ? t("auto.next", { when: whenText(automation.nextAt) }) : t("auto.off")}</small>
      </div>
      <div className="auto-last" data-state={automation.lastRun?.state}>
        <span>{lastText(automation)}</span>
        {automation.lastRun?.reply && <small><Linked text={plainText(automation.lastRun.reply)} /></small>}
        {automation.lastRun && <button type="button" className="link" aria-expanded={!!history} onClick={() => setHistory(history ? null : "latest")}>{t("auto.history")}</button>}
      </div>
      <div className="auto-actions">
        <button type="button" className="switch" role="switch" aria-checked={automation.enabled} disabled={busy} aria-label={t("auto.toggle", { name: title })}
          onClick={() => act(() => api.updateAutomation(automation.id, { enabled: !automation.enabled }))} />
        <button type="button" className="ghost small" disabled={busy}
          onClick={() => act(() => api.runAutomation(automation.id), (run) => setHistory(run.id))}>{t("auto.runNow")}</button>
        <button type="button" className="ghost small" disabled={busy} onClick={() => setEditing(true)}>{t("auto.edit")}</button>
        <button type="button" className="ghost small" disabled={busy} title={t("auto.copy.note")} onClick={() => act(() => api.createAutomation({
          name: t("auto.copyName", { name: title }).slice(0, 60), goal: automation.instruction, schedule: automation.schedule, enabled: false,
          layout: automation.layout, keep: automation.keep, notify: automation.notify, k: automation.k,
        }))}>{t("auto.copy")}</button>
        <button type="button" className={confirming ? "ghost small danger" : "ghost small"} disabled={busy} onClick={remove}>{t(confirming ? "auto.confirmDelete" : "auto.delete")}</button>
      </div>
      {history && <AutomationHistory key={history} automation={automation} recent={recent} onOpenConversation={onOpenConversation} />}
      {error && <p className="problem small auto-error" role="alert">{error}</p>}
    </li>
  );
}

/** The automations page: each rule, when it fires next, how it last went; switch, run now, change, delete, add. */
export function Automations({ state, onOpenConversation }: { state: StateResponse; onOpenConversation(conversationId: string, runId?: string): void }) {
  const [adding, setAdding] = useState(false);
  const automations = state.automations ?? [];
  return (
    <section className="automations" aria-label={t("auto.label")}>
      <p className="auto-note quiet">{t("auto.note")}</p>
      {automations.length === 0 && !adding && <p className="quiet empty-list">{t("auto.sum.empty")}</p>}
      <ul className="auto-list">
        {automations.map((automation) => <AutomationRow key={automation.id} automation={automation} recent={state.runs} onOpenConversation={onOpenConversation} />)}
        {adding && <li className="auto-row editing"><AutomationForm onDone={() => setAdding(false)} /></li>}
      </ul>
      {!adding && (
        <button type="button" className="auto-add" onClick={() => setAdding(true)}><Icon name="plus" />{t("auto.new")}</button>
      )}
    </section>
  );
}
