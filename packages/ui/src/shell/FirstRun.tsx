/** The first run (docs/design/today-and-inbox.md, 6): full screen, the first time Isocline is opened. Name, a model,
 * Google, when to write each morning, then the figure walks round the real workspace and says one line at each
 * place. Every step can be skipped and done later in Settings; a step that is already set is not shown, so someone
 * who was using Isocline before this existed sees only what is new to them. Finished or skipped, the home node
 * remembers (`firstRunAt`), so it is shown once, on whichever device opens first.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type { ConnectionsResponse, ModelAccountsResponse, StateResponse } from "@isocline/protocol";
import { Accounts } from "../Accounts.tsx";
import { ModelSettings } from "../ModelSettings.tsx";
import { api, request as call } from "../api.ts";
import { t, type Key } from "../i18n/index.ts";
import { Figure } from "./Figure.tsx";
import { owedSteps, withoutSamples, type FirstRunStep } from "./first-run.ts";
import { automationTitle } from "../automationText.ts";
import "./first-run.css";

/** How long "nice to meet you" is up before the next step. */
const MET_MS = 1500;

export interface TourPlace { phone: boolean; show(stop: TourStop): void }
export type TourStop = "today" | "inbox" | "ask" | "pages";
const STOPS: TourStop[] = ["today", "inbox", "ask", "pages"];

/** The thing on screen a stop is about. A phone has the dock where a desktop has the sidebar and the ask bar. */
function targetOf(stop: TourStop, phone: boolean): Element | null {
  if (stop === "today") return document.querySelector(".today-lede") ?? document.querySelector("main.page .page-body");
  if (stop === "inbox") return document.querySelector(`${phone ? ".dock" : ".sidebar"} [data-page="core.inbox"]`);
  if (stop === "ask") return document.querySelector(phone ? ".dock-alfred" : ".ask-form") ?? document.querySelector(".ask");
  return document.querySelector(phone ? ".dock-tabs" : ".sidebar .nav");
}

