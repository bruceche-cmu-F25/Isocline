/** The user's own terminal in a development session (docs/design/dev-terminal-browser.md): a shell in the session's
 * folder, on the home node's machine. xterm draws it; what is typed goes to the home node, what the shell prints
 * comes back on a stream that replays the last of it when the page returns.
 * The terminal library is loaded only when a terminal is first opened.
 */
import { useEffect, useRef, useState } from "react";
import type { TerminalInfo } from "@isocline/protocol";
import { ApiError, request as post } from "./api.ts";
import { t } from "./i18n/index.ts";
import "@xterm/xterm/css/xterm.css";

/** The page's own colours, for the terminal's background, text and cursor. */
function theme() {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return { background: read("--paper", "#f5f3ee"), foreground: read("--ink", "#2a2a2a"), cursor: read("--accent", "#4a55c8"), selectionBackground: read("--line", "#d8d5cf") };
}

export function Terminal({ session, onClose }: { session: string; onClose(): void }) {
  const host = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  /** Bumped to open a fresh shell after the last one exited. */
  const [round, setRound] = useState(0);

  useEffect(() => {
    let alive = true;
    let cleanup = () => {};
    const base = `/api/conversations/${session}/terminal`;
    setProblem(null);
    setExited(false);
    void (async () => {
      const [{ Terminal: Xterm }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (!alive || !host.current) return;
      const term = new Xterm({ fontFamily: '"SF Mono", ui-monospace, Menlo, monospace', fontSize: 12.5, lineHeight: 1.25, cursorBlink: true, scrollback: 5000, theme: theme(), allowProposedApi: false });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host.current);
      fit.fit();
      let source: EventSource | null = null;
      try {
        await post<TerminalInfo>(base, { cols: term.cols, rows: term.rows });
      } catch (reason) {
        if (alive) setProblem(reason instanceof ApiError && reason.code === "local_only" ? t("term.localOnly") : reason instanceof ApiError && reason.code === "terminal_unavailable" ? t("term.unavailable") : (reason as Error).message);
        term.dispose();
        return;
      }
      if (!alive) { term.dispose(); return; }
      // Everything the shell printed that is kept, then what it prints from now on.
      source = new EventSource(`${base}/stream?from=0`);
      source.addEventListener("output", (message) => term.write((JSON.parse((message as MessageEvent<string>).data) as { data: string }).data));
      source.addEventListener("exit", () => { setExited(true); source?.close(); });
      // The home node restarted (its shells end with it) or the terminal was closed elsewhere: the stream is refused
      // and the browser gives up on it. Said, not left as a terminal that silently takes no keys.
      source.onerror = () => { if (source?.readyState === EventSource.CLOSED && alive) setExited(true); };
      // Keys go out a few at a time: one request per burst of typing, in order.
      let pending = "", sending = Promise.resolve();
      const flush = () => { const data = pending; pending = ""; if (data) sending = sending.then(() => post(`${base}/input`, { data }).then(() => undefined, () => undefined)); };
      const typed = term.onData((data) => { pending += data; queueMicrotask(flush); });
      const resized = term.onResize(({ cols, rows }) => { void post(`${base}/resize`, { cols, rows }).catch(() => {}); });
      const observer = new ResizeObserver(() => { try { fit.fit(); } catch { /* not laid out yet */ } });
      observer.observe(host.current);
      // The page's colours change with light and dark.
      const scheme = new MutationObserver(() => { term.options.theme = theme(); });
      scheme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-scheme", "data-theme"] });
      term.focus();
      cleanup = () => { source?.close(); typed.dispose(); resized.dispose(); observer.disconnect(); scheme.disconnect(); term.dispose(); };
    })();
    return () => { alive = false; cleanup(); };
  }, [session, round]);

  const end = () => { void post(`/api/conversations/${session}/terminal/close`, {}).catch(() => {}).finally(onClose); };
  return (
    <section className="dev-term" aria-label={t("term.title")}>
      <header>
        <span>{t("term.title")}</span>
        <span className="quiet">{t("term.yours")}</span>
        <span className="grow" />
        {exited && <button type="button" className="lk-btn" onClick={() => setRound((n) => n + 1)}>{t("term.again")}</button>}
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t("term.hide")} title={t("term.hide")}>⌄</button>
        <button type="button" className="icon-btn" onClick={end} aria-label={t("term.end")} title={t("term.end")}>×</button>
      </header>
      {problem ? <p className="problem small" role="alert">{problem}</p> : <div className="dev-term-host" ref={host} />}
      {exited && !problem && <p className="quiet small dev-term-note">{t("term.exited")}</p>}
    </section>
  );
}
