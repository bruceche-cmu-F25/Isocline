import { useRef, type CSSProperties, type ReactNode } from "react";
import type { QuickTalk } from "../voice/useQuickTalk.ts";
import type { StateResponse } from "@zirma/protocol";
import type { FigureState } from "../entity/tesseract.js";
import { Figure } from "./Figure.tsx";
import { t, getAssistant } from "../i18n/index.ts";
import { useDockShortcut } from "../prefs.ts";
import { Icon } from "./icons.tsx";
import { dockPages, moduleOf, type PageDef } from "./pages.tsx";

export interface DockProps {
  state: StateResponse;
  pages: PageDef[];
  page: string;
  figure: FigureState;
  onPage(key: string): void;
  onZirma(): void;
  /** Open the sidebar's sheet: every page, the conversations, the settings. */
  onMenu(): void;
  /** The ask bar, while the user is talking to Zirma: it takes the tabs' place, and Zirma stays where it is. */
  ask?: ReactNode;
  /** Quick talk: holding Zirma is talking to it; letting go sends. */
  talk?: QuickTalk;
}

/** Held this long, a press on Zirma is talking, not a tap. */
const HOLD_MS = 350;

/** The phone's dock, two bubbles floating over the foot of the page. At the left one pill, icons alone: three
 * lines for the sidebar's sheet (it comes in from that side, and holds the conversations and every page), then 今天
 * and the daily pages, followed by this device's optional shortcut. At the right Zirma, in a circle of its own.
 * Each button's name is its label for a screen reader; the page in view says its name at its top.
 * Tapping Zirma turns the pill into the ask bar; tapping it again opens the whole conversation. Holding it is
 * quick talk (docs/design/voice.md §1.1): it listens while held, and what was said is sent on letting go. */
export function Dock({ state, pages, page, figure, onPage, onZirma, onMenu, ask, talk }: DockProps) {
  const hold = useRef<{ timer: number; talking: boolean } | null>(null);
  const listening = talk?.state === "recording" || talk?.state === "starting";
  const shortcut = useDockShortcut();
  const { fixed, options } = dockPages(pages);
  const extra = options.find((item) => item.key === shortcut);
  const waiting = state.conversations.reduce((sum, conversation) => sum + conversation.attention, 0);
  const button = (item: PageDef) => {
    const count = item.badge?.(state.modules[moduleOf(item)], state);
    return (
      <button type="button" key={item.key} data-k={item.k} data-page={item.key} aria-label={count ? `${item.title} (${count})` : item.title} title={item.title} aria-current={page === item.key ? "page" : undefined} onClick={() => onPage(item.key)}>
        <Icon name={item.icon} />{count ? <span className="count">{count}</span> : null}
      </button>
    );
  };
  return (
    <nav className="dock" aria-label={t("nav.label")} data-asking={ask ? "" : undefined}>
      {ask ?? (
        <div className="dock-tabs">
          <button type="button" onClick={onMenu} aria-label={t("nav.menu")} title={t("nav.menu")}>
            <Icon name="menu" />{waiting ? <span className="count">{waiting}</span> : null}
          </button>
          {fixed.map(button)}
          {extra && button(extra)}
        </div>
      )}
      {listening && <span className="dock-listening" role="status" style={{ "--level": talk!.dictation.level.toFixed(2) } as CSSProperties}>{t("voice.quick.listening")}</span>}
      <button type="button" className="dock-alfred" aria-label={getAssistant()} data-listening={listening || undefined}
        onPointerDown={(event) => {
          if (!talk || event.button !== 0) return;
          const held = { timer: 0, talking: false };
          held.timer = window.setTimeout(() => { held.talking = true; talk.start(); }, HOLD_MS);
          hold.current = held;
        }}
        onPointerUp={() => {
          const held = hold.current;
          hold.current = null;
          if (held) window.clearTimeout(held.timer);
          if (held?.talking) talk?.finish();
        }}
        onPointerCancel={() => { const held = hold.current; hold.current = null; if (held) { window.clearTimeout(held.timer); if (held.talking) talk?.cancel(); } }}
        onContextMenu={(event) => event.preventDefault()}
        // A hold ends in a click too: that one is not a tap.
        onClick={(event) => { if (talk && talk.state !== "idle") { event.preventDefault(); return; } onZirma(); }}
      ><Figure state={figure} size={40} anchor centered /></button>
    </nav>
  );
}