/** The figure in the real workspace: everything dims but the place it is talking about. */
function Tour({ place, onEnd }: { place: TourPlace; onEnd(): void }) {
  const [at, setAt] = useState(0);
  const [box, setBox] = useState<{ spot: CSSProperties; card: CSSProperties } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const stop = STOPS[at], last = at === STOPS.length - 1;
  const show = useRef(place.show);
  show.current = place.show;

  useEffect(() => { show.current(stop); }, [stop]);

  // The target is looked for until it is there (a page or the sidebar may still be coming in), then followed.
  useLayoutEffect(() => {
    let frame = 0, tries = 0;
    const measure = () => {
      const target = targetOf(stop, place.phone), say = card.current;
      if (!say) return;
      const w = say.offsetWidth, h = say.offsetHeight, vw = window.innerWidth, vh = window.innerHeight, gap = 14, pad = 6;
      const r = target?.getBoundingClientRect();
      if (!r || !r.width || !r.height) {
        if (tries++ < 40) { frame = requestAnimationFrame(measure); return; }
        // Nothing to point at (a page that did not come up): the words still say it, in the middle.
        setBox({ spot: { left: vw / 2, top: vh / 2, width: 0, height: 0, opacity: 0 }, card: { left: Math.max(12, (vw - w) / 2), top: Math.max(12, (vh - h) / 2) } });
        return;
      }
      let left = r.left, top = r.bottom + gap;
      if (!place.phone && r.height > vh * 0.5) { left = r.right + gap; top = r.top + 60; }      // a tall thing: beside it
      else if (top + h > vh - 12) top = r.top - gap - h;                                          // no room below: above it
      else if (!place.phone && r.width < 260) { left = r.right + gap; top = r.top - 10; }         // a small thing in the sidebar: beside it
      setBox({
        spot: { left: r.left - pad, top: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 },
        card: { left: Math.max(12, Math.min(left, vw - w - 12)), top: Math.max(12, Math.min(top, vh - h - 12)) },
      });
    };
    const again = () => { tries = 0; cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    again();
    // The sidebar opening and the page changing move things after the first measure.
    const settle = window.setTimeout(again, 320);
    window.addEventListener("resize", again);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(settle); window.removeEventListener("resize", again); };
  }, [stop, place.phone]);

  useEffect(() => { next.current?.focus({ preventScroll: true }); }, [at]);
  const forward = useCallback(() => { if (last) onEnd(); else setAt((n) => n + 1); }, [last, onEnd]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onEnd(); }
      else if (event.key === "ArrowRight") { event.preventDefault(); forward(); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); setAt((n) => Math.max(0, n - 1)); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [forward, onEnd]);

  return (
    <div className="first-tour">
      <div className="first-spot" style={box?.spot ?? { opacity: 0 }} />
      <div className="first-say" ref={card} role="dialog" aria-modal="true" aria-labelledby="first-say-title" style={box ? box.card : { visibility: "hidden" }}>
        <Figure state="rest" size={48} />
        <div>
          <b id="first-say-title">{t(`first.tour.${stop}` as Key)}</b>
          <p>{t(`first.tour.${stop}.text` as Key)}</p>
          <div className="first-say-acts">
            <button type="button" className="first-skip" onClick={onEnd}>{t("first.skipTour")}</button>
            <span className="first-count">{at + 1} / {STOPS.length}</span>
            <button type="button" className="first-go small" ref={next} onClick={forward}>{t(last ? "first.start" : "first.nextStop")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function FirstRun({ state, name, saveName, place, onDone }: {
  state: StateResponse; name: string | null; saveName(name: string): Promise<void>; place: TourPlace; onDone(): void;
}) {
  // What is owed is decided once, when it opens: a step does not vanish from under the user while they are on it.
  const [steps, setSteps] = useState<FirstRunStep[] | null>(null);
  const [at, setAt] = useState(0);
  const [met, setMet] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  // The automations Isocline ships with, still off when this opened: each can be switched on here, at a time of its own.
  const [samples] = useState(() => (state.automations ?? []).filter((automation) => automation.template && !automation.enabled));
  const [picked, setPicked] = useState<Record<string, { on: boolean; at: string }>>(() =>
    Object.fromEntries(samples.map((sample) => [sample.id, { on: true, at: sample.schedule.at }])));
  const opened = useRef({ name, samples: (state.automations ?? []).filter((automation) => automation.template) });

  useEffect(() => {
    let alive = true;
    Promise.all([
      call<ModelAccountsResponse>("/api/connections/models").then((data) => data.providers.filter((provider) => provider.status.configured).length, () => null),
      call<ConnectionsResponse>("/api/connections").then((data) => ({ accounts: data.google.accounts.length, ready: data.google.client.configured }), () => null),
    ]).then(([models, google]) => { if (alive) setSteps(owedSteps({ ...opened.current, models, google })); });
    return () => { alive = false; };
  }, []);

  const finish = useCallback(() => {
    // Remembered by the home node; this window moves on whether or not that write gets through.
    api.settings({ firstRunAt: new Date().toISOString() }).catch(() => {});
    onDone();
  }, [onDone]);

  const step = steps?.[at];
  const forward = useCallback(() => {
    setError(null);
    setConnected(false);
    // Without a model there is nothing to run each morning: that question waits until one is connected.
    if (step === "model" && !connected) setSteps((owed) => owed && withoutSamples(owed));
    setAt((n) => n + 1);
  }, [step, connected]);

  // "Nice to meet you" stays a moment, or until a key or a click, then the next step.
  useEffect(() => {
    if (!met) return;
    const go = () => { setMet(null); forward(); };
    const timer = window.setTimeout(go, MET_MS);
    document.addEventListener("keydown", go);
    document.addEventListener("pointerdown", go);
    return () => { window.clearTimeout(timer); document.removeEventListener("keydown", go); document.removeEventListener("pointerdown", go); };
  }, [met, forward]);

  async function submitName(event: FormEvent) {
    event.preventDefault();
    const said = draft.trim();
    if (busy || !said) return;
    setBusy(true);
    setError(null);
    try {
      await saveName(said);
      setMet(said);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function startSamples() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      for (const sample of samples) {
        const choice = picked[sample.id];
        if (choice?.on) await api.updateAutomation(sample.id, { schedule: { at: choice.at, days: sample.schedule.days }, enabled: true });
      }
      forward();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (step === "tour") return createPortal(<Tour place={place} onEnd={finish} />, document.body);

  const foot = steps && step && (
    <div className="first-foot">
      <span className="first-dots" aria-hidden="true">{steps.map((id, n) => <i key={id} data-on={n === at || undefined} />)}</span>
      <button type="button" onClick={forward}>{t("first.skip")}</button>
    </div>
  );

  return createPortal(
    <div className="first" role="dialog" aria-modal="true" aria-label={t("first.label")} data-wide={step === "model" || step === "google" || undefined}>
      <div className="first-in" key={met ? "met" : step ?? "wait"}>
        <Figure state={step === "name" || met ? "hello" : "rest"} size={104} centered />
        {met ? (
          <p className="first-line" role="status">{t("first.met", { name: met })}</p>
        ) : step === "name" ? (
          <>
            <h2><label htmlFor="first-name">{t("first.name.ask")}</label></h2>
            <form className="first-form" onSubmit={submitName} aria-busy={busy}>
              <input id="first-name" name="nickname" autoComplete="nickname" maxLength={80} autoFocus placeholder={t("first.name.placeholder")}
                value={draft} onChange={(event) => setDraft(event.target.value)} readOnly={busy} />
              <button type="submit" className="first-go" disabled={busy || !draft.trim()}>{t("common.continue")}</button>
            </form>
          </>
        ) : step === "model" ? (
          <>
            <h2>{t("first.model.title")}</h2>
            <p>{t("first.model.text")}</p>
            <div className="first-set"><ModelSettings setup onConfigured={(n) => setConnected(n > 0)} /></div>
            {connected && <button type="button" className="first-go" onClick={forward}>{t("common.continue")}</button>}
          </>
        ) : step === "google" ? (
          <>
            <h2>{t("first.google.title")}</h2>
            <p>{t("first.google.text")}</p>
            <div className="first-set"><Accounts setup onConfigured={(n) => setConnected(n > 0)} /></div>
            {connected && <button type="button" className="first-go" onClick={forward}>{t("common.continue")}</button>}
          </>
        ) : step === "samples" ? (
          <>
            <h2>{t("first.samples.title")}</h2>
            <p>{t("first.samples.text")}</p>
            <ul className="first-samples">
              {samples.map((sample) => {
                const choice = picked[sample.id]!, title = automationTitle(sample);
                const set = (next: Partial<typeof choice>) => setPicked((current) => ({ ...current, [sample.id]: { ...choice, ...next } }));
                return (
                  <li key={sample.id} data-k={sample.k}>
                    <button type="button" className="switch" role="switch" aria-checked={choice.on} aria-label={t("auto.toggle", { name: title })} onClick={() => set({ on: !choice.on })} />
                    <span><b>{title}</b><small>{sample.template ? t(`auto.tpl.${sample.template}.goal` as Key) : sample.instruction}</small></span>
                    <input type="time" value={choice.at} disabled={!choice.on} aria-label={t("first.samples.at", { name: title })} onChange={(event) => event.target.value && set({ at: event.target.value })} />
                  </li>
                );
              })}
            </ul>
            <button type="button" className="first-go" disabled={busy} onClick={startSamples}>{t("first.morning.go")}</button>
          </>
        ) : null}
        {error && <p className="problem small" role="alert">{error}</p>}
        {!met && foot}
      </div>
    </div>,
    document.body,
  );
}
