/** The Mac app. It is one device on the home node, with what only a Mac can
 * do: a figure always on screen that tells the user things itself (system
 * notifications only when it cannot), a menu bar item, a global hotkey, and
 * knowing when the user locks the screen and comes back.
 * The home node runs under launchd, so none of Alfred's work depends on it.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeTheme, Notification, powerMonitor, screen, shell, Tray,
  type IpcMainEvent, type MenuItemConstructorOptions,
} from "electron";
import type { AwayDigest, Notice, PresenceResponse, StateResponse } from "@alfred/protocol";
import { detectLocale, translate, type Key, type Locale } from "@alfred/ui/i18n";
import { waitingCount } from "@alfred/ui/inbox";
import { inboxTarget, inboxUrl, noticeLines } from "@alfred/ui/notice";
import { awayUpdate, welcomeLines } from "@alfred/ui/welcome";
import { BrowserPane } from "./browser.ts";
import { HomeClient } from "./client.ts";
import { ensureHomeNode, healthy, homeNodeConfig, restartHomeNode, stopHomeNode, type HomeNodeMode } from "./home-node.ts";
import { appIcon, trayIcon } from "./icon.ts";
import { installTextMenu } from "./text-menu.ts";

const HOTKEY = "Alt+Space";
/** Quick talk (docs/design/voice.md §1.1): press to start talking to Alfred, press again to send. Not ⌥Space, which
 * opens the window here and is a dictation app's default too. */
const TALK_HOTKEY = "Alt+Shift+Space";
/** Room for the figure to hop and grow and for its speech card; the transparent rest lets clicks through. */
const PRESENCE_SIZE = { width: 440, height: 280 };
const HEARTBEAT_MS = 60_000;
const IDLE_AFTER_S = 300;
/** How often the figure says how long this Mac has been left alone (the home node forgets an outlet after three of
 * these). Whether that still counts as being at the Mac is the home node's to say, not this file's. */
const OUTLET_REPORT_MS = 30_000;
/** How often it looks whether the user has come back to the keyboard, to say so at once. */
const OUTLET_CHECK_MS = 5_000;
/** Untouched for this long at the last report, and touched since: the user came back. */
const BACK_AFTER_S = 30;

app.setName("Alfred");
// The app's own files (window state, device id) live beside the world, never inside it:
// ~/Library/Application Support/Alfred/Desktop, or <data dir>/desktop for a development world.
app.setPath("userData", process.env.ALFRED_DATA_DIR ? join(process.env.ALFRED_DATA_DIR, "desktop") : join(app.getPath("appData"), "Alfred", "Desktop"));
if (!app.requestSingleInstanceLock()) app.quit();

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const preload = here("./preload.cjs");
const config = homeNodeConfig({ runtime: process.execPath, cli: here("../../server/src/cli.ts"), env: process.env });
const client = new HomeClient(config.port);

let main: BrowserWindow | null = null;
/** The browser pane of the main window (browser.ts); made with the window. */
let pane: BrowserPane | null = null;
let presence: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let mode: HomeNodeMode | "stopped" = "stopped";
/** Where the user left the figure: the window's position and the corner it sits toward. */
interface FigurePlace { x: number; y: number; h: "left" | "right"; v: "top" | "bottom" }
let settings: { showFigure: boolean; figure?: FigurePlace } = { showFigure: true };
const notifications = new Set<Notification>();
const handled = new Set<string>();
/** Notices the figure is saying, by id, to know how to close each when it is done. */
const spoken = new Map<string, Notice>();

/** This Mac's device id, kept with the app's settings. */
function deviceId(): string {
  const file = join(app.getPath("userData"), "device.json");
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as { id?: string };
    if (stored.id && /^[A-Za-z0-9._:-]{1,40}$/.test(stored.id)) return stored.id;
  } catch { /* first run */ }
  const id = `mac-${randomBytes(5).toString("hex")}`;
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(file, JSON.stringify({ id }));
  return id;
}

