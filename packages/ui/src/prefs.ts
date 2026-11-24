/** What this device prefers: the text size, send key and phone dock shortcut. Kept in localStorage like the colour scheme
 * (scheme.ts), so a phone and the Mac can differ; public/scheme.js applies the text size before the first paint.
 */
import { useSyncExternalStore } from "react";

export type TextSize = "small" | "normal" | "large";
/** `enter`: Enter sends and Shift+Enter breaks the line. `mod`: ⌘/Ctrl+Enter sends and Enter breaks the line. */
export type SendKey = "enter" | "mod";
export const TEXT_SIZES: TextSize[] = ["small", "normal", "large"];
export const SEND_KEYS: SendKey[] = ["enter", "mod"];

const SIZE_KEY = "isocline.textSize";
const SEND_KEY = "isocline.sendKey";
const DOCK_KEY = "isocline.dockShortcut";
const DEFAULT_DOCK_SHORTCUT = "todo.list";
const root = document.documentElement;

const read = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
function write(key: string, value: string | null): void {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* private mode: lasts until the page closes */ }
}

let size: TextSize = (() => { const value = read(SIZE_KEY); return value === "small" || value === "large" ? value : "normal"; })();
// Only an absent preference uses the default. An empty saved string leaves the shortcut out.
let dockShortcut = read(DOCK_KEY) ?? DEFAULT_DOCK_SHORTCUT;
let send: SendKey = read(SEND_KEY) === "mod" ? "mod" : "enter";

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const emit = () => listeners.forEach((listener) => listener());

function applySize(): void {
  if (size === "normal") delete root.dataset.text; else root.dataset.text = size;
}
applySize();
// Another window of this device (the Mac app's presence window, a second tab) changed one.
addEventListener("storage", (event) => {
  if (event.key !== SIZE_KEY && event.key !== SEND_KEY && event.key !== DOCK_KEY && event.key !== null) return;
  const nextSize = read(SIZE_KEY), nextSend = read(SEND_KEY);
  size = nextSize === "small" || nextSize === "large" ? nextSize : "normal";
  dockShortcut = read(DOCK_KEY) ?? DEFAULT_DOCK_SHORTCUT;
  send = nextSend === "mod" ? "mod" : "enter";
  applySize();
  emit();
});

export const useTextSize = (): TextSize => useSyncExternalStore(subscribe, () => size);
export function setTextSize(next: TextSize): void {
  size = next;
  write(SIZE_KEY, next === "normal" ? null : next);
  applySize();
  emit();
}

export const useSendKey = (): SendKey => useSyncExternalStore(subscribe, () => send);
export function setSendKey(next: SendKey): void {
  send = next;
  write(SEND_KEY, next === "enter" ? null : next);
  emit();
}

export const useDockShortcut = (): string => useSyncExternalStore(subscribe, () => dockShortcut);
export function setDockShortcut(next: string): void {
  dockShortcut = next;
  write(DOCK_KEY, next === DEFAULT_DOCK_SHORTCUT ? null : next);
  emit();
}

/** Whether this key press in a text box sends what is typed. Never while an IME is composing. */
export function sends(event: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; nativeEvent: { isComposing: boolean } }): boolean {
  if (event.key !== "Enter" || event.nativeEvent.isComposing) return false;
  return send === "mod" ? event.metaKey || event.ctrlKey : !event.shiftKey;
}
