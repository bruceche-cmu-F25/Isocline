/** Isocline telling the user something inside the app: the figure that is on screen (the panel's, the floating
 * button's, the phone's dock) hops, and the card comes out of it with its tail pointing back. With no figure in sight
 * (a bare page with the panel closed), a small Isocline comes up in the corner to say it and goes away after.
 *
 * While the user is talking with Isocline there is no room over the conversation, so the card is brief: a pill with the
 * title only, and it waits. With the panel open it sits between the panel's head and the conversation. In a session
 * that fills the page (Code) the corner is the composer's, so a small Isocline comes down into the session's bar and
 * the pill sits beside it. Once the user is out of the conversation the card comes out in full, and only then is it
 * typed out and timed.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { FigureState } from "../entity/tesseract.js";
import { SpeechCard, type Tail } from "../speech/SpeechCard.tsx";
import { useSpeech, type Outcome, type Said } from "../speech/useSpeech.ts";
import { Figure } from "./Figure.tsx";

interface Props<T> {
  items: readonly T[];
  id(item: T): string;
  lines(item: T): Said;
  stayMs(item: T): number;
  done(item: T, outcome: Outcome): void;
  remove(item: T): void;
  /** The figure's state while it talks, for the figures the app draws; null when it is quiet. */
  onMood(mood: FigureState | null): void;
}

interface Placement { top: number; left: number; tail: Tail; tailAt: number }

/** The figure in sight to speak from: the first one laid out on screen. */
function findAnchor(): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>("[data-alfred-anchor]")) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth) return element;
  }
  return null;
}

/** The panel's head, when the figure to speak from is the one in the open Isocline panel. */
const panelHead = (anchor: Element | null) => anchor?.closest<HTMLElement>(".alfred .alf-head") ?? null;

/** Brief, from the panel's figure: on the head's lower edge, in the gap between Isocline's line and the conversation's
 * title, starting on the panel's left line. */
function placeBrief(anchor: DOMRect, head: DOMRect, card: { width: number }): Placement {
  const left = Math.max(12, Math.min(innerWidth - card.width - 12, anchor.left));
  return { top: head.bottom - 11, left, tail: "top", tailAt: Math.max(16, Math.min(card.width - 16, anchor.left + anchor.width / 2 - left)) };
}

/** A session that fills the page: where a small Isocline goes in its bar, left of the bar's last button. */
function barSpot(): { top: number; left: number } | null {
  const rect = document.querySelector<HTMLElement>(".dev-session .dev-panel-toggle")?.getBoundingClientRect();
  return rect?.width ? { top: Math.round(rect.top + rect.height / 2 - BAR_FIGURE / 2 - BAR_PAD), left: Math.round(rect.left - 8 - BAR_FIGURE - BAR_PAD * 2) } : null;
}
const BAR_FIGURE = 24, BAR_PAD = 5;

/** Brief, from the figure in a session's bar: beside it, on its left, in the bar's own row. */
function placeBeside(anchor: DOMRect, card: { width: number; height: number }): Placement {
  return { top: anchor.top + anchor.height / 2 - card.height / 2, left: Math.max(12, anchor.left - BAR_PAD - 12 - card.width), tail: "right", tailAt: card.height / 2 };
}

/** What the ask bar has up over the page (its answer, its suggestions), when the figure is the bar's or the dock's. */
const askOver = (): DOMRect | null => document.querySelector<HTMLElement>(".ask-over")?.getBoundingClientRect() ?? null;

/** Below the figure when it is in the top half, above it otherwise; starting near it and kept on screen. Either
 * way it keeps clear of what the ask bar has up (`clear`): Isocline says it past the answer, not across it. */
function placeCard(anchor: DOMRect, card: { width: number; height: number }, clear: DOMRect | null = null): Placement {
  const below = anchor.top + anchor.height / 2 < innerHeight / 2;
  const centre = anchor.left + anchor.width / 2;
  const left = Math.max(12, Math.min(innerWidth - card.width - 12, centre - 30));
  const top = below
    ? Math.min(innerHeight - card.height - 12, Math.max(anchor.bottom, clear?.bottom ?? -Infinity) + 16)
    : Math.max(12, Math.min(anchor.top, clear?.top ?? Infinity) - 16 - card.height);
  return { top, left, tail: below ? "top" : "bottom", tailAt: Math.max(18, Math.min(card.width - 18, centre - left)) };
}