function loadSettings(): void {
  try { settings = { ...settings, ...JSON.parse(readFileSync(join(app.getPath("userData"), "settings.json"), "utf8")) }; } catch { /* defaults */ }
}
function saveSettings(): void {
  writeFileSync(join(app.getPath("userData"), "settings.json"), JSON.stringify(settings));
}

let DEVICE = "";
/** The user's language: their setting on the home node once it is known, the system's until then. */
let LOCALE: Locale = detectLocale(app.getLocale());
const say = (key: Key, vars?: Record<string, string | number>) => translate(LOCALE, key, vars);

function windowArgs(role: "main" | "presence"): string[] {
  return [
    `--alfred-device=${encodeURIComponent(role === "main" ? `${DEVICE}.window` : `${DEVICE}.figure`)}`,
    `--alfred-role=${role}`,
  ];
}

const webPreferences = (role: "main" | "presence") => ({
  preload, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, additionalArguments: windowArgs(role),
});

function sameOrigin(url: string): boolean {
  try { return new URL(url).origin === client.base; } catch { return false; }
}

function openExternal(url: string): void {
  try {
    if (["http:", "https:", "mailto:"].includes(new URL(url).protocol)) void shell.openExternal(url);
  } catch { /* not a URL */ }
}

/** A locked screen, or one behind its screen saver: nothing on it can be seen. */
const screenLocked = (): boolean => powerMonitor.getSystemIdleState(1) === "locked";

/** Tells the main window's page whether the user is looking at it. The page cannot reliably tell it was hidden, and
 * a window in front on a locked screen is not looked at either. `locked`: what a lock or an unlock has just said;
 * otherwise the system is asked. */
function sayAttention(window: BrowserWindow | null = main, locked: boolean = screenLocked()): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send("attention", !locked && window.isVisible() && window.isFocused());
}

function createMain(path = "/"): BrowserWindow {
  const window = new BrowserWindow({
    width: 1120, height: 760, minWidth: 720, minHeight: 480, show: false, title: "Alfred",
    titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 19 }, // centred in the 52 px top bar (styles.css --top-h)
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#171613" : "#fcf9f6", // the paper theme's page colour (tokens.css)
    webPreferences: webPreferences("main"),
  });
  installTextMenu(window, window.webContents);
  window.on("close", (event) => {
    // Closing the window hides it; Alfred keeps running.
    if (!quitting) { event.preventDefault(); window.hide(); }
  });
  const attention = () => sayAttention(window);
  for (const change of ["focus", "blur", "show", "hide", "minimize", "restore"] as const) window.on(change as "focus", attention);
  window.webContents.on("did-finish-load", attention);
  // Full screen hides the window buttons: the page drops the room it keeps for them.
  const fullScreen = () => { if (!window.isDestroyed()) window.webContents.send("full-screen", window.isFullScreen()); };
  for (const change of ["enter-full-screen", "leave-full-screen"] as const) window.on(change as "enter-full-screen", fullScreen);
  window.webContents.on("did-finish-load", fullScreen);
  window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: "deny" }; });
  window.webContents.on("will-navigate", (event, url) => { if (!sameOrigin(url)) { event.preventDefault(); openExternal(url); } });
  pane = new BrowserPane(window, { own: client.base, onState: (state) => { if (!window.isDestroyed()) window.webContents.send("browser-state", state); } });
  // A page that reloads (or leaves the session) no longer holds a place for the pane.
  window.webContents.on("did-start-navigation", (_event, _url, inPage, mainFrame) => { if (mainFrame && !inPage) pane?.hide(); });
  void window.loadURL(`${client.base}${path}`);
  return window;
}

/** The home node asks for what only this app can do (today: what is in the browser pane). The app comes for those
 * requests, one at a time, for as long as it runs. */
