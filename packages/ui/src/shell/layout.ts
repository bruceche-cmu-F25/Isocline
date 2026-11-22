/** The workspace's arrangement: sidebar shown or folded away, its width, and Alfred's panel (beside the page,
 * across the whole page, or closed to a floating button). The sidebar and the widths are remembered per device in
 * localStorage, which may be unavailable: then they simply start from the defaults each time. Whether Alfred's panel
 * is open is not remembered: the workspace always opens with it closed.
 */
import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";

export type NavMode = "full" | "hidden";
export type AlfredMode = "open" | "wide" | "closed";
export interface Layout { nav: NavMode; navW: number; alfW: number; alfred: AlfredMode }

/** min: the top bar's lead sits over the sidebar at the same width, and in the Mac app it holds the window buttons,
 * the sidebar button and the Daily | Code switch (styles.css .topbar-lead): 200px. */
export const NAV = { min: 200, max: 300, def: 208, foldAt: 120 };
/** pageMin: what the page keeps while Alfred has width to give. pageFloor: what it keeps at any window size (a phone's width). */
export const ALF = { min: 300, max: 640, def: 400, pageMin: 420, pageFloor: 320 };
/** Below this width the workspace is a phone: one column, a dock, Alfred as a sheet. The Mac window never gets this narrow. */
export const PHONE = "(max-width: 700px)";
const KEY = "alfred.layout";

/** What is kept between visits: everything but Alfred's panel. */
type Saved = Omit<Layout, "alfred">;

/** `saved`: what localStorage holds, as text. Alfred always starts closed, whatever it was left as: the page has the
 * room, and the figure waits in the top right corner until it is asked something or has something to say. */
export function startLayout(saved: string | null, windowWidth: number): Layout {
  const fallback: Layout = { nav: windowWidth < 900 ? "hidden" : "full", navW: NAV.def, alfW: ALF.def, alfred: "closed" };
  try {
    const kept = JSON.parse(saved ?? "null") as Partial<Saved> | null;
    if (!kept || typeof kept !== "object") return fallback;
    return {
      // "rail" is what a folded sidebar was saved as before it folded away entirely.
      nav: kept.nav === "full" ? "full" : kept.nav === "hidden" || (kept.nav as unknown) === "rail" ? "hidden" : fallback.nav,
      navW: typeof kept.navW === "number" ? Math.min(NAV.max, Math.max(NAV.min, kept.navW)) : NAV.def,
      alfW: typeof kept.alfW === "number" ? Math.min(ALF.max, Math.max(ALF.min, kept.alfW)) : ALF.def,
      alfred: "closed",
    };
  } catch {
    return fallback;
  }
}

function load(): Layout {
  let saved: string | null = null;
  try { saved = localStorage.getItem(KEY); } catch { /* not remembered; fine */ }
  return startLayout(saved, window.innerWidth);
}

export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function useLayout(): [Layout, (patch: Partial<Layout>) => void] {
  const [layout, setLayout] = useState(load);
  useEffect(() => {
    const { nav, navW, alfW } = layout;
    try { localStorage.setItem(KEY, JSON.stringify({ nav, navW, alfW } satisfies Saved)); } catch { /* not remembered; fine */ }
  }, [layout]);
  const update = useCallback((patch: Partial<Layout>) => setLayout((current) => ({ ...current, ...patch })), []);
  return [layout, update];
}

/**
 * What to draw: the page never drops below ALF.pageMin unless Alfred is already at its minimum. In a window too small
 * for a full sidebar, Alfred and a page of ALF.pageFloor, the sidebar gives way: it narrows, then folds away
 * (`navMode`; the remembered choice in `layout.nav` is left alone, so it comes back when there is room).
 */
export function widths(layout: Layout, viewport: number, alfredBeside = false): { nav: number; navMode: NavMode; alf: number } {
  let navMode = layout.nav;
  let nav = navMode === "hidden" ? 0 : layout.navW;
  if (alfredBeside && navMode === "full") {
    const spare = viewport - ALF.min - ALF.pageFloor;
    if (spare < NAV.min) { navMode = "hidden"; nav = 0; }
    else nav = Math.min(nav, spare);
  }
  const room = viewport - nav - ALF.pageMin;
  return { nav, navMode, alf: Math.max(ALF.min, Math.min(layout.alfW, ALF.max, room)) };
}

export function useViewportWidth(): number {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}

/**
 * A divider drag. `edge` says which way is wider: the sidebar grows to the right, Alfred to the left.
 * Returns pointer handlers for the divider element.
 */
export function dragHandle(start: number, edge: "right" | "left", onMove: (width: number) => void, onEnd?: () => void) {
  return (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    target.classList.add("active");
    document.body.classList.add("resizing");
    const x0 = event.clientX;
    const move = (moved: PointerEvent) => {
      if (moved.pointerId === event.pointerId) onMove(start + (edge === "right" ? moved.clientX - x0 : x0 - moved.clientX));
    };
    const up = (ended: PointerEvent) => {
      if (ended.pointerId !== event.pointerId) return;
      target.classList.remove("active");
      document.body.classList.remove("resizing");
      target.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("lostpointercapture", up, true);
      onEnd?.();
    };
    target.addEventListener("pointermove", move);
    // A narrower layout can remove the divider while the pointer is still down.
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("lostpointercapture", up, true);
  };
}