export function Says<T>({ items, id, lines, stayMs, done, remove, onMood }: Props<T>) {
  /** No figure was in sight, so Isocline came up in the corner for this. */
  const [own, setOwn] = useState(false);
  const ownRef = useRef(false);
  ownRef.current = own;
  /** The user is in a conversation with Isocline (the open panel, a session that fills the page): say it briefly, and wait. */
  const [brief, setBrief] = useState(false);
  /** Where Isocline's own figure goes when the corner is taken: in a session's bar. Null for the corner. */
  const [spot, setSpot] = useState<{ top: number; left: number } | null>(null);
  const speech = useSpeech<T>({ items, id, lines, stayMs, done, remove, brief, leaving: () => ownRef.current, settled: () => setOwn(false) });
  const { phase, current, said } = speech;
  const card = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  useEffect(() => { onMood(speech.mood); }, [speech.mood, onMood]);
  useEffect(() => () => onMood(null), [onMood]);

  // About to speak: find the figure to speak from, or come out in the corner.
  useEffect(() => {
    if (phase !== "hop") return;
    const target = findAnchor();
    const bar = barSpot();
    if (!own && !target) { setOwn(true); setSpot(bar); }
    setBrief(!!panelHead(target) || !!bar);
  }, [phase, own]);

  // The figure hops and grows: its drawing carries the phase (the anchor itself stays still, to measure).
  const talking = phase === "hop" || phase === "speak" || phase === "fold" || phase === "sink";
  useEffect(() => {
    if (!talking) return;
    const target = findAnchor();
    anchor.current = target;
    const drawing = target?.firstElementChild as HTMLElement | SVGElement | null;
    if (!drawing) return;
    drawing.setAttribute("data-speaking", phase);
    if (speech.nod) drawing.setAttribute("data-nod", String(speech.nod % 2));
    if (brief) drawing.setAttribute("data-brief", "");
    return () => { drawing.removeAttribute("data-speaking"); drawing.removeAttribute("data-nod"); drawing.removeAttribute("data-brief"); };
  }, [talking, phase, speech.nod, own, brief]);

  // Keep the card by its figure as the layout moves (panels open, the window resizes).
  const shown = !!said && !!current && (phase === "speak" || phase === "fold");
  useEffect(() => {
    if (!shown) { setPlacement(null); return; }
    let frame = 0;
    let last = "";
    const measure = () => {
      // The figure to speak from changes as the user moves about: a panel opens or closes, a page takes its place.
      const target = anchor.current = findAnchor();
      const mine = !!target?.closest(".says-own");
      const bar = barSpot();
      if (!target) { if (!ownRef.current) setOwn(true); }
      else if (ownRef.current && !mine) setOwn(false); // a figure of the app's is in sight again: speak from that one
      setSpot((now) => (bar?.top === now?.top && bar?.left === now?.left ? now : bar));
      if (target && card.current) {
        const head = panelHead(target);
        setBrief(!!head || !!bar);
        const size = { width: card.current.offsetWidth, height: card.current.offsetHeight };
        const rect = target.getBoundingClientRect();
        const next = head ? placeBrief(rect, head.getBoundingClientRect(), size) : mine && bar ? placeBeside(rect, size) : placeCard(rect, size, askOver());
        const key = `${next.top}|${next.left}|${next.tail}|${next.tailAt}`;
        if (key !== last) { last = key; setPlacement(next); }
      }
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [shown]);

  return (
    <>
      {own && (phase !== "idle") && (
        <div className="says-own" data-phase={phase} data-at={spot ? "bar" : undefined} style={spot ?? undefined}>
          <Figure state={speech.mood ?? "rest"} size={spot ? BAR_FIGURE : 40} anchor />
        </div>
      )}
      {shown && (
        <div ref={card} className="says" style={{ top: placement?.top ?? -9999, left: placement?.left ?? 0, visibility: placement ? undefined : "hidden" } as CSSProperties}>
          {placement && (
            <SpeechCard
              key={`${id(current)}:${brief}`} brief={brief} said={said} out={speech.out} complete={speech.complete} folding={phase === "fold"} more={items.length - 1}
              tail={placement.tail} tailAt={`${placement.tailAt}px`}
              onOpen={() => speech.finish("open")} onNext={() => speech.finish("dismiss")} onClose={() => speech.finish("dismiss")}
              onHover={speech.setHovered}
            />
          )}
          {/* Measured before it is placed, so the first frame is already in the right spot. */}
          {!placement && <SpeechCard brief={brief} said={said} out={0} complete={false} folding={false} more={items.length - 1} tail="top" tailAt="0px" onOpen={() => {}} onNext={() => {}} onClose={() => {}} onHover={() => {}} />}
        </div>
      )}
    </>
  );
}
