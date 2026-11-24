/** The browser pane of a development session (docs/design/dev-terminal-browser.md), only in the Mac app: the app lays
 * a real browser over the rectangle this component reserves, and this draws what is around it, the address and the
 * back, forward and reload buttons. Zirma can read the page that is open here (the home node asks the app); it
 * cannot click or type in it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { desktop, type BrowserPaneState } from "./desktop.ts";
import { t } from "./i18n/index.ts";

const LAST = "zirma.browser.last";

export function BrowserPane({ onClose }: { onClose(): void }) {
  const bridge = desktop?.browser;
  const place = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<BrowserPaneState | null>(null);
  const [draft, setDraft] = useState(() => { try { return localStorage.getItem(LAST) ?? ""; } catch { return ""; } });
  const editing = useRef(false);

  // The app follows this rectangle: wherever it is laid out, that is where the browser is drawn.
  useLayoutEffect(() => {
    const element = place.current;
    if (!bridge || !element) return;
    let frame = 0;
    const tell = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) bridge.show({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
      });
    };
    // The pane is drawn over the page, so a card over the blurred page (shell/Pop.tsx) would be under it: while one is
    // open, the pane steps aside.
    const covered = () => !!document.querySelector(".ev-pop");
    let hidden = false;
    const layout = () => {
      if (covered()) { if (!hidden) { hidden = true; cancelAnimationFrame(frame); bridge.hide(); } return; }
      hidden = false;
      tell();
    };
    layout();
    const observer = new ResizeObserver(layout);
    observer.observe(element);
    observer.observe(document.documentElement);
    const cards = new MutationObserver(layout);
    cards.observe(document.body, { childList: true });
    window.addEventListener("resize", layout);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); cards.disconnect(); window.removeEventListener("resize", layout); bridge.hide(); };
  }, [bridge]);

  useEffect(() => bridge?.onState((next) => {
    setState(next);
    if (next.url && !editing.current) setDraft(next.url);
    if (next.url) { try { localStorage.setItem(LAST, next.url); } catch { /* not remembered */ } }
  }), [bridge]);

  if (!bridge) return null;
  const go = (event: FormEvent) => { event.preventDefault(); editing.current = false; if (draft.trim()) bridge.go(draft.trim()); };
  return (
    <aside className="dev-browser" aria-label={t("browser.title")}>
      <form className="dev-browser-bar" onSubmit={go}>
        <button type="button" className="icon-btn" disabled={!state?.canGoBack} onClick={() => bridge.back()} aria-label={t("browser.back")} title={t("browser.back")}>←</button>
        <button type="button" className="icon-btn" disabled={!state?.canGoForward} onClick={() => bridge.forward()} aria-label={t("browser.forward")} title={t("browser.forward")}>→</button>
        <button type="button" className="icon-btn" disabled={!state?.url} onClick={() => bridge.reload()} aria-label={t("browser.reload")} title={t("browser.reload")}>↻</button>
        <input value={draft} onChange={(event) => { editing.current = true; setDraft(event.target.value); }} onBlur={() => { editing.current = false; }}
          placeholder="localhost:5173" aria-label={t("browser.address")} spellCheck={false} autoCapitalize="off" autoCorrect="off" data-loading={state?.loading || undefined} />
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t("browser.close")} title={t("browser.close")}>×</button>
      </form>
      {state?.error && <p className="problem small dev-browser-note" role="alert">{t("browser.failed", { error: state.error })}</p>}
      <div className="dev-browser-place" ref={place}>
        {!state?.url && <p className="quiet small">{t("browser.empty")}</p>}
      </div>
    </aside>
  );
}
