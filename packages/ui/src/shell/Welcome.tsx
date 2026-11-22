import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { intlLocale, t } from "../i18n/index.ts";
import { moveSeconds } from "../entity/tesseract.js";
import { Figure } from "./Figure.tsx";
import "./welcome.css";

/** Reduced motion skips the entrance. Both modes give the finished figure the same reading time. */
const GROW_MS = moveSeconds("grow") * 1000, HOLD_MS = 4_000, LEAVE_MS = 280;
const still = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Returning users see the local clock and a greeting over their workspace. A key or click dismisses it immediately. */
export function Welcome({ name, onDone }: { name: string; onDone(): void }) {
  const [now, setNow] = useState(() => new Date());
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    let timer: number | undefined;
    let clockTimer: number | undefined;
    const updateClock = () => {
      const time = new Date();
      setNow(time);
      clockTimer = window.setTimeout(updateClock, 60_000 - time.getTime() % 60_000);
    };
    const start = () => {
      window.clearTimeout(timer);
      window.clearTimeout(clockTimer);
      if (document.hidden) return;
      updateClock();
      timer = window.setTimeout(() => setLeaving(true), still() ? HOLD_MS : GROW_MS + HOLD_MS);
    };
    const skipOnKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (!event.metaKey && !event.ctrlKey && !event.altKey) event.preventDefault();
      onDone();
    };
    start();
    document.addEventListener("visibilitychange", start);
    document.addEventListener("keydown", skipOnKey, true);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(clockTimer);
      document.removeEventListener("visibilitychange", start);
      document.removeEventListener("keydown", skipOnKey, true);
    };
  }, [onDone]);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(onDone, still() ? 0 : LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, onDone]);

  return createPortal(
    <div className="welcome" data-leaving={leaving || undefined}>
      <time className="welcome-clock" dateTime={now.toISOString()}>
        <span className="welcome-date">{now.toLocaleDateString(intlLocale(), { weekday: "long", month: "long", day: "numeric" })}</span>
        {" "}
        <span className="welcome-time">{now.toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}</span>
      </time>
      <div className="welcome-in">
        <Figure state="rest" size={96} centered enter />
        <p id="welcome-line" className="welcome-line" role="status">{t("greet.back", { name })}</p>
      </div>
      <button type="button" className="welcome-skip" aria-describedby="welcome-line" onClick={onDone}>
        <span className="welcome-hint">
          <span className="welcome-click">{t("greet.clickToReturn")}</span>
          <span className="welcome-tap">{t("greet.tapToReturn")}</span>
        </span>
      </button>
    </div>,
    document.body,
  );
}
