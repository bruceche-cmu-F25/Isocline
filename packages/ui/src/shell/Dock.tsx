import type { ReactNode } from "react";
import type { StateResponse } from "@alfred/protocol";
import type { FigureState } from "../entity/tesseract.js";
import { Figure } from "./Figure.tsx";
import { t } from "../i18n/index.ts";
import { Icon } from "./icons.tsx";
import { moduleOf, type PageDef } from "./pages.tsx";

export interface DockProps {
  state: StateResponse;
  pages: PageDef[];
  page: string;
  figure: FigureState;
  onPage(key: string): void;
  onAlfred(): void;
  /** Open the sidebar's sheet: every page, the conversations, the settings. */
  onMenu(): void;
  /** The ask bar, while the user is talking to Alfred: it takes the tabs' place, and Alfred stays where it is. */
  ask?: ReactNode;
}

/** At most this many pages get a tab; everything else is a tap away in the sheet that the three lines open. */
const TABS = 3;

/** The phone's dock, two bubbles floating over the foot of the page. At the left one pill, icons alone: three
 * lines for the sidebar's sheet (it comes in from that side, and holds the conversations and every page), then the
 * daily pages. At the right Alfred, in a circle of its own. Each button's name is its label for a screen reader;
 * the page in view says its name at its top.
 * Tapping Alfred turns the pill into the ask bar; tapping it again opens the whole conversation. */
export function Dock({ state, pages, page, figure, onPage, onAlfred, onMenu, ask }: DockProps) {
  const shown = pages.filter((item) => item.group === "work").slice(0, TABS);
  const waiting = state.conversations.reduce((sum, conversation) => sum + conversation.attention, 0);
  const button = (item: PageDef) => {
    const count = item.badge?.(state.modules[moduleOf(item)], state);
    return (
      <button type="button" key={item.key} data-k={item.k} aria-label={count ? `${item.title} (${count})` : item.title} title={item.title} aria-current={page === item.key ? "page" : undefined} onClick={() => onPage(item.key)}>
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
          {shown.map(button)}
        </div>
      )}
      <button type="button" className="dock-alfred" onClick={onAlfred} aria-label="Alfred"><Figure state={figure} size={40} anchor centered /></button>
    </nav>
  );
}
