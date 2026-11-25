import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

/**
 * Sideways swipes on a phone. Two of them share the screen, told apart by where the finger lands:
 * - from the very edge (the outer EDGE pixels), to the page next to this one in the dock;
 * - anywhere else on a mail row, leftwards, to archive it.
 * A swipe is decided once the finger has gone SLOP pixels: mostly sideways, it is ours; mostly up or down, it is the
 * page scrolling and is left alone.
 */
export const EDGE = 20;
export const SLOP = 10;
/** How far a page swipe has to go before letting go turns the page. */
export const TURN = 72;
/** How much of a row's width a swipe has to cover before letting go archives it. */
export const ROW_SHARE = 0.4;

export type Side = "left" | "right";

/** The edge a touch at `x` started on, on a screen `width` wide. */
export function edgeOf(x: number, width: number): Side | null {
  if (x <= EDGE) return "left";
  if (x >= width - EDGE) return "right";
  return null;
}

/** Sideways or up and down, once the finger has gone far enough to say. */
export function axisOf(dx: number, dy: number): "x" | "y" | null {
  if (Math.hypot(dx, dy) < SLOP) return null;
  return Math.abs(dx) > Math.abs(dy) * 1.2 ? "x" : "y";
}

/**
 * The page a swipe from `side` goes to. The dock's pages are the order; a page that is not in the dock (Mail, when it
 * is not the shortcut) takes its place among them by where it is in the sidebar. From the left edge is back, from the
 * right is on; there is nothing beyond either end.
 */
export function pageBeside(dock: string[], sidebar: string[], current: string, side: Side): string | null {
  let order = dock;
  if (!dock.includes(current)) {
    const rank = (key: string) => { const at = sidebar.indexOf(key); return at < 0 ? sidebar.length : at; };
    const after = dock.findIndex((key) => rank(key) > rank(current));
    order = after < 0 ? [...dock, current] : [...dock.slice(0, after), current, ...dock.slice(after)];
  }
  const at = order.indexOf(current);
  return order[side === "left" ? at - 1 : at + 1] ?? null;
}

/** Whether something under the finger can still scroll the way a swipe from `side` would move it: then it is that
 * thing's swipe (the to-do board's lanes), until it is at its end. */
function scrollsToward(from: Element | null, side: Side): boolean {
  for (let node = from; node && node !== document.body; node = node.parentElement) {
    if (!(node instanceof HTMLElement) || node.scrollWidth <= node.clientWidth + 1) continue;
    const overflow = getComputedStyle(node).overflowX;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    // From the right edge the finger moves left, which shows more of what is to the right.
    if (side === "right" ? node.scrollLeft + node.clientWidth < node.scrollWidth - 1 : node.scrollLeft > 0) return true;
  }
  return false;
}

export interface EdgePull {
  side: Side;
  /** The page it would go to. */
  to: string;
  /** How far it has been pulled, 0 to 1; 1 is far enough. */
  pull: number;
}

/**
 * Swipes in from the screen's edge, on the whole document, while `target` says where one would go (null: nowhere,
 * as while a sheet is open). What it shows while pulled is the caller's, from the returned pull.
 */
