/** Zirma telling the user things, one at a time: the figure hops, the card reveals its text,
 * then folds back in. Shared by the Mac app's figure window and the app's own pages.
 *
 *   idle → hop → speak ⇄ fold → next → (speak | idle | sink → idle)
 *
 * Timings match speech.css.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { FigureState } from "../entity/tesseract.js";

export const HOP_MS = 380;
export const FOLD_MS = 240;
export const SINK_MS = 520;
const TYPE_TICK_MS = 26;
const TYPE_TICKS = 46;

export type Phase = "idle" | "hop" | "speak" | "fold" | "next" | "sink";
/** How a card left: clicked through, closed, or it timed out unanswered. */
export type Outcome = "open" | "dismiss" | "timeout";

/** What Zirma says about one thing. */
export interface Said { title: string; body: string; mood: FigureState; action: string }

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Reveals `text` a few characters at a time, as if spoken. Returns how much is out, and whether it is all out. */
function useSpoken(text: string, key: string | null): [number, boolean] {
  const length = Array.from(text).length;
  const [reveal, setReveal] = useState({ key, count: 0 });
  useEffect(() => {
    if (!key || reducedMotion()) { setReveal({ key, count: length }); return; }
    let count = 0;
    setReveal({ key, count });
    const step = Math.max(1, Math.ceil(length / TYPE_TICKS));
    const timer = window.setInterval(() => {
      count = Math.min(length, count + step);
      setReveal({ key, count });
      if (count >= length) window.clearInterval(timer);
    }, TYPE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [key, length]);
  // A newly opened card hasn't revealed any of its own text yet.
  const out = !key ? length : reveal.key === key ? Math.min(reveal.count, length) : 0;
  return [out, out >= length];
}

export interface SpeechOptions<T> {
  /** What waits to be said, first one next. The caller owns it and removes items in `remove`. */
  items: readonly T[];
  id(item: T): string;
  lines(item: T): Said;
  /** How long a card stays once fully said (never while the pointer is on it). */
  stayMs(item: T): number;
  /** As the card starts to fold: act on the outcome (open something, acknowledge). */
  done(item: T, outcome: Outcome): void;
  /** Once it has folded: take the item out of `items`. */
  remove(item: T): void;
  /** No room for the whole card now (the user is in a conversation with Zirma): only its title shows, and it waits.
   * Nothing is typed out and nothing times out until there is room; then it is said in full. */
  brief?: boolean;
  /** Nothing left to say: whether the figure goes away (sinks) rather than staying. */
  leaving?(): boolean;
  /** After sinking. */
  settled?(): void;
}

export interface Speech<T> {
  current: T | null;
  said: Said | null;
  phase: Phase;
  /** Characters of the body out so far, and whether all are. */
  out: number;
  complete: boolean;
  /** The state conveyed by the visible notification. */
  mood: FigureState | null;
  /** Counts the moves to a next card, for a small nod between them. */
  nod: number;
  finish(outcome: Outcome): void;
  setHovered(hovered: boolean): void;
}

export function useSpeech<T>(options: SpeechOptions<T>): Speech<T> {
  const opts = useRef(options);
  opts.current = options;
  const [phase, setPhase] = useState<Phase>("idle");
  const [hovered, setHovered] = useState(false);
  const [nod, setNod] = useState(0);
  const current = options.items[0] ?? null;
  const said = current ? options.lines(current) : null;
  const key = current ? options.id(current) : null;
  const brief = !!options.brief;
  const [out, complete] = useSpoken(said?.body ?? "", phase === "speak" && !brief ? key : null);

  // Something to say and nothing on screen: hop up, then speak.
  useEffect(() => { if (current && phase === "idle") setPhase("hop"); }, [current, phase]);
  useEffect(() => {
    if (phase !== "hop") return;
    const timer = window.setTimeout(() => setPhase("speak"), reducedMotion() ? 0 : HOP_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);
  // Taken away from under the card (e.g. its conversation was opened): move on.
  useEffect(() => { if (phase === "speak" && !current) setPhase("next"); }, [phase, current]);

  const finish = useCallback((outcome: Outcome) => {
    if (!current || phase !== "speak") return;
    const item = current;
    opts.current.done(item, outcome);
    setPhase("fold");
    window.setTimeout(() => {
      opts.current.remove(item);
      setNod((n) => n + 1);
      setPhase("next");
    }, reducedMotion() ? 0 : FOLD_MS);
  }, [current, phase]);

  // After a card folds: the next one, or rest (or go away, when the figure only came out to say these).
  useEffect(() => {
    if (phase !== "next") return;
    if (current) { setPhase("speak"); return; }
    setHovered(false);
    setPhase(opts.current.leaving?.() ? "sink" : "idle");
  }, [phase, current]);
  useEffect(() => {
    if (phase !== "sink") return;
    if (current) { setPhase("hop"); return; } // something new while going away: come straight back
    const timer = window.setTimeout(() => { setPhase("idle"); opts.current.settled?.(); }, reducedMotion() ? 0 : SINK_MS);
    return () => window.clearTimeout(timer);
  }, [phase, current]);

  // Once fully said, the card stays a while; never while the pointer is on it, or while only its title shows.
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    if (!current || phase !== "speak" || !complete || hovered || brief) return;
    const timer = window.setTimeout(() => finishRef.current("timeout"), opts.current.stayMs(current));
    return () => window.clearTimeout(timer);
  }, [current, phase, complete, hovered, brief]);

  const presenting = phase === "hop" || phase === "speak" || phase === "fold";
  const mood = presenting && said ? said.mood : null;
  return { current, said, phase, out, complete, mood, nod, finish, setHovered };
}
