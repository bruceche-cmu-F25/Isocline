import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { fastSpeed, type ConversationDetail, type CoreEvent, type FileInfo, type Run, type RunRequest, type SessionMode, type ThinkingLevel, type ViewContext } from "@zirma/protocol";
import { mergeHistory } from "./conversationHistory.ts";
import { useLiveText } from "./live.ts";
import { ApiError, api } from "./api.ts";
import { Logo, modelMark } from "./brand/Logo.tsx";
import { intlLocale, t, type Key } from "./i18n/index.ts";
import { describeReceipt } from "./receipts.ts";
import { RunFailure } from "./RunFailure.tsx";
import { StopRun, stoppableRun } from "./StopRun.tsx";
import { Diff } from "./Diff.tsx";
import { Linked } from "./Linked.tsx";
import { MessageBubble } from "./MessageBubble.tsx";
import { ReadAloud } from "./speech/ReadAloud.tsx";
import { SelectionActions } from "./SelectionActions.tsx";
import { ConversationReply } from "./ConversationReply.tsx";
import { SkillInput } from "./SkillInput.tsx";
import { Markdown } from "./Markdown.tsx";
import { ModelPicker } from "./shell/ModelPicker.tsx";
import { ChoicePicker } from "./shell/ChoicePicker.tsx";
import { Icon } from "./shell/icons.tsx";
import { MicButton } from "./voice/MicButton.tsx";
import { appendDictation } from "./voice/wav.ts";
import { AttachButton, AttachChips, SentFiles, useComposer } from "./attach.tsx";
import { sends } from "./prefs.ts";

const BUSY = new Set<Run["state"]>(["queued", "running", "cancelling"]);
/** The same empty list each time, so a turn with nothing recorded is not redrawn for a new one. */
const NO_EVENTS: CoreEvent[] = [];

const MESSAGE_LIMIT = 8000;
const quoteText = (text: string) => text.split("\n").map((line) => `> ${line}`).join("\n");

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
/** 950, 1.2k, 34k, 1.3M */
const compact = (n: number) => n < 1000 ? String(Math.round(n)) : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`;
const dollars = (n: number) => n <= 0 ? null : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`;
const took = (ms: number) => ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