async function serveDesk(): Promise<void> {
  for (;;) {
    if (quitting) return;
    try {
      const response = await fetch(`${client.base}/api/desktop/requests`, { signal: AbortSignal.timeout(40_000) });
      if (!response.ok) throw new Error(`requests: ${response.status}`);
      const { request } = await response.json() as { request: { id: string; type: string } | null };
      if (!request) continue;
      let outcome: { ok: true; result: unknown } | { ok: false; error: string };
      try {
        if (request.type === "browser.where") outcome = { ok: true, result: pane?.where() ?? { open: false } };
        else if (request.type === "browser.read") outcome = { ok: true, result: await pane?.read() ?? { open: false } };
        else outcome = { ok: false, error: `This app cannot do ${request.type}` };
      } catch (error) {
        outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      await fetch(`${client.base}/api/desktop/requests/${request.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(outcome), signal: AbortSignal.timeout(10_000) }).catch(() => {});
    } catch {
      // The home node is away or older than this: try again in a while.
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

// ---- the figure's place --------------------------------------------------

/** The figure's centre from the window's edges, on the side it sits toward (padding + half the 76 px plate). */
const FIGURE_INSET = { x: 16 + 38, y: 14 + 38 };

function homePlace(): FigurePlace {
  const { workArea } = screen.getPrimaryDisplay();
  return { x: workArea.x + workArea.width - PRESENCE_SIZE.width - 8, y: workArea.y + workArea.height - PRESENCE_SIZE.height - 8, h: "right", v: "bottom" };
}

/** Where the saved place puts the figure, if that is still on a screen (displays come and go). */
function savedPlace(): FigurePlace {
  const saved = settings.figure;
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return homePlace();
  const centre = figureCentre(saved);
  const onScreen = screen.getAllDisplays().some(({ workArea: area }) =>
    centre.x >= area.x && centre.x < area.x + area.width && centre.y >= area.y && centre.y < area.y + area.height);
  return onScreen ? place(centre) : homePlace();
}

function figureCentre({ x, y, h, v }: FigurePlace): { x: number; y: number } {
  return {
    x: h === "right" ? x + PRESENCE_SIZE.width - FIGURE_INSET.x : x + FIGURE_INSET.x,
    y: v === "bottom" ? y + PRESENCE_SIZE.height - FIGURE_INSET.y : y + FIGURE_INSET.y,
  };
}

/** The window's place for a figure centred at `centre`: toward the nearest corner of its screen, so the card
 * opens toward the middle, and the whole window kept on that screen. */
function place(centre: { x: number; y: number }): FigurePlace {
  const area = screen.getDisplayNearestPoint({ x: Math.round(centre.x), y: Math.round(centre.y) }).workArea;
  const h = centre.x < area.x + area.width / 2 ? "left" : "right";
  const v = centre.y < area.y + area.height / 2 ? "top" : "bottom";
  const x = h === "right" ? centre.x - (PRESENCE_SIZE.width - FIGURE_INSET.x) : centre.x - FIGURE_INSET.x;
  const y = v === "bottom" ? centre.y - (PRESENCE_SIZE.height - FIGURE_INSET.y) : centre.y - FIGURE_INSET.y;
  const clamp = (value: number, low: number, high: number) => Math.round(Math.min(high, Math.max(low, value)));
  return { h, v, x: clamp(x, area.x, area.x + area.width - PRESENCE_SIZE.width), y: clamp(y, area.y, area.y + area.height - PRESENCE_SIZE.height) };
}

let figurePlace: FigurePlace | null = null;
let dragFrom: { window: { x: number; y: number }; cursor: { x: number; y: number } } | null = null;

function putFigure(next: FigurePlace, save: boolean): void {
  figurePlace = next;
  if (presence && !presence.isDestroyed()) {
    presence.setPosition(next.x, next.y);
    presence.webContents.send("presence-side", { h: next.h, v: next.v });
  }
  if (save) { settings.figure = next; saveSettings(); }
}

function dragFigure(phase: string): void {
  if (!presence || presence.isDestroyed() || !figurePlace) return;
  if (phase === "start") {
    const [x, y] = presence.getPosition();
    dragFrom = { window: { x, y }, cursor: screen.getCursorScreenPoint() };
  } else if (phase === "move" && dragFrom) {
    const cursor = screen.getCursorScreenPoint();
    presence.setPosition(dragFrom.window.x + cursor.x - dragFrom.cursor.x, dragFrom.window.y + cursor.y - dragFrom.cursor.y);
  } else if (phase === "end" && dragFrom) {
    const [x, y] = presence.getPosition();
    dragFrom = null;
    putFigure(place(figureCentre({ ...figurePlace, x, y })), true);
  } else {
    dragFrom = null;
  }
}

/** The quick-talk hotkey: the figure listens (shown for it if the user hid it), and a second press sends. */
function quickTalk(): void {
  if (!presence || presence.isDestroyed() || presence.webContents.isLoading()) return;
  const visiting = !presence.isVisible();
  if (visiting) presence.showInactive();
  presence.webContents.send("quick-talk", visiting);
}

function figureMenu(): void {
  if (!presence || presence.isDestroyed()) return;
  Menu.buildFromTemplate([
    { label: say("mac.open"), click: () => showMain({ composer: true }) },
    { label: say("mac.figureHome"), click: () => { delete settings.figure; saveSettings(); putFigure(homePlace(), false); } },
    { type: "separator" },
    { label: say("mac.mute"), type: "checkbox", checked: muted, click: (item) => setMuted(item.checked) },
    { label: say("mac.hideFigure"), click: () => { settings.showFigure = false; saveSettings(); presence?.hide(); updateTray(); } },
  ]).popup({ window: presence });
}

function createPresence(): BrowserWindow {
  figurePlace = savedPlace();
  const window = new BrowserWindow({
    ...PRESENCE_SIZE,
    x: figurePlace.x,
    y: figurePlace.y,
    frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, show: false, title: "Alfred",
    webPreferences: webPreferences("presence"),
  });
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Clicks pass through the transparent parts; the page says when the pointer is on the figure.
  window.setIgnoreMouseEvents(true, { forward: true });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.once("ready-to-show", () => { if (settings.showFigure) window.showInactive(); });
  window.webContents.on("did-finish-load", () => { if (figurePlace) window.webContents.send("presence-side", { h: figurePlace.h, v: figurePlace.v }); });
  void window.loadURL(`${client.base}/presence.html`);
  return window;
}

function showMain(options: { runId?: string; inbox?: string | null; composer?: boolean } = {}): void {
  const path = options.inbox !== undefined ? inboxUrl(options.inbox) : null;
  if (!main || main.isDestroyed()) main = createMain(path ?? "/");
  else if (path && main.webContents.getURL() !== client.base + path) void main.loadURL(client.base + path);
  const window = main;
  const reveal = () => {
    window.show();
    window.focus();
    if (options.runId) window.webContents.send("focus-run", options.runId);
    if (options.composer) window.webContents.send("focus-composer");
  };
  if (window.webContents.isLoading()) window.webContents.once("did-finish-load", reveal);
  else reveal();
}

function toggleMain(): void {
  if (main?.isVisible() && main.isFocused()) main.hide();
  else showMain({ composer: true });
}

// ---- notices -------------------------------------------------------------

/** Tells the home node this Mac is showing a notice it was handed. False: it is no longer this Mac's to show. */
async function present(notice: Notice): Promise<boolean> {
  try {
    await client.post(`/api/notices/${notice.id}/present`, { client: DEVICE });
    return true;
  } catch {
    return false;
  }
}

function acknowledge(id: string): void {
  client.post(`/api/notices/${id}/acknowledge`, {}).catch(() => {});
}

async function greet(notice: Notice, preferredName: string | null): Promise<void> {
  if (handled.has(notice.id)) return;
  handled.add(notice.id);
  if (!(await present(notice))) return;
  if (speak([notice])) return;
  // No figure to say it: greet with a notification instead.
  const { greeting, summary } = welcomeLines(notice.payload as unknown as AwayDigest, preferredName, LOCALE);
  notify(greeting, summary, () => openNotice(notice));
}

/** Alfred says these from the figure. If the user hid the figure, it comes out just to say them and hides again
 * when the page settles. False when there is no figure window to say them. */
function speak(notices: Notice[]): boolean {
  if (!presence || presence.isDestroyed() || presence.webContents.isLoading()) return false;
  for (const notice of notices) spoken.set(notice.id, notice);
  const visiting = !presence.isVisible();
  if (visiting) presence.showInactive();
  presence.webContents.send("say", notices, visiting);
  return true;
}

/** A notice the figure said is off the screen. Closing a result means it was seen; a question or a proposal stays
 * until it is answered or decided. One that timed out stays waiting, as a notification left in the list would. */
function noticeDone(id: string, outcome: string): void {
  const notice = spoken.get(id);
  spoken.delete(id);
  if (!notice || outcome === "timeout") return;
  if (outcome === "open") { openNotice(notice); return; }
  if (notice.kind === "welcome" || noticeLines(notice, LOCALE).closesOnOpen) acknowledge(id);
}

/** Native card and notification clicks follow the same item as the web and phone. */
function openNotice(notice: Notice): void {
  if (notice.kind === "welcome" && awayUpdate(notice.payload as unknown as AwayDigest, LOCALE)) {
    showMain({ inbox: `n:${notice.id}` });
    return;
  }
  const item = inboxTarget(notice);
  if (item) { showMain({ inbox: item }); return; }
  if (notice.kind === "welcome" || noticeLines(notice, LOCALE).closesOnOpen) acknowledge(notice.id);
  showMain({ runId: typeof notice.payload.runId === "string" ? notice.payload.runId : undefined });
}

function notify(title: string, body: string, onClick: () => void): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, silent: false });
  // Keep a reference, or a click after garbage collection is lost.
  notifications.add(notification);
  notification.on("click", () => { notifications.delete(notification); onClick(); });
  notification.on("close", () => notifications.delete(notification));
  notification.show();
}

/** The figure says what the home node handed to this Mac, and nothing else: whether the user is at the Mac, whether
 * a window is showing it already and how long to wait are the home node's to decide (core attention.ts), from what
 * this Mac and the other devices report. */
async function handleNotices(state: StateResponse): Promise<void> {
  const mine = state.notices.filter((notice) => notice.state === "claimed" && notice.claimedBy === DEVICE && !handled.has(notice.id));
  const presented: Notice[] = [];
  for (const notice of mine) {
    if (notice.kind === "welcome") { await greet(notice, state.settings?.preferredName ?? null); continue; }
    handled.add(notice.id);
    if (await present(notice)) presented.push(notice);
    else handled.delete(notice.id); // not said: if it is handed to this Mac again, it is said then
  }
  if (!presented.length || speak(presented)) return;
  // No figure to say them: system notifications.
  if (presented.length === 1) {
    const [notice] = presented;
    const { title, body } = noticeLines(notice, LOCALE);
    notify(title, body, () => openNotice(notice));
  } else {
    notify("Alfred", say("mac.several", { n: presented.length }), () => showMain({ inbox: null }));
  }
}

let refreshing: Promise<void> | null = null;
/** The Dock shows how many things wait for the user (questions, interruptions), like unread messages. */
function dockBadge(state: StateResponse): void {
  const waiting = waitingCount(state);
  app.dock?.setBadge(waiting ? String(waiting) : "");
}

/** Menus and notifications follow the user's language setting. */
/** Whether Alfred is muted, as the home node last said: the menus show it and turn it on and off. */
let muted = false;
function followVoice(state: StateResponse): void {
  const now = state.settings?.voice?.muted ?? false;
  if (now === muted) return;
  muted = now;
  updateTray();
}
function setMuted(next: boolean): void {
  muted = next;
  updateTray();
  client.post("/api/settings", { requestId: `mac-mute-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, patch: { voice: { muted: next } } })
    .catch(() => { muted = !next; updateTray(); });
}

function followLocale(state: StateResponse): void {
  const locale = state.settings?.locale;
  if (!locale || locale === LOCALE) return;
  LOCALE = locale;
  appMenu();
  updateTray();
}

/** Something changed while a refresh was under way: what it read may be from before, so it reads once more. */
let refreshAgain = false;
function refresh(): Promise<void> {
  if (refreshing) { refreshAgain = true; return refreshing; }
  refreshing = client.state().then((state) => { followLocale(state); followVoice(state); dockBadge(state); return handleNotices(state); }).catch(() => {}).finally(() => {
    refreshing = null;
    if (refreshAgain) { refreshAgain = false; void refresh(); }
  });
  return refreshing;
}

// ---- presence ------------------------------------------------------------

function reportPresence(kind: "active" | "away"): void {
  client.post<PresenceResponse>("/api/presence", { client: DEVICE, kind })
    .then((result) => { if (result.returned) void refresh(); })
    .catch(() => { /* the node is down; the next report catches up */ });
}

/** The figure, as a place where Alfred can tell the user something. It says what this Mac sees: whether its screen
 * can be seen (not locked, no screen saver), and how long since it was touched. The home node decides from that
 * whether a notice is the figure's to say (docs/design/attention.md).
 *
 * `locked`: what a lock or an unlock has just said. Otherwise the system is asked each time, and nothing is
 * remembered here: a Mac that wakes to its lock screen says nothing more until it is unlocked. */
let reported = { at: 0, idle: 0 };
function reportFigure(locked: boolean = screenLocked()): void {
  const idle = powerMonitor.getSystemIdleTime();
  reported = { at: Date.now(), idle };
  client.post("/api/outlets", { client: DEVICE, kind: "figure", attending: !locked, idleMs: idle * 1000 })
    .catch(() => { /* the node is down; the next report catches up */ });
}

/** Says it again every so often, and at once when the user comes back to the keyboard: what waited for them is
 * handed to the figure then. */
function checkFigure(): void {
  // Left alone, the time since the last touch only grows: less than was last said means something was touched.
  const back = reported.idle >= BACK_AFTER_S && powerMonitor.getSystemIdleTime() < reported.idle;
  if (back || Date.now() - reported.at >= OUTLET_REPORT_MS) reportFigure();
}

function watchPresence(): void {
  powerMonitor.on("lock-screen", () => { reportPresence("away"); reportFigure(true); sayAttention(main, true); });
  powerMonitor.on("suspend", () => reportPresence("away"));
  powerMonitor.on("unlock-screen", () => { reportPresence("active"); reportFigure(false); sayAttention(main, false); });
  powerMonitor.on("resume", () => { reportFigure(); sayAttention(); });
  setInterval(checkFigure, OUTLET_CHECK_MS).unref();
  reportFigure();
  setInterval(() => {
    if (powerMonitor.getSystemIdleState(IDLE_AFTER_S) === "active") reportPresence("active");
  }, HEARTBEAT_MS).unref();
  reportPresence("active");
}

// ---- menu bar, app menu, hotkey -------------------------------------------

function statusLabel(): string {
  if (mode === "stopped") return say("mac.node.stopped");
  if (!client.connected) return say("mac.node.connecting");
  return say(mode === "external" ? "mac.node.external" : "mac.node.live");
}

function updateTray(): void {
  if (!tray) return;
  const items: MenuItemConstructorOptions[] = [
    { label: statusLabel(), enabled: false },
    { label: say("mac.open"), accelerator: HOTKEY, click: () => showMain({ composer: true }) },
    { label: say("mac.talk"), accelerator: TALK_HOTKEY, click: () => quickTalk() },
    {
      label: say("mac.showFigure"), type: "checkbox", checked: settings.showFigure, click: (item) => {
        settings.showFigure = item.checked;
        saveSettings();
        if (item.checked) presence?.showInactive(); else presence?.hide();
      },
    },
    { label: say("mac.mute"), type: "checkbox", checked: muted, click: (item) => setMuted(item.checked) },
    { type: "separator" },
    {
      label: say("mac.node"), submenu: [
        { label: say("mac.node.restart"), enabled: mode === "launchd", click: () => void restartHomeNode(config).then(() => { mode = "launchd"; updateTray(); }) },
        { label: say(mode === "stopped" ? "mac.node.start" : "mac.node.stop"), enabled: mode !== "external", click: () => toggleHomeNode() },
        { label: say("mac.log"), enabled: existsSync(config.logFile), click: () => void shell.openPath(config.logFile) },
      ],
    },
    { label: say("mac.restart"), enabled: !restarting, click: () => void restartAlfred() },
    {
      label: say("mac.loginItem"), type: "checkbox", checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: "separator" },
    { label: say("mac.quit"), click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(`Alfred · ${statusLabel()}`);
}

/** A node someone started by hand (npm start) went away: run our own under launchd. */
async function takeOver(): Promise<void> {
  if (mode !== "external" || client.connected || (await healthy(config.port))) return;
  try {
    mode = await ensureHomeNode(config);
  } catch (error) {
    mode = "stopped";
    showStartError(error);
  }
  updateTray();
}

function toggleHomeNode(): void {
  if (mode === "stopped") {
    void ensureHomeNode(config).then((next) => { mode = next; updateTray(); }).catch(showStartError);
  } else {
    stopHomeNode(config);
    mode = "stopped";
    updateTray();
  }
}

/**
 * Restart Alfred to see a change: when run from the source tree, rebuild the page, restart the home node (when this
 * app runs it), then start the app again. The node keeps working if the build fails; the page tells why.
 */
let restarting = false;
async function restartAlfred(): Promise<void> {
  if (restarting) return;
  restarting = true;
  tray?.setToolTip(`Alfred · ${say("mac.restart")}…`);
  try {
    if (!app.isPackaged) {
      await new Promise<void>((done, fail) => execFile(process.execPath, [here("../../../node_modules/vite/bin/vite.js"), "build"],
        { cwd: here("../../ui"), env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, maxBuffer: 8 << 20 },
        (error, stdout, stderr) => (error ? fail(new Error(`${stderr || stdout}`.trim().slice(-4000) || error.message)) : done())));
    }
    if (mode === "launchd") await restartHomeNode(config);
  } catch (error) {
    restarting = false;
    updateTray();
    dialog.showMessageBoxSync({ type: "error", message: say("mac.restartError"), detail: error instanceof Error ? error.message : String(error) });
    return;
  }
  // Paths the app was started with (`electron packages/desktop`) are made absolute, whatever the new process's folder.
  app.relaunch({ args: process.argv.slice(1).map((arg) => (!arg.startsWith("-") && existsSync(arg) ? resolve(arg) : arg)) });
  app.exit(0);
}

function appMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" },
    { role: "editMenu" },
    {
      label: say("mac.view"), submenu: [
        { role: "reload" }, { label: say("mac.restart"), accelerator: "CmdOrCtrl+Shift+R", click: () => void restartAlfred() },
        { role: "toggleDevTools" }, { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ]));
}

function showStartError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const choice = dialog.showMessageBoxSync({
    type: "error", message: say("mac.startError"), detail: message, buttons: [say("mac.log"), say("mac.ok")], defaultId: 1,
  });
  if (choice === 0 && existsSync(config.logFile)) void shell.openPath(config.logFile);
}

function fromOurPages(event: IpcMainEvent): boolean {
  return sameOrigin(event.senderFrame?.url ?? "");
}

function wireIpc(): void {
  ipcMain.on("toggle-main", (event) => { if (fromOurPages(event)) toggleMain(); });
  ipcMain.on("open-main", (event, runId: unknown) => {
    if (fromOurPages(event)) showMain(typeof runId === "string" && runId ? { runId } : {});
  });
  ipcMain.on("set-interactive", (event, interactive: unknown) => {
    if (!fromOurPages(event) || !presence || event.sender !== presence.webContents) return;
    presence.setIgnoreMouseEvents(!interactive, { forward: true });
  });
  ipcMain.on("notice-done", (event, noticeId: unknown, outcome: unknown) => {
    if (fromOurPages(event) && event.sender === presence?.webContents && typeof noticeId === "string") noticeDone(noticeId, String(outcome));
  });
  ipcMain.on("presence-drag", (event, phase: unknown) => {
    if (fromOurPages(event) && event.sender === presence?.webContents) dragFigure(String(phase));
  });
  ipcMain.on("presence-menu", (event) => {
    if (fromOurPages(event) && event.sender === presence?.webContents) figureMenu();
  });
  // The figure has said everything; if the user keeps it hidden, it goes away again.
  ipcMain.on("presence-settle", (event) => {
    if (!fromOurPages(event) || !presence || event.sender !== presence.webContents) return;
    if (!settings.showFigure && presence.isVisible()) presence.hide();
  });
  // The browser pane: the page says where it is and where to go; only the main window's page may.
  const fromMain = (event: IpcMainEvent) => fromOurPages(event) && !!main && event.sender === main.webContents;
  ipcMain.on("browser-show", (event, bounds: unknown) => {
    const rect = bounds as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
    if (!fromMain(event) || !rect || ![rect.x, rect.y, rect.width, rect.height].every((value) => typeof value === "number" && Number.isFinite(value))) return;
    // The page measures in its own pixels; with the window zoomed (⌘+ / ⌘−) the window's are that many times larger.
    const zoom = main!.webContents.getZoomFactor() || 1;
    pane?.show({ x: (rect.x as number) * zoom, y: (rect.y as number) * zoom, width: (rect.width as number) * zoom, height: (rect.height as number) * zoom });
  });
  ipcMain.on("browser-hide", (event) => { if (fromMain(event)) pane?.hide(); });
  ipcMain.on("browser-go", (event, url: unknown) => { if (fromMain(event) && typeof url === "string" && url.length <= 2100) pane?.go(url); });
  ipcMain.on("browser-nav", (event, action: unknown) => {
    if (!fromMain(event)) return;
    if (action === "back") pane?.back(); else if (action === "forward") pane?.forward(); else if (action === "reload") pane?.reload();
  });
  // Adding a project: the user picks the folder in the system's own dialog, so the path is one they chose.
  ipcMain.handle("pick-folder", async (event) => {
    if (!sameOrigin(event.senderFrame?.url ?? "") || !main || event.sender !== main.webContents) return null;
    const picked = await dialog.showOpenDialog(main, { properties: ["openDirectory", "createDirectory"], message: say("mac.pickProject") });
    return picked.canceled ? null : picked.filePaths[0] ?? null;
  });
}

// ---- lifecycle -----------------------------------------------------------

app.on("second-instance", () => showMain({ composer: true }));
app.on("activate", () => showMain());
app.on("window-all-closed", () => { /* Alfred stays in the menu bar */ });
app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => globalShortcut.unregisterAll());

app.whenReady().then(async () => {
  DEVICE = deviceId();
  loadSettings();
  appMenu();
  wireIpc();
  app.dock?.setIcon(appIcon());
  tray = new Tray(trayIcon());
  tray.on("click", () => tray?.popUpContextMenu());
  updateTray();

  try {
    mode = await ensureHomeNode(config);
  } catch (error) {
    mode = "stopped";
    updateTray();
    showStartError(error);
    return;
  }
  updateTray();
  client.follow(() => void refresh(), (connected) => {
    updateTray();
    if (!connected && mode === "external") setTimeout(() => void takeOver(), 3000);
  });

  presence = createPresence();
  void serveDesk();
  if (!app.getLoginItemSettings().wasOpenedAtLogin) showMain();
  if (!globalShortcut.register(HOTKEY, toggleMain)) console.warn(`[alfred] could not register ${HOTKEY}`);
  if (!globalShortcut.register(TALK_HOTKEY, quickTalk)) console.warn(`[alfred] could not register ${TALK_HOTKEY}`);
  watchPresence();
}).catch((error: unknown) => {
  console.error(error);
  showStartError(error);
});
