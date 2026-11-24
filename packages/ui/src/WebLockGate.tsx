import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { WebLockStatus } from "@zirma/protocol";
import { api, ApiError, isUnpaired } from "./api.ts";
import { desktop } from "./desktop.ts";
import { t, useLocale } from "./i18n/index.ts";
import { Pair } from "./Pair.tsx";
import { Wordmark } from "./Wordmark.tsx";

type Screen = "checking" | "unavailable" | "pair" | "locked" | "open";
const inputs = ["pointerdown", "keydown", "input", "wheel", "touchmove"] as const;

function Unlock({ onUnlock }: { onUnlock(password: string): Promise<void> }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || busy) return;
    setError("");
    setBusy(true);
    try {
      await onUnlock(password);
    } catch (reason) {
      const code = reason instanceof ApiError ? reason.code : undefined;
      setError(t(code === "wrong_password" ? "webLock.wrong" : code === "rate_limited" ? "webLock.limited" : "webLock.unavailable"));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };
  return <main className="boot pair web-access-screen">
    <Wordmark />
    <h1 className="pair-title">{t("webLock.title")}</h1>
    <p className="quiet">{t("webLock.prompt")}</p>
    <form className="pair-form web-password-form" onSubmit={submit}>
      <label>{t("webLock.password")}
        <input className="model-input" type="password" autoComplete="current-password" required disabled={busy}
          value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      <button className="set-button" type="submit" disabled={!password || busy}>{t("webLock.unlock")}</button>
    </form>
    {error && <p role="alert" className="problem small">{error}</p>}
  </main>;
}

export function WebLockGate({ children }: { children: ReactNode }) {
  return desktop ? children : <BrowserGate>{children}</BrowserGate>;
}

/** Mount private views only after the home answers. A visual cover also hides portaled views
 * before mobile browsers freeze a background page or restore it out of the back/forward cache. */
function BrowserGate({ children }: { children: ReactNode }) {
  useLocale();
  const [screen, setScreen] = useState<Screen>("checking");
  const check = useRef(() => {});
  const unlocked = useRef(() => {});

  useEffect(() => {
    let current: WebLockStatus | null = null;
    let timer: number | undefined;
    let sequence = 0;
    let lastInput = -Infinity;
    let checking = false;
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("zirma.web-lock") : null;
    const cover = (hide: boolean) => document.documentElement.toggleAttribute("data-web-covered", hide);
    function close(next: Screen) {
      ++sequence;
      checking = false;
      window.clearTimeout(timer);
      current = null;
      cover(true);
      setScreen(next);
      // A locked page has no private event stream. Notice a password reset or the host turning the lock off.
      if (next === "locked" && !document.hidden) timer = window.setTimeout(() => { if (!document.hidden) verify(); }, 15_000);
    }
    function accept(status: WebLockStatus) {
      window.clearTimeout(timer);
      current = status;
      if (status.enabled && (status.locked || !status.expiresAt || status.expiresAt <= Date.now())) return close("locked");
      setScreen("open");
      cover(status.enabled && document.hidden);
      if (status.enabled && status.expiresAt !== null) {
        timer = window.setTimeout(expired, Math.max(0, status.expiresAt - Date.now()));
      }
    }
    function expired() {
      // Another tab may still be active. Hide the old data before asking whether its unlock is still valid.
      close("checking");
      if (!document.hidden) verify();
    }
    function fail(reason: unknown) {
      close(isUnpaired(reason) ? "pair" : reason instanceof ApiError && reason.code === "web_locked" ? "locked" : "unavailable");
    }
    function verify() {
      const request = ++sequence;
      checking = true;
      api.webLock().then((status) => {
        if (request !== sequence) return;
        checking = false;
        accept(status);
      }, (reason) => { if (request === sequence) fail(reason); });
    }
    function activity(event: Event) {
      if (!current?.enabled || !current.expiresAt || document.hidden || !event.isTrusted || checking) return;
      if (Date.now() >= current.expiresAt) return expired();
      const now = performance.now();
      if (now - lastInput < 5000) return;
      lastInput = now;
      const request = ++sequence;
      api.webActivity().then((status) => { if (request === sequence) accept(status); },
        (reason) => { if (request === sequence) fail(reason); });
    }
    function conceal() {
      ++sequence;
      checking = false;
      if (current?.enabled) cover(true);
    }
    function visibility() {
      if (document.hidden) conceal();
      else verify();
    }
    const restored = (event: PageTransitionEvent) => { if (event.persisted) verify(); };
    const focus = () => {
      if (!document.hidden && !checking && (!current || (current.expiresAt !== null && Date.now() >= current.expiresAt))) {
        if (current) expired();
        else verify();
      }
    };
    const offline = () => { if (current?.enabled) close("unavailable"); };
    const locked = () => close("locked");
    check.current = verify;
    unlocked.current = () => { channel?.postMessage("unlocked"); verify(); };
    if (channel) channel.onmessage = () => { if (!document.hidden) verify(); };
    verify();
    window.addEventListener("zirma:web-locked", locked);
    window.addEventListener("pagehide", conceal);
    window.addEventListener("pageshow", restored);
    window.addEventListener("focus", focus);
    window.addEventListener("offline", offline);
    window.addEventListener("online", verify);
    document.addEventListener("visibilitychange", visibility);
    for (const name of inputs) window.addEventListener(name, activity, { passive: true, capture: true });
    return () => {
      ++sequence;
      channel?.close();
      window.clearTimeout(timer);
      cover(false);
      window.removeEventListener("zirma:web-locked", locked);
      window.removeEventListener("pagehide", conceal);
      window.removeEventListener("pageshow", restored);
      window.removeEventListener("focus", focus);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", verify);
      document.removeEventListener("visibilitychange", visibility);
      for (const name of inputs) window.removeEventListener(name, activity, true);
    };
  }, []);

  if (screen === "open") return children;
  if (screen === "pair") return <div className="web-access-screen"><Pair onPaired={() => location.reload()} /></div>;
  if (screen === "locked") return <Unlock onUnlock={async (password) => {
    try {
      await api.unlockWeb(password);
      unlocked.current();
    } catch (error) {
      if (isUnpaired(error)) check.current();
      throw error;
    }
  }} />;
  return <main className="boot web-access-screen" role="status">
    <Wordmark />
    <p className="quiet">{t(screen === "unavailable" ? "webLock.unavailable" : "boot.connecting")}</p>
    {screen === "unavailable" && <button className="set-button" type="button" onClick={() => check.current()}>{t("devices.ts.retry")}</button>}
  </main>;
}
