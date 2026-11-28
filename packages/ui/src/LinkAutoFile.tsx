/** Filing links on their own, on the Links page (docs/design/links-autofile.md §2, §4): the Auto-file button in the
 * head and its card, the line that says what the last pass did (with its undo), the offer in Not filed to go through
 * what nobody filed, and the line in an opened link that says where Zirma filed it. */
import { useState } from "react";
import type { AutoFileState } from "@zirma/module-links/types";
import { useOp } from "./linkControls.tsx";
import { Pop } from "./shell/Pop.tsx";
import { Icon } from "./shell/icons.tsx";
import { intlLocale, t } from "./i18n/index.ts";
import "./links-autofile.css";

const ASKED_KEY = "zirma.links.autofileAsked";
const asked = () => { try { return localStorage.getItem(ASKED_KEY) === "1"; } catch { return false; } };
const remember = () => { try { localStorage.setItem(ASKED_KEY, "1"); } catch { /* asked again next time */ } };

/** Turning filing on its own on or off. Off, the first press says what it does and what it sends before turning it
 * on; later presses turn it on at once. On, a press shows today's count and the way to turn it off. The head's
 * button and, on a phone, the ⋯ menu both press it. */
export function useAutoFile(state: AutoFileState | undefined, onError: (message: string | null) => void, onSaid: (text: string) => void) {
  const { busy, run } = useOp(onError);
  const [card, setCard] = useState(false);
  const turn = (enabled: boolean) => void run("link.autofile", { enabled }, () => {
    setCard(false);
    if (enabled) { remember(); onSaid(t("links.auto.turnedOn")); }
  });
  const press = () => { if (state && !state.enabled && asked()) turn(true); else setCard(true); };
  const view = card && state ? (
    <Pop onClose={() => setCard(false)}>
      <div className="ev-edit la-card" role="dialog" aria-label={t("links.auto.title")}>
        <h3>{t("links.auto.title")}</h3>
        {state.enabled
          ? <p>{t("links.auto.isOn", { n: state.today, max: state.perDay })}</p>
          : <><p>{t("links.auto.about")}</p><p className="quiet">{t("links.auto.sends")}</p></>}
        <div className="lr-foot">
          <span />
          {state.enabled
            ? <><button type="button" className="lk-btn" disabled={busy} onClick={() => turn(false)}>{t("links.auto.off")}</button>
              <button type="button" className="lk-btn solid" onClick={() => setCard(false)}>{t("links.auto.done")}</button></>
            : <><button type="button" className="lk-btn" onClick={() => setCard(false)}>{t("links.auto.notNow")}</button>
              <button type="button" className="lk-btn solid" disabled={busy} onClick={() => turn(true)}>{t("links.auto.on")}</button></>}
        </div>
      </div>
    </Pop>
  ) : null;
  return { busy, press, view };
}

/** The button in the category's head (hidden on a phone, where the ⋯ menu has it: the links come first there). */
export function AutoFileButton({ state, busy, onPress }: { state: AutoFileState | undefined; busy: boolean; onPress(): void }) {
  if (!state) return null;
  return (
    <button type="button" className="la-button" aria-pressed={state.enabled} disabled={busy} title={t("links.auto.button")} onClick={onPress}>
      {state.enabled && <span className="la-on" aria-hidden="true" />}<span className="la-label">{t("links.auto.button")}</span>
    </button>
  );
}

/** One line above the links: that the last pass did not go through and when it tries again; what the last pass filed,
 * with its undo, until seen (a day at most); or that Zirma is going through Not filed. */
export function AutoFileLine({ state, onError, onSaid }: { state: AutoFileState | undefined; onError(message: string | null): void; onSaid(text: string): void }) {
  const { busy, run } = useOp(onError);
  const last = state?.last;
  const failed = state?.failed;
  if (failed) {
    // The newest pass did not go through: its links wait, and it tries again by itself.
    const retry = new Date(failed.retryAt);
    const at = retry.toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit", hour12: false });
    return (
      <p className="la-line" role="status">
        <span>{t(retry.toDateString() === new Date().toDateString() ? "links.auto.failed" : "links.auto.failedTomorrow", { time: at })}</span>
        <button type="button" className="la-close" disabled={busy} aria-label={t("links.auto.dismiss")} title={t("links.auto.dismiss")}
          onClick={() => void run("link.autofile_seen", { id: failed.id })}><Icon name="close" /></button>
      </p>
    );
  }
  if (last) {
    return (
      <p className="la-line" role="status">
        <span>{last.made ? t("links.auto.filedMade", { n: last.filed, m: last.made }) : t("links.auto.filed", { n: last.filed })}</span>
        <button type="button" className="lk-see" disabled={busy} onClick={() => void run("link.autofile_undo", { id: last.id }, () => onSaid(t("links.auto.undone")))}>{t("links.undo")}</button>
        <button type="button" className="la-close" disabled={busy} aria-label={t("links.auto.dismiss")} title={t("links.auto.dismiss")}
          onClick={() => void run("link.autofile_seen", { id: last.id })}><Icon name="close" /></button>
      </p>
    );
  }
  if (state?.sweeping) return <p className="la-line quiet" role="status"><span className="pulse" /><span>{t("links.auto.sorting")}</span></p>;
  return null;
}

/** In Not filed: the links nobody has filed yet, and a way to have Zirma go through them (it asks first). */
export function SweepOffer({ state, onError, onSaid }: { state: AutoFileState | undefined; onError(message: string | null): void; onSaid(text: string): void }) {
  const { busy, run } = useOp(onError);
  const [card, setCard] = useState(false);
  const n = state?.unsorted ?? 0;
  if (!state || !n || state.sweeping) return null;
  return <>
    <p className="la-offer">
      <span>{t("links.auto.sweep.offer", { n })}</span>
      <button type="button" className="lk-btn" onClick={() => setCard(true)}>{t("links.auto.sweep.go")}</button>
    </p>
    {card && <Pop onClose={() => setCard(false)}>
      <div className="ev-edit la-card" role="dialog" aria-label={t("links.auto.sweep.title", { n })}>
        <h3>{t("links.auto.sweep.title", { n })}</h3>
        <p>{t("links.auto.sweep.about")}</p>
        <p className="quiet">{t("links.auto.sends")}</p>
        <div className="lr-foot">
          <span />
          <button type="button" className="lk-btn" onClick={() => setCard(false)}>{t("common.cancel")}</button>
          <button type="button" className="lk-btn solid" disabled={busy} onClick={() => void run("link.autofile_sweep", {}, () => { setCard(false); onSaid(t("links.auto.sweep.started")); })}>{t("links.auto.sweep.start")}</button>
        </div>
      </div>
    </Pop>}
  </>;
}

/** On an opened link Zirma filed: where it put it, and a way to say it was wrong. */
export function FiledByZirma({ path, busy, onPutBack }: { path: string; busy: boolean; onPutBack(): void }) {
  return (
    <p className="la-filed">
      <span>{t("links.auto.filedTo", { path })}</span>
      <button type="button" className="lk-see" disabled={busy} onClick={onPutBack}>{t("links.auto.putBack")}</button>
    </p>
  );
}
