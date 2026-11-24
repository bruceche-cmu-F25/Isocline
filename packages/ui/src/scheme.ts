/** Light or dark. It follows the system unless this device chose one; the choice lives in localStorage, and
 * public/scheme.js applies it before the first paint and when the system or another window changes it.
 *
 * Changing it by hand sends a wave out from where it was clicked (wave.css): the new scheme spreads in a circle,
 * with a ring of colour on its edge. Without view transitions, or with reduced motion, it just switches.
 */
import { useSyncExternalStore, type MouseEvent } from "react";
import "./wave.css";

export type Scheme = "light" | "dark";
export type Appearance = Scheme | "system";
export interface Point { x: number; y: number }

const KEY = "isocline.scheme";
const root = document.documentElement;
const system = matchMedia("(prefers-color-scheme: dark)");
const still = matchMedia("(prefers-reduced-motion: reduce)");

export function getAppearance(): Appearance {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch { return "system"; }
}
export const getScheme = (): Scheme => (root.dataset.scheme === "dark" ? "dark" : "light");

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const watcher = new MutationObserver(emit);
function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    // scheme.js writes data-scheme for the system and for other windows; this hears all of it.
    watcher.observe(root, { attributes: true, attributeFilter: ["data-scheme"] });
    addEventListener("storage", emit);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) { watcher.disconnect(); removeEventListener("storage", emit); }
  };
}

/** What is showing now. */
export const useScheme = (): Scheme => useSyncExternalStore(subscribe, getScheme);
/** What this device chose: light, dark, or following the system. */
export const useAppearance = (): Appearance => useSyncExternalStore(subscribe, getAppearance);

/** Where a click happened; a press from the keyboard has no place, so the middle of the control. */
export function origin(event: MouseEvent<HTMLElement>): Point {
  if (event.detail > 0) return { x: event.clientX, y: event.clientY };
  const box = event.currentTarget.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/** Choose light, dark or the system's; `from` is where the wave starts (the middle of the window if not given). */
export function setAppearance(next: Appearance, from?: Point): void {
  try {
    if (next === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch { /* private mode: the choice lasts until the page closes */ }
  const scheme: Scheme = next === "system" ? (system.matches ? "dark" : "light") : next;
  if (scheme === getScheme()) { emit(); return; }
  wave(scheme, from, () => { root.dataset.scheme = scheme; emit(); });
}

let run = 0;
function wave(to: Scheme, from: Point | undefined, change: () => void): void {
  if (typeof document.startViewTransition !== "function" || still.matches || document.visibilityState !== "visible") { change(); return; }
  const x = from?.x ?? innerWidth / 2, y = from?.y ?? innerHeight / 2;
  // As far as the farthest corner, so the circle ends up covering the window.
  const reach = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  root.style.setProperty("--wave-x", `${x}px`);
  root.style.setProperty("--wave-y", `${y}px`);
  root.style.setProperty("--wave-reach", `${Math.ceil(reach)}px`);
  root.dataset.wave = to;
  const mine = ++run;
  // A second click skips the wave in flight; only the newest one clears up.
  const clear = () => {
    if (mine !== run) return;
    delete root.dataset.wave;
    for (const name of ["--wave-x", "--wave-y", "--wave-reach"]) root.style.removeProperty(name);
  };
  document.startViewTransition(change).finished.then(clear, clear);
}
