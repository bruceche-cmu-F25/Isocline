/** The presence window: Alfred's figure, always on screen in the Mac app.
 * It shows what Alfred is doing, and it is how Alfred tells the user things on the Mac: the welcome when they come
 * back, a finished task, a question, a proposal. Alfred hops up, grows, and the words come out of the figure as a
 * speech card; then it folds the card back in. When the user hid the figure, Alfred rises from the screen's edge to
 * say it and sinks away after.
 *
 * The figure is the user's to move: drag it anywhere, and it settles toward the nearest corner, with the card on the
 * side that has room. It looks up when the pointer comes over it, leans as it is carried, and lands with a bump.
 * Click opens the main window; right-click has a small menu. Clicks pass through everything else.
 *
 * It comes in growing from a point; a press or a landing pokes it (a flinch and a wobble); once it has said the
 * welcome it unfolds into its net; and it hops when work is done (the figure does that by itself).
 *
 * In a plain browser, `presence.html?demo` plays sample notices (`?demo=visit` as if the figure were hidden, and
 * `&h=left&v=top` for another corner).
 */
import { StrictMode, useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { createRoot } from "react-dom/client";
import type { AwayDigest, Notice } from "@alfred/protocol";
import { desktop, type FigureSide } from "../desktop.ts";
import { createFigure, type Figure, type FigureState } from "../entity/tesseract.js";
import { setLocale, t, useLocale } from "../i18n/index.ts";
import { waitingCount } from "../shell/inbox.ts";
import { noticeLines } from "../noticeText.ts";
import { SpeechCard } from "../speech/SpeechCard.tsx";
import { useSpeech, type Said } from "../speech/useSpeech.ts";
import { WebLockGate } from "../WebLockGate.tsx";
import { useAlfred } from "../useAlfred.ts";
import { welcomeLines } from "../welcome.ts";
import "./presence.css";

const BUSY = new Set(["queued", "running", "cancelling"]);
/** How long a card stays once fully said, unless the pointer is on it. */
const STAY_MS: Record<string, number> = { welcome: 15_000, run_result: 12_000, run_interrupted: 20_000 };
const STAY_DEFAULT_MS = 25_000;
/** Pointer travel before a press becomes a drag rather than a click. */
const DRAG_PX = 4;

function linesOf(notice: Notice, preferredName: string | null): Said {
  if (notice.kind === "welcome") {
    const { greeting, summary } = welcomeLines(notice.payload as unknown as AwayDigest, preferredName);
    return { title: greeting, body: summary, mood: "hello", action: t("presence.action.look") };
  }
  const { title, body, mood, action } = noticeLines(notice);
  return { title, body, mood, action };
}

const demo = !desktop && new URLSearchParams(location.search).has("demo");
function demoSide(): FigureSide {
  const params = new URLSearchParams(location.search);
  return { h: params.get("h") === "left" ? "left" : "right", v: params.get("v") === "top" ? "top" : "bottom" };
}

function Presence() {
  const { state } = useAlfred();
  // Speak the user's language, as set on the home node.
  useLocale();
  const locale = state?.settings?.locale;
  useEffect(() => { if (locale) setLocale(locale); }, [locale]);

  const svg = useRef<SVGSVGElement>(null);
  const figure = useRef<Figure | null>(null);
  const [queue, setQueue] = useState<Notice[]>([]);
  /** The figure is hidden by the user's choice and only came out to say this. */
  const [visiting, setVisiting] = useState(false);
  const visitingRef = useRef(false);
  visitingRef.current = visiting;
  const [side, setSide] = useState<FigureSide>(demo ? demoSide() : { h: "right", v: "bottom" });
  const [pointing, setPointing] = useState(false);

  // The figure is light or dark with the card.
  useEffect(() => {
    if (!svg.current) return;
    const dark = () => document.documentElement.dataset.scheme === "dark";
    const live = createFigure(svg.current, { width: 4.6, dark: dark(), enter: "grow", ambient: true });
    figure.current = live;
    // public/scheme.js keeps data-scheme right: the system's appearance, or the one chosen in the app.
    const follow = new MutationObserver(() => live.setDark(dark()));
    follow.observe(document.documentElement, { attributes: true, attributeFilter: ["data-scheme"] });
    return () => { follow.disconnect(); live.destroy(); figure.current = null; };
  }, []);

  const hear = useCallback((notices: Notice[], visit: boolean) => {
    setQueue((current) => [...current, ...notices.filter((notice) => !current.some((known) => known.id === notice.id))]);
    if (visit) setVisiting(true);
  }, []);
  useEffect(() => desktop?.onSay(hear), [hear]);
  useEffect(() => desktop?.onSide(setSide), []);
  useEffect(() => { if (demo) return playDemo(hear); }, [hear]);

  const speech = useSpeech<Notice>({
    items: queue,
    id: (notice) => notice.id,
    lines: (notice) => linesOf(notice, state?.settings?.preferredName ?? null),
    stayMs: (notice) => STAY_MS[notice.kind] ?? STAY_DEFAULT_MS,
    done: (notice, outcome) => {
      desktop?.noticeDone(notice.id, outcome);
    },
    remove: (notice) => setQueue((rest) => rest.filter((item) => item.id !== notice.id)),
    leaving: () => visitingRef.current,
    settled: () => { setVisiting(false); desktop?.settle(); },
  });
  const { current, said, phase } = speech;

  // ── Being moved and touched ──
  const drag = useRef<{ x: number; y: number; lastX: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [tilt, setTilt] = useState(0);
  const [offset, setOffset] = useState<[number, number]>([0, 0]); // demo only: the browser cannot move the window
  const [landed, setLanded] = useState(0);
  const interactive = (on: boolean) => { if (!on && drag.current) return; desktop?.setInteractive(on); };

  const down = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    drag.current = { x: event.screenX, y: event.screenY, lastX: event.screenX, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    figure.current?.play("poke");
    desktop?.dragFigure("start");
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const held = drag.current;
    if (!held) return;
    const dx = event.screenX - held.x, dy = event.screenY - held.y;
    if (!held.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    if (!held.moved) { held.moved = true; setDragging(true); }
    // Leans the way it is carried, more the faster it goes.
    setTilt(Math.max(-16, Math.min(16, (event.screenX - held.lastX) * 1.4)));
    held.lastX = event.screenX;
    if (desktop) desktop.dragFigure("move");
    else setOffset([dx, dy]);
  };
  const up = (event: PointerEvent<HTMLButtonElement>) => {
    const held = drag.current;
    drag.current = null;
    if (!held) return;
    if (!held.moved) { desktop?.dragFigure("cancel"); desktop?.toggleMain(); return; }
    setDragging(false);
    setTilt(0);
    setLanded((n) => n + 1);
    figure.current?.play("poke");
    if (desktop) desktop.dragFigure("end");
    else {
      setOffset([0, 0]);
      setSide({ h: event.clientX < innerWidth / 2 ? "left" : "right", v: event.clientY < innerHeight / 2 ? "top" : "bottom" });
    }
    if (!event.currentTarget.matches(":hover")) { setPointing(false); desktop?.setInteractive(false); }
  };
  // Settle the lean when the pointer stops while still holding.
  useEffect(() => {
    if (!dragging || tilt === 0) return;
    const timer = window.setTimeout(() => setTilt(0), 120);
    return () => window.clearTimeout(timer);
  }, [dragging, tilt]);

  const working = state?.runs.some((run) => BUSY.has(run.state)) ?? false;
  const waiting = !!state && waitingCount(state) > 0;
  // Show the notice’s state throughout its text reveal. Touch greets, waiting is amber, and work turns.
  const mood: FigureState = speech.mood ?? (dragging || pointing ? "hello" : waiting ? "notice" : working ? "work" : "rest");
  useEffect(() => { figure.current?.setState(mood); }, [mood]);
  // Once the welcome text is fully visible, the tesseract unfolds into its net of eight cubes.
  const unfolded = useRef<string | null>(null);
  useEffect(() => {
    if (mood !== "hello" || phase !== "speak" || !speech.complete || current?.kind !== "welcome" || unfolded.current === current.id) return;
    unfolded.current = current.id;
    figure.current?.play("unfold");
  }, [mood, phase, speech.complete, current]);

  const label = working ? t("presence.working") : waiting ? t("presence.waiting") : "Alfred";
  const speaking = phase === "idle" || phase === "next" ? undefined : phase;
  const cardShown = said && current && (phase === "speak" || phase === "fold");

  return (
    <div className={`presence${visiting ? " visiting" : ""}`} data-h={side.h} data-v={side.v}>
      {cardShown && (
        <SpeechCard
          key={current.id} said={said} out={speech.out} complete={speech.complete} folding={phase === "fold"} more={queue.length - 1}
          tail={side.h === "right" ? "right" : "left"} tailAt={side.v === "bottom" ? "calc(100% - 26px)" : "26px"}
          onOpen={() => speech.finish("open")} onNext={() => speech.finish("dismiss")} onClose={() => speech.finish("dismiss")}
          onHover={(on) => { speech.setHovered(on); interactive(on); }}
        />
      )}
      <div
        className="hold" data-dragging={dragging || undefined} data-landed={landed ? landed % 2 : undefined}
        style={{ "--tilt": `${tilt}deg`, "--dx": `${offset[0]}px`, "--dy": `${offset[1]}px` } as CSSProperties}
      >
        <button
          type="button" className="figure" data-speaking={speaking} data-nod={speech.nod ? speech.nod % 2 : undefined}
          aria-label={t("presence.open", { label })} title={dragging ? undefined : label}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
          onContextMenu={(event) => { event.preventDefault(); desktop?.figureMenu(); }}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); desktop?.toggleMain(); } }}
          onMouseEnter={() => { setPointing(true); interactive(true); }}
          onMouseLeave={() => { if (drag.current) return; setPointing(false); interactive(false); }}
        >
          <svg ref={svg} viewBox="0 0 120 120" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** Sample notices for looking at the presence page in a browser. */
function playDemo(hear: (notices: Notice[], visit: boolean) => void): () => void {
  document.documentElement.dataset.demo = "";
  const visit = new URLSearchParams(location.search).get("demo") === "visit";
  const at = new Date().toISOString();
  const notice = (id: string, kind: string, payload: Record<string, unknown>): Notice => ({
    id, eventSeq: 0, kind, state: "presented", createdAt: at, updatedAt: at, claimedBy: null, claimUntil: null, expiresAt: null, payload,
  });
  const timers = [
    window.setTimeout(() => hear([notice("demo-welcome", "welcome", {
      awayMs: 2.5 * 3600_000, runs: { completed: 1, failed: 0, interrupted: 0, goals: ["整理本周的邮件"] }, changes: { todo: 2 }, waiting: 1,
    })], visit), 600),
    window.setTimeout(() => hear([
      notice("demo-proposal", "proposal", { title: "把周四的牙医挪到周五下午 3 点" }),
      notice("demo-result", "run_result", { status: "completed", goal: "查明天上海的天气", reply: "明天上海多云转小雨，18–23°C，下午出门记得带伞。" }),
    ], visit), 2600),
  ];
  return () => timers.forEach((timer) => window.clearTimeout(timer));
}

createRoot(document.getElementById("root")!).render(<StrictMode><WebLockGate><Presence /></WebLockGate></StrictMode>);