export function useEdgeSwipe(enabled: boolean, target: (side: Side) => string | null, go: (key: string) => void): EdgePull | null {
  const [pull, setPull] = useState<EdgePull | null>(null);
  const now = useRef({ target, go });
  now.current = { target, go };
  useEffect(() => {
    if (!enabled) return;
    let swipe: { side: Side; to: string; x: number; y: number; axis: "x" | "y" | null; pull: number } | null = null;
    const start = (event: TouchEvent) => {
      swipe = null;
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      const side = edgeOf(touch.clientX, window.innerWidth);
      if (!side || scrollsToward(event.target as Element, side)) return;
      const to = now.current.target(side);
      if (to) swipe = { side, to, x: touch.clientX, y: touch.clientY, axis: null, pull: 0 };
    };
    const move = (event: TouchEvent) => {
      if (!swipe) return;
      const touch = event.touches[0];
      const dx = touch.clientX - swipe.x, dy = touch.clientY - swipe.y;
      swipe.axis ??= axisOf(dx, dy);
      if (swipe.axis === "y") { swipe = null; setPull(null); return; }
      if (swipe.axis !== "x") return;
      event.preventDefault();
      const inward = swipe.side === "left" ? dx : -dx;
      swipe.pull = Math.max(0, Math.min(1, inward / TURN));
      setPull({ side: swipe.side, to: swipe.to, pull: swipe.pull });
    };
    const end = () => {
      const done = swipe;
      swipe = null;
      setPull(null);
      if (done?.axis === "x" && done.pull >= 1) now.current.go(done.to);
    };
    const cancel = () => { swipe = null; setPull(null); };
    document.addEventListener("touchstart", start, { passive: true });
    // Not passive: once it is a sideways swipe, the page under it must not scroll as well.
    document.addEventListener("touchmove", move, { passive: false });
    document.addEventListener("touchend", end);
    document.addEventListener("touchcancel", cancel);
    return () => {
      document.removeEventListener("touchstart", start);
      document.removeEventListener("touchmove", move);
      document.removeEventListener("touchend", end);
      document.removeEventListener("touchcancel", cancel);
      setPull(null);
    };
  }, [enabled]);
  return pull;
}

export interface RowSwipe {
  /** How far the row has been moved, in pixels: negative is leftwards; 0 at rest. */
  offset: number;
  /** Far enough that letting go would act. */
  armed: boolean;
  /** Gone: it slides off while the action runs. */
  gone: boolean;
  /** Following the finger: no easing, or it lags behind. */
  dragging: boolean;
  handlers: {
    onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
    onPointerMove(event: ReactPointerEvent<HTMLElement>): void;
    onPointerUp(event: ReactPointerEvent<HTMLElement>): void;
    onPointerCancel(): void;
    /** A swipe ends with the finger lifted on the row: that is not a tap on what is under it. */
    onClickCapture(event: ReactMouseEvent<HTMLElement>): void;
  };
  /** Put it back, as when the action failed. */
  reset(): void;
}

/** A row swiped leftwards with a finger, to act on it once it has gone ROW_SHARE of its width. Only touch: a mouse
 * has the row's own buttons. A swipe that starts at the screen's edge is the page's (useEdgeSwipe). */
export function useRowSwipe(enabled: boolean, act: () => void): RowSwipe {
  const [offset, setOffset] = useState(0);
  const [gone, setGone] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; width: number; axis: "x" | "y" | null } | null>(null);
  const swiped = useRef(false);
  const width = useRef(1);
  const reset = () => { drag.current = null; setOffset(0); setGone(false); };
  return {
    offset, gone, armed: -offset >= width.current * ROW_SHARE, dragging: drag.current?.axis === "x", reset,
    handlers: {
      onPointerDown(event) {
        swiped.current = false;
        if (!enabled || gone || event.pointerType !== "touch" || edgeOf(event.clientX, window.innerWidth)) return;
        width.current = event.currentTarget.getBoundingClientRect().width || 1;
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, width: width.current, axis: null };
      },
      onPointerMove(event) {
        const now = drag.current;
        if (!now || now.id !== event.pointerId) return;
        const dx = event.clientX - now.x, dy = event.clientY - now.y;
        now.axis ??= axisOf(dx, dy);
        if (now.axis === "y") { drag.current = null; setOffset(0); return; }
        if (now.axis !== "x") return;
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
        swiped.current = true;
        // Rightwards it only gives a little, to show it does not go that way.
        setOffset(dx < 0 ? dx : dx / 6);
      },
      onPointerUp(event) {
        const now = drag.current;
        drag.current = null;
        if (!now || now.id !== event.pointerId || now.axis !== "x") { setOffset(0); return; }
        if (now.x - event.clientX >= now.width * ROW_SHARE) {
          setGone(true);
          setOffset(-now.width);
          act();
        } else setOffset(0);
      },
      onPointerCancel() { drag.current = null; setOffset(0); },
      onClickCapture(event) {
        if (!swiped.current) return;
        swiped.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}
