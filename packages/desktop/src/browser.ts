/** The browser pane (docs/design/dev-terminal-browser.md): a real browser inside the main window, for looking at the
 * app being built and at pages the user wants Zirma to see.
 *
 * It is a separate web view laid over a rectangle the page reserves for it. Nothing of Zirma is in it: no preload,
 * no Node, its own storage (`persist:alfred-browser`, so its sign-ins are not Chrome's and not Zirma's pages').
 * It may open http and https pages only, never Zirma's own address; pop-ups open in the pane itself; downloads and
 * every permission a page asks for (camera, location, notifications) are refused.
 *
 * Zirma never drives it. Through the home node it may ask what is on the page: its address and title, its visible
 * text, and what it logged as warnings and errors.
 */
import { session, WebContentsView, type BrowserWindow, type Rectangle } from "electron";
import { installTextMenu } from "./text-menu.ts";

export interface BrowserState { open: boolean; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; error?: string }
export interface BrowserRead { open: boolean; url?: string; title?: string; loading?: boolean; text?: string; console?: string[] }

const PARTITION = "persist:alfred-browser";
const MAX_TEXT = 20_000;
const MAX_CONSOLE = 60;

/** An address as typed: with a scheme when it has one, a local address over http, anything else over https. */
export function addressOf(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text) ? `http://${text}` : `https://${text}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

export class BrowserPane {
  readonly #window: BrowserWindow;
  readonly #own: string;
  readonly #onState: (state: BrowserState) => void;
  #view: WebContentsView | null = null;
  #shown = false;
  #console: string[] = [];
  #error: string | undefined;

  /** `own`: Zirma's own origin, which the pane never opens. */
  constructor(window: BrowserWindow, options: { own: string; onState(state: BrowserState): void }) {
    this.#window = window;
    this.#own = options.own;
    this.#onState = options.onState;
  }

  #allowed(url: string): boolean {
    try {
      const parsed = new URL(url);
      return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin !== this.#own;
    } catch { return false; }
  }

  #make(): WebContentsView {
    const store = session.fromPartition(PARTITION);
    // A page in the pane gets nothing it asks the system for, and saves nothing to disk.
    store.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    store.setPermissionCheckHandler(() => false);
    store.on("will-download", (event) => event.preventDefault());
    const view = new WebContentsView({ webPreferences: { session: store, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
    const contents = view.webContents;
    installTextMenu(this.#window, contents);
    contents.setWindowOpenHandler(({ url }) => { if (this.#allowed(url)) void contents.loadURL(url); return { action: "deny" }; });
    const guard = (event: { preventDefault(): void }, url: string) => { if (!this.#allowed(url)) event.preventDefault(); };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    contents.on("did-start-navigation", (_event, _url, inPage, mainFrame) => { if (mainFrame && !inPage) { this.#console = []; this.#error = undefined; } });
    contents.on("console-message", (event) => {
      // Warnings and errors only: what tells whether the page is broken. Electron's own advice to developers is not the page's.
      if ((event.level !== "warning" && event.level !== "error") || event.message.startsWith("Electron Security Warning")) return;
      this.#console.push(`${event.level} ${event.message.slice(0, 500)}${event.sourceId ? ` (${event.sourceId.split("/").at(-1)}:${event.lineNumber})` : ""}`);
      if (this.#console.length > MAX_CONSOLE) this.#console.shift();
    });
    contents.on("did-fail-load", (_event, code, description, _url, mainFrame) => { if (mainFrame && code !== -3) { this.#error = description || `error ${code}`; this.#say(); } });
    for (const change of ["did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page", "page-title-updated"] as const) contents.on(change as "did-stop-loading", () => this.#say());
    return view;
  }

  state(): BrowserState {
    const contents = this.#view?.webContents;
    if (!contents || contents.isDestroyed()) return { open: false, url: "", title: "", loading: false, canGoBack: false, canGoForward: false };
    return {
      open: this.#shown, url: contents.getURL(), title: contents.getTitle(), loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward(),
      ...(this.#error ? { error: this.#error } : {}),
    };
  }
  #say(): void { this.#onState(this.state()); }

  /** Lays the pane over this rectangle of the window (in the page's own pixels). */
  show(bounds: Rectangle): void {
    if (this.#window.isDestroyed()) return;
    this.#view ??= this.#make();
    const rect = { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.max(0, Math.round(bounds.width)), height: Math.max(0, Math.round(bounds.height)) };
    this.#view.setBounds(rect);
    if (!this.#shown) { this.#window.contentView.addChildView(this.#view); this.#shown = true; }
    this.#say();
  }

  /** Takes the pane off the window. Its page stays loaded, so showing it again is where it was. */
  hide(): void {
    if (this.#view && this.#shown && !this.#window.isDestroyed()) this.#window.contentView.removeChildView(this.#view);
    this.#shown = false;
    this.#say();
  }

  go(input: string): boolean {
    const url = addressOf(input);
    if (!url || !this.#allowed(url)) return false;
    this.#view ??= this.#make();
    this.#error = undefined;
    void this.#view.webContents.loadURL(url).catch(() => { /* did-fail-load says why */ });
    return true;
  }
  back(): void { this.#view?.webContents.navigationHistory.goBack(); }
  forward(): void { this.#view?.webContents.navigationHistory.goForward(); }
  reload(): void { this.#view?.webContents.reload(); }

  /** Where the pane is, without reading the page. */
  where(): BrowserRead {
    const state = this.state();
    return state.open && state.url ? { open: true, url: state.url, title: state.title, loading: state.loading } : { open: false };
  }

  /** What is on the page now: its text as the user sees it, and what it logged. */
  async read(): Promise<BrowserRead> {
    const where = this.where();
    const contents = this.#view?.webContents;
    if (!where.open || !contents) return { open: false };
    let text = "";
    try {
      // The page's own script world is not trusted with anything; this only asks it for its text.
      text = String(await contents.executeJavaScript("document.body ? document.body.innerText : ''", false) ?? "");
    } catch { /* a page that cannot be asked has no text to give */ }
    const clean = text.replace(/\n{3,}/g, "\n\n").trim();
    return { ...where, text: clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)}\n… (cut: the page has ${clean.length} characters of text)` : clean, console: [...this.#console] };
  }

  destroy(): void {
    this.hide();
    this.#view?.webContents.close();
    this.#view = null;
  }
}
