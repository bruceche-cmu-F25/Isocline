import { useEffect, useRef, useState, type ReactElement } from "react";
import { getLocale, LOCALE_INFO, LOCALES, t, type Locale } from "../i18n/index.ts";
import { origin, setAppearance, useAppearance, type Appearance } from "../scheme.ts";
import { Icon, type IconName } from "./icons.tsx";
import { MOD } from "./Nav.tsx";
import type { PageDef } from "./pages.tsx";

export type Mode = "daily" | "dev" | "goals";
const MODE_ICON: Record<Mode, IconName> = { daily: "layers", dev: "code", goals: "scope" };

export interface TopbarProps {
  pageHistory: ReactElement;
  navOpen: boolean;
  onNav(): void;
  mode: Mode;
  /** The workspaces this device can switch between, in order (daily, Code, Goals). */
  modes: readonly Mode[];
  /** Absent when there is only the daily workspace: then there is nothing to switch. */
  onMode?: (mode: Mode) => void;
  onLanguage(to?: Locale): void;
  /** The page in view: its name is the bar's title, its facts the quiet line beside it. Absent when no page is in sight. */
  heading?: { title: string; icon: IconName; k: string; summary?: string };
  /** The app's own pages (Settings), as buttons at the right. */
  system: PageDef[];
  page: string;
  onPage(key: string): void;
}

/**
 * The bar across the top of the window, in two parts divided by the line that runs on down the sidebar's edge.
 * The lead is as wide as the sidebar under it: in the Mac app the window buttons, then the sidebar button, and the
 * switch between the daily workspace, Code and Goals at its right end. The switch belongs with the sidebar it changes, so
 * it goes away with it: while the sidebar is folded the lead is only the sidebar button. The rest is the page's: its name and its facts,
 * so the page under the bar starts with its contents; at the far right, one gear: Settings, with light/dark and the
 * language in the small menu it opens, since those change a few times a year.
 * The bar drags the window.
 */
export function Topbar({ pageHistory, navOpen, onNav, mode, modes, onMode, onLanguage, heading, system, page, onPage }: TopbarProps) {
  const fold = t(navOpen ? "nav.fold" : "nav.unfold");
  return (
    <header className="topbar">
      <div className="topbar-lead">
        <button type="button" className="icon-btn" onClick={onNav} aria-label={fold} aria-pressed={navOpen} title={`${fold} (${MOD}\\)`}>
          <Icon name="rail" />
        </button>
        {onMode && navOpen && (
          <div className="mode-switch" role="group" aria-label={t("top.mode")}>
            {modes.map((id) => (
              <button type="button" key={id} aria-pressed={mode === id} aria-label={t(`top.${id}`)} title={t(`top.${id}`)} onClick={() => onMode(id)}>
                <Icon name={MODE_ICON[id]} />
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="topbar-main">
        {pageHistory}
        {heading && <h1 className="topbar-title" data-k={heading.k}><Icon name={heading.icon} /><span>{heading.title}</span></h1>}
        {heading?.summary && <p className="topbar-sub">{heading.summary}</p>}
        <div className="topbar-room" />
        <SettingsMenu system={system} page={page} onPage={onPage} onLanguage={onLanguage} />
      </div>
    </header>
  );
}

/** Following the system: a circle, half filled. */
const SystemIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14z" /><path className="fill" d="M10 3a7 7 0 0 0 0 14z" /></svg>
);
const LOOKS: Array<[Appearance, () => ReactElement]> = [
  ["light", () => <Icon name="sun" />],
  ["dark", () => <Icon name="moon" />],
  ["system", SystemIcon],
];

/**
 * The gear at the right end of the bar. It opens a small menu: light / dark / the system's, the language, and the
 * Settings page itself (⌘,). The picked choice in each pair is the one in use, so nothing has to be guessed.
 * While Settings is the page in view the gear is darker, nothing more: the title already says where you are.
 */
function SettingsMenu({ system, page, onPage, onLanguage }: Pick<TopbarProps, "system" | "page" | "onPage" | "onLanguage">) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const appearance = useAppearance();
  const locale = getLocale();
  useEffect(() => {
    if (!open) return;
    // While light/dark is changing, the page is a picture of itself (a view transition) and a press lands on the
    // root, not on the menu: that is not a press beside it.
    const away = (down: PointerEvent) => {
      if (document.documentElement.dataset.wave) return;
      if (!box.current?.contains(down.target as Node)) setOpen(false);
    };
    const escape = (press: KeyboardEvent) => { if (press.key === "Escape" && !press.isComposing) setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", escape); };
  }, [open]);
  const here = system.some((item) => item.key === page);
  const title = system[0]?.title ?? t("top.allSettings");
  return (
    <div className="top-menu" ref={box}>
      <button type="button" className="icon-btn" onClick={() => setOpen((was) => !was)} aria-label={title} title={title}
        aria-haspopup="menu" aria-expanded={open} aria-current={here ? "page" : undefined}>
        <Icon name="gear" />
      </button>
      {open && (
        <div className="top-menu-card" role="menu" aria-label={t("top.menu")}>
          <div className="top-menu-row">
            <span>{t("settings.appearance")}</span>
            <span className="seg" role="radiogroup" aria-label={t("settings.appearance")}>
              {LOOKS.map(([id, Glyph]) => (
                <button type="button" key={id} role="radio" aria-checked={appearance === id} title={t(`settings.appearance.${id}`)}
                  aria-label={t(`settings.appearance.${id}`)} onClick={(event) => setAppearance(id, origin(event))}><Glyph /></button>
              ))}
            </span>
          </div>
          <div className="top-menu-row">
            <span>{t("settings.language")}</span>
            <span className="seg" role="radiogroup" aria-label={t("settings.language")}>
              {LOCALES.map((id) => (
                <button type="button" key={id} role="radio" aria-checked={locale === id} lang={LOCALE_INFO[id].tag}
                  onClick={() => { if (locale !== id) onLanguage(id); }}>{LOCALE_INFO[id].short}</button>
              ))}
            </span>
          </div>
          <hr />
          {system.map((item) => (
            <button type="button" key={item.key} role="menuitem" className="top-menu-go" onClick={() => { setOpen(false); onPage(item.key); }}>
              <Icon name={item.icon} /><span>{item.key === "core.settings" ? t("top.allSettings") : item.title}</span>
              {item.key === "core.settings" && <kbd>{MOD},</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