interface Spent { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
const spent = (events: CoreEvent[]): Spent => events.reduce((sum, event) => ({
  input: sum.input + num(event.payload.input), output: sum.output + num(event.payload.output),
  cacheRead: sum.cacheRead + num(event.payload.cacheRead), cacheWrite: sum.cacheWrite + num(event.payload.cacheWrite),
  cost: sum.cost + num(event.payload.cost),
}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
/** The lines of a usage tooltip: tokens in and out, cache, cost. */
const spentLines = (total: Spent) => [
  `${t("stats.in")} ${total.input.toLocaleString()}`, `${t("stats.out")} ${total.output.toLocaleString()}`,
  ...(total.cacheRead > 0 ? [`${t("stats.cacheRead")} ${total.cacheRead.toLocaleString()}`] : []),
  ...(total.cacheWrite > 0 ? [`${t("stats.cacheWrite")} ${total.cacheWrite.toLocaleString()}`] : []),
  ...(total.cost > 0 ? [`${t("stats.cost")} $${total.cost.toFixed(4)}`] : []),
];

/** The current time, ticking each second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [on]);
  return now;
}

/** Where a reply stands, shown by the dot beside it, and the one line on what it is doing while it works. */
type Phase = "idle" | "busy" | "waiting" | "failed";
function phase(run: Run, live: string | undefined, runSteps: Array<{ label: string; about: string; status: string; command: boolean }>, held: boolean): { dot: Phase; label: string | null } {
  if (run.request) return { dot: "waiting", label: null };
  switch (run.state) {
    // Held: the turn before it waits on the user, so this one starts when they answer, not by itself.
    case "queued": return held ? { dot: "waiting", label: t("run.held") } : { dot: "busy", label: t("run.queued") };
    case "cancelling": return { dot: "busy", label: t("run.cancelling") };
    case "running": {
      const step = runSteps.findLast((candidate) => candidate.status === "started");
      if (step) return { dot: "busy", label: step.command ? step.about : step.label };
      return { dot: "busy", label: live ? null : t("run.thinking") };
    }
    case "failed": case "interrupted": return { dot: "failed", label: null };
    default: return { dot: "idle", label: null };
  }
}

interface Step {
  id: string; label: string; about: string; status: string;
  /** A command: its exit code once it ended (null: it was stopped), how long it ran, and the end of what it printed. */
  command: boolean; exit?: number | null; ms?: number; output?: string;
}

/** Steps of a run, one line per tool call, at its latest status. */
function steps(activity: CoreEvent[]): Step[] {
  const byStep = new Map<string, Step>();
  for (const event of activity) {
    if (event.kind !== "run.step") continue;
    const id = String(event.payload.step);
    const exit = event.payload.exit;
    byStep.set(id, {
      id, label: String(event.payload.label ?? event.payload.tool), about: String(event.payload.about ?? ""), status: String(event.payload.status),
      command: event.payload.tool === "bash",
      ...(typeof exit === "number" || exit === null ? { exit } : {}),
      ...(typeof event.payload.ms === "number" ? { ms: event.payload.ms } : {}),
      ...(typeof event.payload.output === "string" ? { output: event.payload.output } : {}),
    });
  }
  return [...byStep.values()].filter((step) => step.label !== "Ask");
}

/** A command as a step: the command itself, how it ended, and what it printed, folded away. */
function CommandStep({ step }: { step: Step }) {
  const ended = step.status === "done" || step.status === "failed";
  const how = !ended ? null : step.exit === null || step.exit === undefined ? t("cmd.stopped") : step.exit === 0 ? null : t("cmd.exit", { code: step.exit });
  const line = (
    <>
      <span aria-hidden="true">{STEP_MARK[step.status] ?? "·"}</span> <code className="step-command">{step.about}</code>
      {(how || step.ms !== undefined) && <span className="step-end">{[how, step.ms !== undefined ? took(step.ms) : null].filter(Boolean).join(" · ")}</span>}
    </>
  );
  if (!step.output) return <li data-status={step.status}>{line}</li>;
  return (
    <li data-status={step.status}>
      <details className="step-output">
        <summary>{line}</summary>
        <pre>{step.output}</pre>
      </details>
    </li>
  );
}

const STEP_MARK: Record<string, string> = { started: "…", done: "✓", failed: "✗", declined: "—" };
const PERMISSION_ANSWER: Record<string, Key> = {
  allow: "run.allowed", deny: "run.denied", always: "run.always", allow_session: "run.allowSession",
};

export function Request({ run, request, showQuestion = true, onAnswered }: {
  run: Run; request: RunRequest; showQuestion?: boolean; onAnswered?(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const answer = (value: string) => {
    if (!value.trim() || busy) return;
    setBusy(true);
    setError(null);
    api.respond(run.id, request.id, value.trim()).then(() => onAnswered?.()).catch((reason: Error) => { setError(reason.message); setBusy(false); });
  };
  const permission = request.kind === "permission";
  const command = request.detailKind === "command";
  const site = request.detailKind === "site";
  const siteName = site && request.detail ? (() => { try { return new URL(request.detail).hostname.replace(/^www\./, ""); } catch { return ""; } })() : "";
  return (
    <div className="request" data-notice-item={`r:${run.id}`} data-kind={request.kind} role="group" aria-label={t(permission ? "req.permission" : "req.input")}>
      {showQuestion && <p className="request-question"><Linked text={request.question} /></p>}
      {request.detail && (command || site ? <pre className="request-command">{request.detail}</pre> : <Diff patch={request.detail} />)}
      <div className="request-options">
        {permission ? (
          <>
            <button type="button" disabled={busy} onClick={() => answer("allow")}>{t("common.allow")}</button>
            {request.options.includes("always") && (
              <button type="button" className="ghost" disabled={busy} onClick={() => answer("always")} title={command ? t("req.alwaysCommandTitle", { command: request.grant ?? "" }) : site ? t("req.alwaysSiteTitle", { site: siteName }) : t("req.alwaysTitle")}>{t(command ? "req.alwaysCommand" : site ? "req.alwaysSite" : "req.always")}</button>
            )}
            {request.options.includes("allow_session") && (
              <button type="button" className="ghost" disabled={busy} onClick={() => answer("allow_session")} title={t("mode.edits.hint")}>{t("mode.edits")}</button>
            )}
            <button type="button" className="ghost" disabled={busy} onClick={() => answer("deny")}>{t("common.deny")}</button>
          </>
        ) : request.options.map((option) => (
          <button type="button" key={option} disabled={busy} onClick={() => answer(option)}>{option}</button>
        ))}
      </div>
      {!permission && (
        <form className="request-free" onSubmit={(event) => { event.preventDefault(); answer(text); }}>
          <span className="with-mic">
            <input value={text} onChange={(event) => setText(event.target.value)} placeholder={t("req.free")} aria-label={t("req.answer")} maxLength={2000} disabled={busy} />
            <MicButton className="small" disabled={busy} onText={(words) => setText((now) => appendDictation(now, words))} />
          </span>
        </form>
      )}
      {error && <p className="problem small" role="alert">{error}</p>}
    </div>
  );
}

/** One turn. It follows its own reply as it is written (live.ts), so a word arriving redraws this turn and no other;
 * `onGrow` says the reply got longer, for the list to keep its end in view. */
const Turn = memo(function Turn({ run, receipts, activity, files, highlighted, askedOn, startedBy, latest, unread, held, onGrow }: { run: Run; unread: boolean; receipts: CoreEvent[]; activity: CoreEvent[]; files?: FileInfo[]; highlighted: boolean; askedOn?: string; startedBy?: string; latest: boolean; held: boolean; onGrow(): void }) {
  // The stream ends a moment before the finished reply loads. The words stay up for that moment, so the reply does
  // not empty and fill again.
  const live = useLiveText(run.id, BUSY.has(run.state));
  useLayoutEffect(() => { if (live !== undefined) onGrow(); }, [live, onGrow]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    action().catch((reason: Error) => setError(reason.message)).finally(() => setBusy(false));
  };
  const outcome = run.outcome;
  const runSteps = steps(activity);
  const answers = activity.filter((event) => event.kind === "run.answered");
  const added = activity.filter((event) => event.kind === "run.steered");
  const usage = activity.filter((event) => event.kind === "run.usage").at(-1);
  const working = BUSY.has(run.state);
  const now = useNow(working);
  const { dot, label } = phase(run, live, runSteps, held);
  const elapsed = working ? Math.max(0, now - Date.parse(run.createdAt)) : num(usage?.payload.durationMs) || Math.max(0, Date.parse(run.updatedAt) - Date.parse(run.createdAt));

  const model = typeof usage?.payload.model === "string" ? usage.payload.model : null;
  const mark = modelMark(model);
  const total = usage ? spent([usage]) : null;
  const meta = !working && usage ? [
    ...(model ? [model.split("/").at(-1)!] : []),
    took(elapsed),
    ...(total && (total.input || total.output) ? [`↑${compact(total.input)} ↓${compact(total.output)}`] : []),
    ...(total && dollars(total.cost) ? [dollars(total.cost)!] : []),
  ] : [];
  const metaTitle = usage ? [model, `${t("stats.time")} ${took(elapsed)}`, ...(total && (total.input || total.output) ? spentLines(total) : [])].filter(Boolean).join("\n") : undefined;

  return (
    <li className="turn" data-highlighted={highlighted || undefined} id={`run-${run.id}`}>
      {askedOn && <p className="asked-on">{askedOn}</p>}
      {/* An automation's run: nobody said anything; say which automation started it, and when. */}
      {startedBy ? <p className="asked-on auto-from" title={run.goal}>{startedBy}</p> : <MessageBubble text={run.goal} />}
      <SentFiles files={files} />
      {added.map((event) => <MessageBubble key={event.id} text={String(event.payload.text)} added />)}
      <div className="reply-row">
        <span className="turn-dot" data-phase={dot} data-latest={latest || undefined} aria-hidden="true" />
        <div className="reply-col">
          <div className="reply" data-state={run.state} data-notice-item={outcome ? `result:${run.id}` : undefined}>
            {runSteps.length > 0 && (
              <ol className="steps" aria-label={t("run.steps")}>
                {runSteps.map((step) => step.command ? <CommandStep key={step.id} step={step} /> : (
                  <li key={step.id} data-status={step.status}><span aria-hidden="true">{STEP_MARK[step.status] ?? "·"}</span> {step.label}{step.about ? `：${step.about}` : ""}</li>
                ))}
              </ol>
            )}
            {answers.map((event) => (
              <p className="answered small" key={event.id}>{String(event.payload.question)} → {event.payload.kind === "permission" ? t(PERMISSION_ANSWER[String(event.payload.answer)] ?? "run.denied") : String(event.payload.answer)}</p>
            ))}
            {run.request && <Request key={run.request.id} run={run} request={run.request} />}
            {working && !run.request && (label || !live) && (
              <p className="working" role="status"><span className="working-label">{label ?? t("run.writing")}</span>{!(held && run.state === "queued") && <span className="elapsed">{took(elapsed).replace(/\.\d/, "")}</span>}</p>
            )}
            {live && !outcome && <Markdown className="reply-text live" text={live} />}
            {outcome?.reply && <ConversationReply text={outcome.reply} conversationId={run.conversationId} runId={run.id} unread={unread} />}
            <RunFailure run={run} />
            {run.state === "cancelled" && <p className="quiet">{t("run.cancelled")}</p>}
            {run.state === "interrupted" && <p className="problem">{t("run.interrupted")}</p>}
            {receipts.length > 0 && (
              <ul className="receipts" aria-label={t("run.receipts")}>
                {receipts.map((event) => <li key={event.id}>{describeReceipt(event)}</li>)}
              </ul>
            )}
            {(run.state === "queued" || run.state === "running" || run.state === "interrupted" || run.request) && (
              <div className="turn-actions">
                {run.state === "interrupted" && <button type="button" disabled={busy} onClick={() => act(() => api.resume(run.id))}>{t("common.continue")}</button>}
                <button type="button" className="ghost" disabled={busy} onClick={() => act(() => api.cancel(run.id))}>{t("common.cancel")}</button>
              </div>
            )}
          </div>
          {(meta.length > 0 || outcome?.reply) && (
            <p className="run-meta" title={metaTitle}>
              {meta.map((part, index) => <span key={part}>{mark && index === 0 && <Logo name={mark} />}{part}</span>)}
              {outcome?.reply && <ReadAloud id={`reply:${run.id}`} text={outcome.reply} />}
            </p>
          )}
          {error && <p className="problem small" role="alert">{error}</p>}
        </div>
      </div>
    </li>
  );
});

const MODES: SessionMode[] = ["plan", "ask", "edits"];
const THINKING: Array<[ThinkingLevel | "", Key]> = [["", "think.default"], ["off", "think.off"], ["low", "think.low"], ["medium", "think.medium"], ["high", "think.high"], ["xhigh", "think.xhigh"], ["max", "think.max"]];

type SessionToolbar = (title: string, usage: ReactNode) => ReactNode;

/** The session toolbar and the everyday header share the conversation's existing usage subscription. */
function ConversationHead({ title, detail, sessionToolbar }: { title: string; detail: ConversationDetail | null; sessionToolbar?: SessionToolbar }) {
  const usages = detail ? Object.values(detail.activity).flat().filter((event) => event.kind === "run.usage").sort((a, b) => a.seq - b.seq) : [];
  const usage = usages.at(-1);
  if (sessionToolbar) return sessionToolbar(title, <SessionUsage sample={usage?.payload} />);
  const percent = typeof usage?.payload.percent === "number" ? Math.round(usage.payload.percent) : null;
  return (
    <header className="conversation-head">
      <h1>{title}</h1>
      <Stats total={spent(usages)} percent={percent} window={num(usage?.payload.contextWindow)} />
    </header>
  );
}

/** Pi reports a single context snapshot and the spend for that turn. An absent reading is meaningful after compaction. */
function SessionUsage({ sample }: { sample?: CoreEvent["payload"] }) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const details = disclosure.current;
      if (details?.open && !details.contains(event.target as Node)) details.open = false;
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  const reading = (key: string) => {
    const value = sample?.[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  };
  const used = reading("tokens"), capacity = reading("contextWindow") || null;
  const percent = reading("percent") ?? (used !== null && capacity ? used / capacity * 100 : null);
  const input = reading("input"), output = reading("output"), cost = reading("cost");
  const count = (value: number | null) => value === null ? null : value.toLocaleString(intlLocale());
  const label = t("stats.window");
  if (!sample) return <div className="session-usage pending" role="status" title={t("stats.noReport")} aria-label={`${label} · ${t("stats.noReport")}`}><Icon name="clock" /><strong>{label}</strong><span>{t("stats.noReport")}</span></div>;

  const rows: Array<[Key, string | null]> = [
    ["conv.model", typeof sample.model === "string" ? sample.model : null],
    ["stats.usedTokens", count(used)], ["stats.windowTokens", count(capacity)],
    ["stats.in", count(input)], ["stats.out", count(output)],
    ["stats.cacheRead", count(reading("cacheRead"))], ["stats.cacheWrite", count(reading("cacheWrite"))],
    ["stats.estimate", cost === null ? null : cost.toLocaleString(intlLocale(), { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 })],
  ];
  const tone = percent !== null && percent > 90 ? "full" : percent !== null && percent > 70 ? "high" : undefined;
  const costText = cost === null ? null : dollars(cost);
  return (
    <details className="session-usage" ref={disclosure}
      onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !event.currentTarget.open) return;
        event.stopPropagation();
        event.currentTarget.open = false;
        event.currentTarget.querySelector("summary")?.focus();
      }}>
      <summary title={label} aria-label={percent === null ? label : t("conv.context", { n: Math.round(percent) })}>
        <span className="session-window" data-level={tone}>
          <strong>{label}</strong>
          {percent !== null && <span className="session-gauge" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={Math.min(100, percent)} aria-valuetext={`${Math.round(percent)}%`}><i style={{ width: `${Math.min(100, percent)}%` }} /></span>}
          <b>{percent === null ? "—" : `${Math.round(percent)}%`}</b>
          {(used !== null || capacity !== null) && <span className="session-capacity">{used === null ? "—" : compact(used)} / {capacity === null ? "—" : compact(capacity)}</span>}
        </span>
        <span className="session-turn-usage">
          <span>{t("stats.lastReport")}</span>
          {input !== null && <span aria-label={`${t("stats.in")} ${count(input)}`}>↑ {compact(input)}</span>}
          {output !== null && <span aria-label={`${t("stats.out")} ${count(output)}`}>↓ {compact(output)}</span>}
          {costText && <span>{costText}</span>}
        </span>
        <Icon name="down" />
      </summary>
      <div className="session-report">
        <p>{t("stats.reportHint")}</p>
        <dl>{rows.map(([key, value]) => value !== null && <div key={key}><dt>{t(key)}</dt><dd>{value}</dd></div>)}</dl>
      </div>
    </details>
  );
}

type TuningPatch = { model?: string | null; thinking?: ThinkingLevel | null; speed?: "fast" | null; mode?: SessionMode };
/** What the row under the composer shows: a conversation's own choices, or those picked for one not started yet. */
type Tuned = Pick<ConversationDetail["conversation"], "model" | "thinking" | "speed" | "mode" | "projectId">;
/** Before the first message nothing has been picked: the defaults. */
const UNTUNED: Tuned = { model: null, thinking: null, speed: null, mode: null, projectId: null };

function SessionSettings({ conversation, preferredModel, onChange }: { conversation: Tuned; preferredModel?: string | null; onChange(patch: TuningPatch): void }) {
  const [expanded, setExpanded] = useState(false);
  const optionsId = useId();
  const change = onChange;
  // Fast is offered where the chosen model can write faster; with the default model it is kept and used where it can.
  const slash = conversation.model?.indexOf("/") ?? -1;
  const canFast = !conversation.model || !!fastSpeed(conversation.model.slice(0, slash), conversation.model.slice(slash + 1));
  const mode = conversation.mode ?? "plan";
  const tuningLabel = t("conv.thinkingSpeed");
  const thinking = conversation.thinking ?? "";
  const thinkingOptions = THINKING.map(([value, label]) => ({ value, label: t(label) }));
  const thinkingLabel = thinkingOptions.find((option) => option.value === thinking)?.label ?? thinking;
  const tuningTitle = [thinkingLabel, t(conversation.speed === "fast" ? "speed.fast" : "speed.standard")].join(" · ");
  return (
    <div className="session-settings">
      <div className="session-settings-row">
        <ModelPicker model={conversation.model} preferred={preferredModel} onChange={(model) => change({ model })} />
        {conversation.projectId && (
          <ChoicePicker label={t("mode.title")} value={mode} mode={mode} icon={<Icon name="shield" />}
            options={MODES.map((value) => ({ value, label: t(`mode.${value}` as Key), short: t(`mode.${value}.short` as Key) }))}
            onChange={(value) => change({ mode: value as SessionMode })} />
        )}
        <button type="button" className="pick session-tuning" aria-expanded={expanded} aria-controls={optionsId}
          aria-label={tuningLabel} title={`${tuningLabel} · ${tuningTitle}`} data-custom={!!(conversation.thinking || conversation.speed) || undefined}
          onClick={() => setExpanded((open) => !open)}>
          <Icon name="sliders" /><span>{tuningLabel}</span>
        </button>
      </div>
      <div id={optionsId} className="session-tuning-options" role="group" aria-label={tuningLabel} hidden={!expanded}>
        <ChoicePicker label={t("conv.thinking")} value={thinking} on={!!thinking} icon={<Icon name="bulb" />}
          options={thinkingOptions}
          onChange={(value) => change({ thinking: (value || null) as ThinkingLevel | null })} />
        <ChoicePicker label={t("speed.title")} title={t(canFast ? "speed.hint" : "speed.none")}
          value={conversation.speed ?? ""} fast={conversation.speed === "fast"}
          icon={<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11 3 5 11h4.5L9 17l6-8h-4.5z" /></svg>}
          options={[
            { value: "", label: t("speed.standard") },
            { value: "fast", label: t(canFast ? "speed.fast" : "speed.fastNone"), disabled: !canFast },
          ]}
          onChange={(value) => change({ speed: value === "fast" ? "fast" : null })} />
      </div>
    </div>
  );
}

/** How much the conversation has used, after pi-web (github.com/agegr/pi-web, MIT): tokens in and out, cost, and how full the context is. */
function Stats({ total, percent, window }: { total: Spent; percent: number | null; window: number }) {
  if (!total.input && !total.output && percent === null) return null;
  const cost = dollars(total.cost);
  const level = percent === null ? undefined : percent > 90 ? "full" : percent > 70 ? "high" : undefined;
  const title = [
    ...(total.input || total.output ? spentLines(total) : []),
    ...(percent !== null && window ? [t("stats.context", { n: percent, window: compact(window) })] : []),
  ].join("\n");
  return (
    <span className="conv-stats" role="group" aria-label={t("stats.label")} title={title}>
      {total.input > 0 && <span>↑{compact(total.input)}</span>}
      {total.output > 0 && <span>↓{compact(total.output)}</span>}
      {cost && <span>{cost}</span>}
      {percent !== null && (
        <span className="ctx" data-level={level}>
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="5.5" />
            <circle cx="7" cy="7" r="5.5" pathLength="100" strokeDasharray={`${Math.max(percent, 2)} 100`} transform="rotate(-90 7 7)" />
          </svg>
          {percent}%
        </span>
      )}
    </span>
  );
}

export interface ConversationProps {
  preferredModel?: string | null;
  /** null: a new conversation, started by the first message. */
  id: string | null;
  highlighted: ReadonlySet<string>;
  /** The page a message sent now is asked from; nothing when no page is in view. */
  context?: ViewContext;
  /** Questions to offer, from that page. */
  suggestions: string[];
  /** A page's title by its key, in the current language; for pages this device no longer has, the title saved with the run. */
  pageTitle(view: string): string | undefined;
  /** An automation's name by its id, for runs it started; nothing once it is deleted. */
  automationTitle(id: string): string | undefined;
  onEvent(listener: (event: CoreEvent) => void): () => void;
  /** A run in this conversation opened a module view. */
  onView(module: string, view: string): void;
  onStarted(conversationId: string): void;
  /** In Zirma's panel beside a daily page: the words and what was done, and nothing about the model. No title and
   * usage row, no model and thinking under the composer, and suggestions only before the first question. */
  slim?: boolean;
  /** The model, thinking and speed under the composer even when slim (the Chats page). A new conversation picks
   * them before its first message, which carries them. */
  tuning?: boolean;
  sessionToolbar?: SessionToolbar;
}

export function Conversation({ id, preferredModel, highlighted, context, suggestions, pageTitle, automationTitle, onEvent, onView, onStarted, slim, tuning, sessionToolbar }: ConversationProps) {
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  // Picked for a conversation not started yet; its first message carries it.
  const [pending, setPending] = useState<Tuned>(UNTUNED);
  const { store, text: draft, sending, attachments } = useComposer(sessionToolbar && id ? id : undefined);
  const setDraft = store.setText;
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const readingEarlier = useRef(false);
  const anchor = useRef<{ element: HTMLElement; top: number } | null>(null);
  // The latest onView, without being a reason to load again: the parent hands a new function on every render, and
  // reloading for it emptied the list on every streamed word.
  const view = useRef(onView);
  view.current = onView;

  useEffect(() => {
    setDetail(null);
    if (!id) return;
    let alive = true;
    let timer: number | undefined;
    let fetched = false;
    let loading = false;
    let refresh = false;
    const changed = new Set<string>();
    // New runs and changes to already paged-in turns arrive over the same event stream. Refresh only
    // the affected runs, in order, so an older response can never replace a newer state.
    const load = async () => {
      if (!alive || loading) return;
      loading = true;
      const ids = [...changed].slice(0, 64);
      for (const key of ids) changed.delete(key);
      refresh = false;
      try {
        const next = await api.conversation(id, fetched ? { runs: ids } : undefined);
        if (!alive) return;
        setDetail((current) => current ? mergeHistory(current, next, false) : next);
        fetched = true;
      } catch (reason) {
        if (alive) setError(reason instanceof ApiError && reason.code === "needs_dev" ? t("dev.needsScope") : (reason as Error).message);
        // A subsequent event or reconnection retries any missing updates.
        for (const key of ids) changed.add(key);
        return;
      } finally {
        loading = false;
      }
      if (alive && (refresh || changed.size)) void load();
    };
    void load();
    const off = onEvent((event) => {
      // Anything about this conversation or any run may concern it; reloading is cheap and local.
      if (event.subject !== `conversation:${id}` && !event.runId) return;
      if (event.kind === "run.view" && event.runId) {
        // Only views opened now, by a run here: not ones replayed from history.
        api.run(event.runId).then(({ run }) => { if (run.conversationId === id) view.current(String(event.payload.module), String(event.payload.view)); }).catch(() => {});
      }
      if (event.runId) changed.add(event.runId);
      refresh = true;
      if (timer === undefined) timer = window.setTimeout(() => { timer = undefined; void load(); }, 100);
    });
    return () => { alive = false; window.clearTimeout(timer); off(); };
  }, [id, onEvent]);

  const runs = detail?.runs ?? [];
  const working = runs.find((run) => run.state === "running");
  const stopTarget = stoppableRun(runs);
  // A turn waiting on the user holds the conversation: a new message would queue behind it and never start. So
  // words typed while it asks a question are the answer to that question; a yes-or-no on a change stays a button.
  const waitingOn = runs.find((run) => run.request);
  const asking = waitingOn?.request?.kind === "input" ? waitingOn : undefined;
  // Following a reply keeps its end in view. Someone else's new turn does not interrupt a reader in the past.
  const atEnd = useRef(true);
  const onScroll = () => {
    const el = list.current;
    if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useLayoutEffect(() => {
    const el = list.current;
    const saved = anchor.current;
    if (el && saved && el.contains(saved.element)) {
      el.scrollTop += saved.element.getBoundingClientRect().top - saved.top;
      anchor.current = null;
    } else if (el && atEnd.current) {
      el.scrollTop = el.scrollHeight;
    }
  });
  /** A reply being written got longer (a turn says so itself): its end stays in view for someone reading there. */
  const follow = useCallback(() => {
    const el = list.current;
    if (el && atEnd.current && !anchor.current) el.scrollTop = el.scrollHeight;
  }, []);

  const loadEarlier = async () => {
    const listElement = list.current;
    if (!id || !detail?.nextCursor || !listElement || readingEarlier.current) return;
    readingEarlier.current = true;
    setLoadingEarlier(true);
    try {
      const page = await api.conversation(id, { before: detail.nextCursor });
      if (list.current !== listElement) return;
      const top = listElement.getBoundingClientRect().top;
      const visible = [...listElement.querySelectorAll<HTMLElement>(".turn")].find((turn) => turn.getBoundingClientRect().bottom > top);
      if (visible) anchor.current = { element: visible, top: visible.getBoundingClientRect().top };
      atEnd.current = false;
      setDetail((current) => current && mergeHistory(current, page, true));
    } catch (reason) {
      if (list.current === listElement) setError((reason as Error).message);
    } finally {
      readingEarlier.current = false;
      setLoadingEarlier(false);
    }
  };

  const followUp = (text: string) => {
    const next = `${quoteText(text)}\n\n${store.snapshot().text}`;
    if (next.length > MESSAGE_LIMIT) { setError(t("conv.quoteTooLong")); return; }
    setError(null);
    flushSync(() => setDraft(next));
    field.current?.focus();
    field.current?.setSelectionRange(next.length, next.length);
  };

  const explain = (text: string) => {
    if (!id) return;
    const goal = `${t("conv.explainPrompt")}\n\n${quoteText(text)}`;
    if (goal.length > MESSAGE_LIMIT) { setError(t("conv.quoteTooLong")); return; }
    setError(null);
    atEnd.current = true;
    // An explanation is its own turn. The draft, its files and any pending answer belong to the composer.
    void api.submit(goal, id).catch((reason: Error) => setError(reason.message));
  };

  const steerTarget = attachments.ids.length ? undefined : working;
  const answerTarget = attachments.ids.length ? undefined : asking;
  const hasMessage = !!draft.trim() || attachments.items.length > 0;
  const sendDisabled = (!draft.trim() && !attachments.ids.length) || sending || attachments.busy;
  const sendLabel = t(answerTarget ? "req.answer" : steerTarget ? "composer.steer" : working ? "composer.afterTurn" : "composer.send");
  const send = (text = draft, timing: "default" | "afterTurn" = "default") => {
    // Files alone are a message too: they go with a few words of their own.
    const files = attachments.ids;
    const goal = text.trim() || (files.length ? t("attach.look") : "");
    if (!goal || attachments.busy || !store.beginSend()) return;
    atEnd.current = true;
    setError(null);
    const picked = !id && (pending.model || pending.thinking || pending.speed)
      ? { model: pending.model, thinking: pending.thinking, speed: pending.speed } : undefined;
    const submit = () => api.submit(goal, id ?? undefined, context, files, picked).then(({ run }) => { if (!id) onStarted(run.conversationId); });
    // The target may have just finished, or the question been answered elsewhere. Keep the words as a follow-up.
    const orSubmit = (reason: unknown) => {
      if (reason instanceof ApiError && reason.status === 409) return submit();
      throw reason;
    };
    const attempt = timing === "default" && answerTarget ? api.respond(answerTarget.id, answerTarget.request!.id, goal).then(() => undefined, orSubmit)
      : timing === "default" && steerTarget ? api.steer(steerTarget.id, goal).then(() => undefined, orSubmit)
      : submit();
    attempt
      .then(() => store.sent(text, files))
      .catch((reason: Error) => setError(reason.message))
      .finally(() => store.endSend());
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends and Shift+Enter breaks the line, or ⌘Enter sends (Settings → General); never while an IME is composing.
    if (sends(event)) {
      event.preventDefault();
      send();
    }
  };

  // Which page a question came from, said once each time it changes, not on every turn.
  const startedBy = (run: Run) => run.automationId
    ? t("auto.fromAt", { name: automationTitle(run.automationId) ?? t("auto.removed"), at: new Date(run.createdAt).toTimeString().slice(0, 5) })
    : undefined;
  // Leaving the page is said too: a question asked with Zirma across the window is not about the page before it.
  const askedOn = (run: Run, previous: Run | undefined) => {
    if (run.automationId || run.context?.view === previous?.context?.view) return undefined;
    if (run.context?.view === "core.voice") return t("conv.askedByVoice");
    if (run.context) return t("conv.askedFrom", { page: pageTitle(run.context.view) ?? run.context.title ?? run.context.view });
    return previous ? t("conv.askedHere") : undefined;
  };
  const offer = !draft.trim() && !working && !sending && suggestions.length > 0 && (!slim || runs.length === 0);

  return (
    <section className="conversation" data-slim={slim || undefined} aria-label={detail?.conversation.title ?? t("conv.new")}>
      {!slim && <ConversationHead title={id ? detail?.conversation.title ?? "…" : t("conv.new")} detail={detail} sessionToolbar={sessionToolbar} />}
      {!id || runs.length === 0 ? (
        <div className="empty">
          <p className="empty-title">{t("conv.emptyTitle")}</p>
          <p className="quiet">{t("conv.emptyHint")}</p>
        </div>
      ) : (
        <ol className="turns" ref={list} onScroll={onScroll}>
          {detail?.nextCursor && <li className="earlier-turns">
            <button className="link" type="button" disabled={loadingEarlier} onClick={loadEarlier}>{t(loadingEarlier ? "auto.loading" : "conv.earlier")}</button>
          </li>}
          {runs.map((run, index) => (
            <Turn key={run.id} run={run} unread={detail?.conversation.unreadReplyId === run.id} receipts={detail?.receipts[run.id] ?? NO_EVENTS} activity={detail?.activity[run.id] ?? NO_EVENTS}
              files={detail?.files?.[run.id]} onGrow={follow} highlighted={highlighted.has(run.id)} askedOn={askedOn(run, runs[index - 1])} startedBy={startedBy(run)} latest={index === runs.length - 1} held={!!waitingOn && waitingOn.id !== run.id} />
          ))}
        </ol>
      )}
      {id && runs.length > 0 && <SelectionActions list={list} onFollowUp={followUp} onExplain={explain} />}
      {offer && (
        <div className="suggestions" role="group" aria-label={t("chips.label")}>
          {suggestions.map((text) => <button type="button" key={text} className="suggestion" onClick={() => send(text)}>{text}</button>)}
        </div>
      )}
      <form className="composer" onSubmit={(event) => { event.preventDefault(); send(); }} onPaste={attachments.onPaste} onDrop={attachments.onDrop} onDragOver={attachments.onDragOver}>
        <AttachChips attachments={attachments} />
        <SkillInput
          field={field}
          skills={!!sessionToolbar && !asking}
          value={draft}
          onValueChange={setDraft}
          onKeyDown={onKey}
          rows={Math.min(6, Math.max(1, draft.split("\n").length))}
          placeholder={t(answerTarget ? "composer.answer" : steerTarget ? "composer.working" : id ? "composer.continue" : "composer.new")}
          aria-label={t("composer.label")}
          maxLength={MESSAGE_LIMIT}
        />
        <div className="composer-bar">
          <span className="grow" />
          <AttachButton attachments={attachments} />
          <MicButton onText={(words) => { setDraft((now) => appendDictation(now, words)); field.current?.focus(); }} />
          <span className="composer-send-actions">
            {steerTarget && hasMessage && <button type="button" className="send-after" disabled={sendDisabled} onClick={() => send(draft, "afterTurn")}>
              {t("composer.afterTurn")}
            </button>}
            {stopTarget && <StopRun key={stopTarget.id} run={stopTarget} onError={setError} />}
            {(!stopTarget || hasMessage) && <button type="submit" className="send" disabled={sendDisabled} aria-label={sendLabel} title={sendLabel}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11M11 5l5 5-5 5" /></svg>
            </button>}
          </span>
        </div>
      </form>
      {(!slim || tuning) && (id ? detail && <SessionSettings conversation={detail.conversation} preferredModel={preferredModel} onChange={(patch) => {
        setError(null);
        api.updateConversation(id, patch).catch((reason: Error) => setError(reason.message));
      }} /> : <SessionSettings conversation={pending} preferredModel={preferredModel} onChange={(patch) => setPending((now) => ({ ...now, ...patch }))} />)}
      {error && <p className="problem small composer-error" role="alert">{error}</p>}
    </section>
  );
}
