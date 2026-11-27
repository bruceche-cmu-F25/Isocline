import { useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { AwayDigest, Conversation, Notice, StateResponse } from "@zirma/protocol";
import { ApiError, api, deviceId } from "./api.ts";
import { desktop } from "./desktop.ts";
import { resumePush } from "./push.ts";
import { useRoute } from "./shell/useRoute.ts";
import { ZirmaPanel, figureState } from "./shell/ZirmaPanel.tsx";
import { Welcome } from "./shell/Welcome.tsx";
import { FirstRun, type TourStop } from "./shell/FirstRun.tsx";
import { SHOW_FIRST_RUN } from "./firstRunEvent.ts";
import type { About, Picked } from "./shell/about.ts";
import { continues } from "./shell/ask.ts";
import { AskBar } from "./shell/AskBar.tsx";
import type { FindCommand, FindSources } from "./shell/find.ts";
import { Dock } from "./shell/Dock.tsx";
import { Says } from "./shell/Says.tsx";
import type { FigureState } from "./entity/tesseract.js";
import { inboxTarget, noticeLines, reminderPage } from "./noticeText.ts";
import type { Outcome, Said } from "./speech/useSpeech.ts";
import { Icon } from "./shell/icons.tsx";
import { ALF, dragHandle, NAV, PHONE, useLayout, useMedia, useViewportWidth, widths } from "./shell/layout.ts";
import { ArchivedConversations } from "./ArchivedConversations.tsx";
import { DevAccessApproval } from "./DevAccessApproval.tsx";
import { ArchiveNotice } from "./shell/ArchiveNotice.tsx";
import { MOD, Nav } from "./shell/Nav.tsx";
import { Topbar, type Mode } from "./shell/Topbar.tsx";
import { availablePages, dockOrder, listedPages, moduleOf, pageView } from "./shell/pages.tsx";
import { pageBeside, useEdgeSwipe } from "./swipe.ts";
import { useDockShortcut } from "./prefs.ts";
import { automationTitle } from "./automationText.ts";
import { Palette } from "./shell/Palette.tsx";
import { Pair } from "./Pair.tsx";
import { assistantNameFor, detectLocale, getLocale, nextLocale, setAssistant, setLocale, t, useLocale, type Locale } from "./i18n/index.ts";
import { getScheme, setAppearance } from "./scheme.ts";
import { useZirma, type Zirma } from "./useZirma.ts";
import { handed } from "./handed.ts";
import { WindowAttention } from "./ConversationReply.tsx";
import { useOutlet } from "./outlet.ts";
import { useWriting } from "./live.ts";
import { welcomeLines } from "./welcome.ts";
import { snapshotOf } from "./modules.ts";
import { firstSentences, forSpeech, say, useKeepVoiceSettings, voiceSettings } from "./speech/voice.ts";
import { useQuickTalk } from "./voice/useQuickTalk.ts";
import { Wordmark } from "./Wordmark.tsx";

if (desktop) document.documentElement.classList.add("desktop");
desktop?.onFullScreen?.((full) => document.documentElement.classList.toggle("full-screen", full));
// An iPhone or iPad zooms the page in when a field whose text is under 16px takes focus, and leaves it zoomed: the
// page is then wider than the screen. A top scale of 1 stops that there, and pinching still zooms. (Only there:
// on Android the same line would take pinching away.)
if (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) {
  document.querySelector('meta[name="viewport"]')?.setAttribute("content", "width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover");
}

const DEV_PAGE = "core.dev";
const CHAT_PAGE = "core.chat";

/** True while the user is looking at this window: visible and focused. In the
 * Mac app the app says so; a page alone cannot tell a hidden window apart.
 */
function useAttention(): boolean {
  const read = () => document.visibilityState === "visible" && document.hasFocus();
  const [attending, setAttending] = useState(() => (desktop ? false : read()));
  useEffect(() => {
    if (desktop) return desktop.onAttention(setAttending);
    const update = () => setAttending(read());
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  return attending;
}

/** A run can stay selected while its panel is closed. Only a visible result counts as read. */
function noticeItemVisible(item: string): boolean {
  if (document.visibilityState !== "visible" || !document.hasFocus()) return false;
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-notice-item="${CSS.escape(item)}"]`)).some((element) => {
    const r = element.getBoundingClientRect();
    const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
    const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
    return right > left && bottom > top && element.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2));
  });
}

/** A notice is shown in one place only, and the home node says where (docs/design/attention.md): this window shows
 * what was handed to it, while the user is looking at it. What happens in the open conversation is already on
 * screen, so seeing it counts as being told; a result or a question elsewhere is said by Zirma (shell/Says.tsx),
 * leading there.
 */
function useNotices(notices: Notice[], onPresented: (notice: Notice) => void, ready: boolean): { shown: Notice[]; remove(notice: Notice): void; acknowledge(notice: Notice): void } {
  const [shown, setShown] = useState<Notice[]>([]);
  const handled = useRef(new Set<string>());
  const attending = useContext(WindowAttention);
  useOutlet(attending);

  useEffect(() => {
    if (!attending || !ready) return;
    for (const notice of notices) {
      if (handled.current.has(notice.id)) continue;
      const mine = handed(notice, deviceId);
      if (!mine) continue;
      const show = () => {
        if (notice.kind === "run_result" && noticeItemVisible(`result:${notice.payload.runId}`))
          return api.acknowledge(notice.id).then(() => {});
        const target = inboxTarget(notice);
        if (target && noticeItemVisible(target)) return; // Its own actions are already in view.
        setShown((current) => current.some((item) => item.id === notice.id) ? current : [...current, notice]);
      };
      handled.current.add(notice.id);
      if (mine === "again") { void show(); continue; }
      api.present(notice.id)
        .then(() => { onPresented(notice); return show(); })
        // It is no longer this window's to show. If it is handed here again, it is shown then.
        .catch(() => { handled.current.delete(notice.id); });
    }
  }, [notices, attending, ready, onPresented]);

  // Another device may have already handled an item while its card was on screen.
  useEffect(() => {
    setShown((current) => current.filter((notice) => notices.some((remaining) => remaining.id === notice.id)));
  }, [notices]);

  const remove = useCallback((notice: Notice) => setShown((current) => current.filter((item) => item.id !== notice.id)), []);
  // A question is closed by answering it.
  const acknowledge = useCallback((notice: Notice) => { if (notice.kind !== "run_request") api.acknowledge(notice.id).catch(() => {}); }, []);
  return { shown, remove, acknowledge };
}

/** How long Zirma's card about a notice stays once said (never while the pointer is on it); it stays in 通知 after. */
const STAY_MS: Record<string, number> = { welcome: 15_000, run_result: 12_000, run_interrupted: 20_000, reminder: 30_000 };

/** What Zirma says in the app about a notice; the button is what can be done here. */
function noticeSaid(notice: Notice, name: string | null, inInbox: boolean): Said {
  if (notice.kind === "welcome") {
    const { greeting, summary } = welcomeLines(notice.payload as unknown as AwayDigest, name);
    return { title: inInbox ? t("inbox.k.away") : greeting, body: summary, mood: "hello", action: t("common.gotIt") };
  }
  const { title, body, mood } = noticeLines(notice);
  const action = notice.kind === "proposal" ? t("notice.look")
    : notice.kind === "run_request" ? t("notice.answer") : t("notice.view");
  return { title, body, mood, action };
}

/** The value once it has held still for `ms`: a state that lasts a moment (a reply ends a beat before its run
 * does) should not make the figure morph there and back. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

export function App() {
  const attending = useAttention();
  const alfred = useZirma();
  const { state, error, unpaired } = alfred;
  useLocale(); // re-render in the new language when it changes
  useKeepVoiceSettings(state?.settings?.voice);
  // A phone that had notifications on gets its subscription back if the home node lost it.
  const connected = !!state;
  useEffect(() => { if (connected && !desktop) resumePush().catch(() => {}); }, [connected]);

  // What the assistant is called (Ana, Kata, or the user's own name for it): every sentence it says uses it.
  setAssistant(assistantNameFor(state?.settings));
  // The language is the user's, on the home node: follow it; if no device has set it yet, set it from this one's.
  const savedLocale = state?.settings?.locale;
  const askedLocale = useRef(false);
  useEffect(() => {
    if (!state) return;
    if (savedLocale) setLocale(savedLocale);
    else if (!askedLocale.current) { askedLocale.current = true; api.settings({ locale: detectLocale() }).catch(() => {}); }
  }, [state, savedLocale]);
  // Another device that is not paired (or was revoked): pair first; a reload then starts with its token.
  if (unpaired) return <Pair onPaired={() => location.reload()} />;
  if (!state) {
    return (
      <main className="boot">
        <Wordmark />
        <p className="quiet">{error ? t("boot.error", { error }) : t("boot.connecting")}</p>
      </main>
    );
  }

  return <WindowAttention.Provider value={attending}><Workspace state={state} alfred={alfred} /></WindowAttention.Provider>;
}

/** The workspace: sidebar, one page at a time, and Zirma beside it. */
function Workspace({ state, alfred }: { state: StateResponse; alfred: Zirma }) {
  const { connection, fresh, onEvent } = alfred;
  const writing = useWriting();
  const [layout, setLayout] = useLayout();
  const phone = useMedia(PHONE);
  const viewport = useViewportWidth();
  const [sheet, setSheet] = useState<"alfred" | "nav" | null>(null);
  const revealPage = useCallback(() => {
    setSheet(null);
  }, []);
  const route = useRoute(revealPage);
  const [newSession, setNewSession] = useState<{ projectId: string; key: number } | null>(null);
  const selected = route.selected;
  /** A phone: the dock's tabs have given way to the ask bar. */
  const [asking, setAsking] = useState(false);
  const [palette, setPalette] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [archived, setArchived] = useState<{ conversation: Conversation; reopen?: () => boolean } | null>(null);
  const dismissArchive = useCallback(() => setArchived(null), []);
  useEffect(() => onEvent((event) => {
    if (event.kind !== "conversation.archived" || !event.payload.deferred) return;
    const id = event.subject?.slice("conversation:".length);
    if (route.session === id) route.go({ session: null });
  }), [onEvent, route.session, route.go]);

  async function archiveConversation(conversation: Conversation, worktree?: "keep" | "discard", archiveRuns?: "finish" | "stop") {
    const saved = await api.updateConversation(conversation.id, { archived: true, worktree, archiveRuns });
    if (saved.archivedAt) setArchived({ conversation: saved, reopen: route.leaveArchived(conversation) });
    alfred.refresh();
  }
  async function restoreConversation({ id }: { id: string }) {
    await api.updateConversation(id, { archived: false });
    setArchived((current) => current?.conversation.id === id ? null : current);
    alfred.refresh();
  }

  const [greeting, setGreeting] = useState(true);
  const [highlighted, setHighlighted] = useState<ReadonlySet<string>>(new Set());
  const inboxFocus = route.item;
  /** To the language named, or (a quick switch) to the next one. */
  const switchLanguage = useCallback((to?: Locale) => {
    const next: Locale = to ?? nextLocale(getLocale());
    setLocale(next);
    api.settings({ locale: next }).catch(() => {});
  }, []);
  // Every page can be opened; the sidebar and the dock list the ones the user has not hidden.
  const pages = availablePages(state);
  const listed = listedPages(state, pages);
  const current = pages.find((page) => page.key === route.page) ?? pages[0];
  const navigationPage = current?.key ?? "";
  const inInbox = current?.key === "core.inbox";
  const savedName = state.settings?.preferredName ?? null;
  const [name, setName] = useState(savedName);
  useEffect(() => setName(savedName), [savedName]);
  // Use the confirmed response immediately, even before the settings event reaches this window.
  const saveName = async (next: string) => {
    const saved = await api.settings({ preferredName: next });
    setName(saved.preferredName);
  };
  // Opened on a thing a notification pointed at: nothing is put in front of it.
  const direct = useRef(!!new URLSearchParams(window.location.hash.slice(1)).get("item"));
  // The first run (shell/FirstRun.tsx): owed until the home node says it was finished or skipped; and again, on this
  // device, when Settings asks for it.
  const [firstRunOver, setFirstRunOver] = useState(false);
  const [firstRunAgain, setFirstRunAgain] = useState(false);
  useEffect(() => {
    const show = () => { setFirstRunOver(false); setFirstRunAgain(true); };
    window.addEventListener(SHOW_FIRST_RUN, show);
    return () => window.removeEventListener(SHOW_FIRST_RUN, show);
  }, []);
  const firstRun = firstRunAgain || (!firstRunOver && state.settings?.firstRunAt === null && !direct.current);
  // Greet returning users over the page they opened. A name given later belongs to the first meeting.
  const [opening, setOpening] = useState(() => !direct.current);
  const knewName = useRef(!!savedName);
  const greet = opening && knewName.current && !!name && !firstRun;
  const endOpening = useCallback(() => setOpening(false), []);
  const navStart = useRef(layout.navW);

  useEffect(() => { const timer = window.setTimeout(() => setGreeting(false), 2600); return () => window.clearTimeout(timer); }, []);

  const highlight = useCallback((runId: string) => {
    setHighlighted((current) => new Set(current).add(runId));
    window.setTimeout(() => setHighlighted((current) => { const next = new Set(current); next.delete(runId); return next; }), 2400);
  }, []);
  const onPresented = useCallback((notice: Notice) => {
    const runId = String(notice.payload.runId ?? "");
    if (runId) highlight(runId);
  }, [highlight]);
  const { shown, remove: unshow, acknowledge } = useNotices(state.notices, onPresented, !firstRun && !greet);
  /** Zirma's look while it is telling the user something. */
  const [speaking, setSpeaking] = useState<FigureState | null>(null);

  /** Bring Zirma's panel up: beside the page on a desktop, as a sheet on a phone. */
  const showZirma = useCallback(() => {
    if (phone) setSheet("alfred");
    else if (layout.alfred === "closed") setLayout({ alfred: "open" });
  }, [phone, layout.alfred, setLayout]);

  /** Opens a development session on the Code page. */
  const openSession = useCallback((id: string | null, projectId?: string) => {
    setNewSession((previous) => projectId ? { projectId, key: (previous?.key ?? 0) + 1 } : null);
    route.go({ page: DEV_PAGE, session: id, item: null });
    setSheet(null);
  }, [route]);

  const select = useCallback((id: string | null) => {
    // A development session opens on the Code page, not in Zirma's panel.
    if (id && state?.conversations.find((conversation) => conversation.id === id)?.projectId) { openSession(id); return; }
    route.go({ selected: id });
    showZirma();
  }, [route, showZirma, state?.conversations, openSession]);

  /** A conversation opened on the Chats page: it is the page there, so Zirma's panel stays as it was. */
  const openHere = useCallback((id: string | null) => route.go({ selected: id }), [route]);
  /** Going to a conversation, rather than asking beside a page (docs/design/chat.md §4.3): ⌘K, a new conversation, the
   * panel's "Open in Chats". An everyday one opens on the Chats page, a development session on the Code page. */
  const openInChats = useCallback((id: string | null) => {
    if (id && state?.conversations.find((conversation) => conversation.id === id)?.projectId) { openSession(id); return; }
    setSheet(null);
    route.go({ page: CHAT_PAGE, selected: id });
  }, [route, state?.conversations, openSession]);
  const showInboxItem = useCallback((item: string) => {
    route.go({ page: "core.inbox", item });
    revealPage();
  }, [route, revealPage]);

  const showProposal = useCallback((id: string) => showInboxItem(`p:${id}`), [showInboxItem]);

  const openRun = useCallback((runId: string, conversationId?: string) => {
    // A run that left a proposal open: the decision is made in the inbox.
    const proposal = state?.proposals?.find((candidate) => candidate.runId === runId);
    if (proposal) { showProposal(proposal.id); return; }
    const go = (conversation: string) => {
      select(conversation);
      highlight(runId);
      window.setTimeout(() => document.getElementById(`run-${runId}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 300);
    };
    if (conversationId) go(conversationId);
    else api.run(runId).then(({ run }) => go(run.conversationId)).catch(() => {});
  }, [select, highlight, state?.proposals, showProposal]);

  const openConversation = useCallback((conversationId: string, runId?: string) => {
    select(conversationId);
    if (runId) {
      highlight(runId);
      window.setTimeout(() => document.getElementById(`run-${runId}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 300);
    }
  }, [select, highlight]);
  const onFocused = useCallback(() => {
    revealPage();
    route.go({ item: null });
  }, [route.go, revealPage]);

  const goPage = useCallback((key: string) => {
    route.go({ page: key, item: null });
    revealPage();
  }, [route, revealPage]);

  /** From one page to another, and to one thing on it. An Inbox item goes the way a notification's does. */
  const goTo = useCallback((key: string, item?: string) => {
    if (key === "core.inbox" && item) { showInboxItem(item); return; }
    route.go({ page: key, item: item ?? null });
    revealPage();
  }, [route, revealPage, showInboxItem]);
  const clearItem = useCallback(() => { route.go({ item: null }); }, [route.go]);

  // A run opened a module's view: show that page.
  const onView = useCallback((module: string, view: string) => goPage(`${module}.${view}`), [goPage]);
  const onStarted = useCallback((id: string) => route.go({ selected: id }), [route]);

  const toggleZirma = useCallback(() => {
    if (phone) setSheet((current) => current === "alfred" ? null : "alfred");
    else setLayout({ alfred: layout.alfred === "closed" ? "open" : "closed" });
  }, [phone, layout.alfred, setLayout]);

  // A bare page (Code) takes the room Zirma's panel would; on a phone the panel is a sheet anyway.
  const bare = !!current?.bare;
  const alfredMode = phone ? (sheet === "alfred" ? "open" : "closed") : bare ? "closed" : layout.alfred;
  const size = widths(layout, viewport, alfredMode === "open");
  /** The sidebar as drawn: folded away when the window has no room for it beside Zirma. */
  const navMode = size.navMode;
  const navVisible = phone ? sheet === "nav" : navMode === "full";
  /** A page with its own side column (PageDef.side) puts it where the pages list was; `navPeek` is the user going
   * back to the list while that page stays open. Opening another page ends it. */
  const [sideHost, setSideHost] = useState<HTMLElement | null>(null);
  const [navPeek, setNavPeek] = useState(false);
  useEffect(() => setNavPeek(false), [current?.key]);
  const pageSide = !!current?.side && navVisible && !phone && !navPeek;
  const toggleNav = useCallback(() => {
    // Folded for want of room: showing it puts Zirma away, which is what makes the room.
    if (layout.nav === "full" && navMode === "hidden") setLayout({ alfred: "closed" });
    else setLayout({ nav: layout.nav === "full" ? "hidden" : "full" });
  }, [layout.nav, navMode, setLayout]);
  // Settings keeps the current workspace. Each workspace remembers its last page.
  const pageMode: Mode | null = !current || current.group === "system" ? null : current.group === "dev" ? "dev" : "daily";
  const lastMode = useRef<Mode>("daily");
  const lastPage = useRef<Record<Mode, string>>({ daily: "", dev: "" });
  if (pageMode && current) { lastMode.current = pageMode; lastPage.current[pageMode] = current.key; }
  const mode = pageMode ?? lastMode.current;
  const accessRequest = state.devAccessRequests?.[0];
  const hasDev = pages.some((page) => page.group === "dev");
  const switchMode = (next: Mode) => {
    const first = listed.find((page) => (next === "dev" ? page.group === "dev" : page.group === "alfred" || page.group === "work" || page.group === "modules"));
    const key = lastPage.current[next] || first?.key;
    if (key) goPage(key);
  };
  // The page a question is asked from, unless Zirma spans the window and the page is out of sight.
  const view = pageView(current, state);
  const pageTitle = (key: string) => pages.find((page) => page.key === key)?.title;
  const automationOf = (id: string) => { const found = state?.automations?.find((automation) => automation.id === id); return found ? automationTitle(found) : undefined; };

  /** Says something to Zirma from outside its panel (the ask bar, the palette). It joins the open conversation
   * while that is recent, going straight into a turn that is still running; otherwise it starts a new one. */
  const conversations = state?.conversations, runs = state?.runs, go = route.go;
  const ask = useCallback(async (text: string, attachments?: string[]) => {
    const target = continues(conversations?.find((conversation) => conversation.id === selected), Date.now());
    const submit = () => api.submit(text, target ?? undefined, view?.context, attachments).then(({ run }) => { if (run.conversationId !== selected) go({ selected: run.conversationId }); });
    const working = target ? runs?.find((run) => run.conversationId === target && run.state === "running") : undefined;
    // A turn that asked a question takes these words as its answer: as a new message they would queue behind it.
    const asking = target ? runs?.find((run) => run.conversationId === target && run.request?.kind === "input") : undefined;
    // Words can join the turn that is working; files cannot, so with files it is the next message.
    if ((!working && !asking) || attachments?.length) return submit();
    // It may have just finished: then it goes as a new message.
    const orSubmit = (reason: unknown) => {
      if (reason instanceof ApiError && reason.status === 409) return submit();
      throw reason;
    };
    if (asking) await api.respond(asking.id, asking.request!.id, text).then(() => undefined, orSubmit);
    else await api.steer(working!.id, text).then(() => undefined, orSubmit);
  }, [conversations, runs, selected, go, view?.context]);
  /** What the user picked on the page to say something about: the bar's next words go to it (shell/about.ts). */
  const [about, setAbout] = useState<About | null>(null);
  const pageKey = current?.key;
  useEffect(() => setAbout(null), [pageKey]);
  const attach = useCallback((next: About | null) => {
    setAbout(next);
    if (!next) return;
    // The bar is where the words are written: it comes up if Zirma's panel or the phone's tabs are in its place.
    if (phone) { setSheet(null); setAsking(true); }
    else if (layout.alfred !== "closed") setLayout({ alfred: "closed" });
  }, [phone, layout.alfred, setLayout]);
  // The same page and facts are the same context, whichever render they came from.
  const contextKey = view ? JSON.stringify(view.context) : "";
  const context = useMemo(() => (contextKey ? JSON.parse(contextKey) as NonNullable<typeof view>["context"] : undefined), [contextKey]);
  /** A question about one thing on the page. It joins the open conversation only while that is recent and at rest. */
  const askPicked = useCallback(async (goal: string, picked: Picked) => {
    const open = conversations?.find((conversation) => conversation.id === selected);
    const target = open && !open.busy && !open.attention ? continues(open, Date.now()) : null;
    const { run } = await api.submit(goal, target ?? undefined, context ? { ...context, selection: picked } : undefined);
    if (run.conversationId !== selected) go({ selected: run.conversationId });
    return run.id;
  }, [conversations, selected, go, context]);
  const revisePicked = useCallback(async (proposalId: string, text: string, picked: Picked) => {
    const { run } = await api.revise(proposalId, text, context ? { ...context, selection: picked } : undefined);
    if (run && run.conversationId !== selected) go({ selected: run.conversationId });
    return run?.id ?? null;
  }, [selected, go, context]);
  const line = useMemo(() => ({ about: about?.key ?? null, attach, ask: askPicked, revise: revisePicked }), [about?.key, attach, askPicked, revisePicked]);
  /** The ask bar is where Zirma is talked to: its panel is closed and the page leaves it room. */
  const barHere = !phone && !bare && alfredMode === "closed";
  /** From the palette: the answer comes out of the ask bar when it is there, else in the panel. */
  const askAnywhere = useCallback((text: string) => {
    if (phone && !bare) setAsking(true);
    else if (!barHere) showZirma();
    ask(text).catch(() => {});
  }, [ask, phone, bare, barHere, showZirma]);

  // The Mac app: a notification was clicked, or the hotkey brought the window up.
  useEffect(() => desktop?.onFocusRun((runId) => openRun(runId)), [openRun]);
  /** Where you talk to Zirma, with the cursor in it: the ask bar when it is there (talking does not need the panel),
   * else the panel's composer. ⌘J, and the Mac app's hotkey. */
  const focusTalk = useCallback((toggle = false) => {
    const bar = document.querySelector<HTMLInputElement>(".ask-form input");
    if (bar) {
      if (toggle && document.activeElement === bar) bar.blur();
      else bar.focus();
      return;
    }
    showZirma();
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
  }, [showZirma]);
  useEffect(() => desktop?.onFocusComposer(() => focusTalk()), [focusTalk]);

  // The walk round at the end of the first run: bring each place onto the screen before the figure points at it. The
  // sidebar goes back to how it was left when the walk is over.
  const navBefore = useRef<typeof layout.nav | null>(null);
  const showStop = useCallback((stop: TourStop) => {
    setSheet(null);
    setAsking(false);
    if (navBefore.current === null) navBefore.current = layout.nav;
    if (stop === "today") route.go({ page: "core.today", item: null });
    if (!phone) setLayout(stop === "inbox" || stop === "pages" ? { nav: "full", alfred: "closed" } : { alfred: "closed" });
  }, [phone, layout.nav, route, setLayout]);
  const endFirstRun = useCallback(() => {
    setFirstRunOver(true);
    setFirstRunAgain(false);
    setOpening(false);
    if (navBefore.current !== null) setLayout({ nav: navBefore.current });
    navBefore.current = null;
  }, [setLayout]);

  const settledFigure = useSettled(state ? figureState(state, selected, writing, greeting) : "rest", 250);

  // Quick talk on a phone (docs/design/voice.md §1.1): hold the Zirma bubble, say it, let go. It joins the open
  // conversation while that is recent; the reply is said out loud and shows in the ask bar.
  const quick = useQuickTalk({
    conversation: () => continues(conversations?.find((conversation) => conversation.id === selected), Date.now()) ?? undefined,
    remember: (id) => { if (id !== selected) go({ selected: id }); },
    context: () => context ?? { view: "core.voice" },
    runs,
    onReply: (run) => {
      setAsking(true);
      if (run.request) return;
      const reply = run.outcome?.reply;
      if (reply && !voiceSettings().muted) void say(firstSentences(forSpeech(reply), 2).text, { key: `reply:${run.id}` });
    },
  });
  const quickFigure: FigureState | null = quick.state === "recording" || quick.state === "starting" ? "listen"
    : quick.state === "transcribing" || quick.state === "sending" || quick.state === "waiting" ? "think" : null;
  const figure = speaking ?? quickFigure ?? settledFigure;

  // Keyboard: ⌘K search (Spotlight-like), anywhere; ⌘J talk to Zirma; ⌘. Zirma; ⌘\ the sidebar; ⌘, Settings; ⌥1–9 the pages (not while typing).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (firstRun) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        // Like Spotlight: one search field in the middle of the window, wherever you are. Talking is the ask bar's (`/`).
        setPalette((open) => !open);
        return;
      }
      if (mod && event.key.toLowerCase() === "j") { event.preventDefault(); setPalette(false); focusTalk(true); return; }
      if (mod && event.key === ".") { event.preventDefault(); toggleZirma(); return; }
      if (mod && event.key === "\\") { event.preventDefault(); toggleNav(); return; }
      if (mod && event.key === ",") { event.preventDefault(); goPage("core.settings"); return; }
      if (event.altKey && !mod && /^Digit[1-9]$/.test(event.code) && !editable(event.target)) {
        const page = pages[Number(event.code.slice(5)) - 1];
        if (page) { event.preventDefault(); goPage(page.key); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleZirma, toggleNav, goPage, pages, firstRun, focusTalk]);

  // Sidebar divider: drag to resize; drag past the fold point to fold it to icons (keeping the width it had).
  const navDrag = dragHandle(size.nav, "right", (width) => {
    if (width < NAV.foldAt) setLayout({ nav: "hidden", navW: navStart.current });
    else setLayout({ nav: "full", navW: Math.min(NAV.max, Math.max(NAV.min, width)) });
  });
  const alfDrag = dragHandle(size.alf, "left", (width) => setLayout({ alfW: Math.min(ALF.max, Math.max(ALF.min, width)) }));

  /** What searching can run besides going to a page or a conversation: in the ask bar, and in ⌘K's palette. */
  const commands: FindCommand[] = [
    { id: "new", label: t("cmd.new"), icon: "plus", run: () => openInChats(null) },
    { id: "alfred", label: t(alfredMode === "closed" ? "cmd.openZirma" : "cmd.closeZirma"), icon: "panel", hint: `${MOD}.`, run: toggleZirma },
    ...(phone ? [] : [{ id: "nav", label: t(navMode === "full" ? "cmd.foldNav" : "cmd.unfoldNav"), icon: "rail" as const, hint: `${MOD}\\`, run: toggleNav }]),
    { id: "language", label: t("cmd.language"), icon: "chat", run: () => switchLanguage() },
    getScheme() === "dark"
      ? { id: "scheme", label: t("scheme.to.light"), icon: "sun" as const, run: () => setAppearance("light") }
      : { id: "scheme", label: t("scheme.to.dark"), icon: "moon" as const, run: () => setAppearance("dark") },
  ];
  const find: FindSources = {
    pages, commands, conversations: state.conversations, onPage: goPage, onSelect: openInChats,
    links: snapshotOf(state, "link"),
    onFolder: (id) => goTo("link.list", id),
    onPlace: (url) => { window.open(url, "_blank", "noopener,noreferrer"); },
  };

  // On a phone, a swipe in from the screen's edge goes to the page beside this one in the dock (swipe.ts). Not while
  // something is laid over the page.
  const dockShortcut = useDockShortcut();
  const dockKeys = dockOrder(listed, dockShortcut).map((page) => page.key);
  const sidebarKeys = listed.map((page) => page.key);
  const edge = useEdgeSwipe(phone && !sheet && !asking && !palette && !showArchive && !firstRun && !greet,
    (side) => current ? pageBeside(dockKeys, sidebarKeys, current.key, side) : null, goPage);
  const edgeTo = edge && pages.find((page) => page.key === edge.to);

  const pageHistory = (
    <div className="page-history" role="group" aria-label={t("nav.history")}>
      <button type="button" className="icon-btn" disabled={!route.canGoBack} onClick={route.goBack}
        aria-label={t("nav.previousPage")} title={t("nav.previousPage")}><Icon name="back" /></button>
      <button type="button" className="icon-btn" disabled={!route.canGoForward} onClick={route.goForward}
        aria-label={t("nav.nextPage")} title={t("nav.nextPage")}><Icon name="forward" /></button>
    </div>
  );

  const panel = (
    <ZirmaPanel selected={selected} figure={figure} phone={phone}
      highlighted={highlighted} view={view} pageTitle={pageTitle} automationTitle={automationOf} onEvent={onEvent} onView={onView} onStarted={onStarted}
      onOpenChats={() => openInChats(selected)}
      onClose={() => (phone ? setSheet(null) : setLayout({ alfred: "closed" }))} />
  );

  return (
    <div className="workspace" inert={firstRun || greet || undefined} data-nav={phone ? undefined : navMode} data-alfred={alfredMode} data-phone={phone || undefined}
      data-sheet={sheet ?? undefined} style={{ "--nav-px": `${size.nav}px`, "--alf-px": `${size.alf}px` } as CSSProperties}>
      {greet && <Welcome name={name!} onDone={endOpening} />}
      {firstRun && <FirstRun state={state} name={name} saveName={saveName} place={{ phone, show: showStop }} onDone={endFirstRun} />}
      {!phone && <Topbar pageHistory={pageHistory} navOpen={navMode === "full"} onNav={toggleNav} mode={mode} onMode={hasDev ? switchMode : undefined} onLanguage={switchLanguage}
        heading={current ? { title: current.title, icon: current.icon, k: current.k, summary: bare ? undefined : current.topline?.(state) ?? current.summary?.(state.modules[moduleOf(current)], state) } : undefined}
        system={pages.filter((page) => page.group === "system")} page={current?.key ?? ""} onPage={goPage} />}
      <div className="sidebar" data-visible={navVisible || undefined}>
        {navVisible && (
          <div className="side-views" data-swap={pageSide || undefined}>
            <div className="side-view side-nav" inert={pageSide || undefined}>
              <Nav state={state} pages={listed} page={navigationPage} mode={phone ? "all" : mode} session={bare ? route.session : null}
                onSession={openSession} onNewProjectSession={(projectId) => openSession(null, projectId)} connection={connection} onArchive={archiveConversation} onShowArchive={() => setShowArchive(true)}
                onPage={(key) => { if (key === current?.key) setNavPeek(false); goPage(key); }} onClose={phone ? () => setSheet(null) : undefined} onLanguage={switchLanguage} />
            </div>
            {!phone && (
              <div className="side-view side-page" inert={!pageSide || undefined} data-k={current?.k}>
                {current?.side && <button type="button" className="side-back" onClick={() => setNavPeek(true)} title={t("nav.back")}><Icon name="back" /><span>{current.title}</span></button>}
                <div className="side-host" ref={setSideHost} />
              </div>
            )}
          </div>
        )}
        {archived && <ArchiveNotice key={archived.conversation.id + archived.conversation.archivedAt} conversation={archived.conversation}
          onDismiss={dismissArchive} onUndo={async () => {
            await restoreConversation(archived.conversation);
            if (archived.reopen?.() && phone) {
              setSheet((current) => current === "nav" ? (archived.conversation.projectId ? null : "alfred") : current);
            }
          }} />}
      </div>
      {phone && sheet === "nav" && <div className="scrim" onClick={() => setSheet(null)} />}
      {showArchive && <ArchivedConversations projects={state.projects ?? []} onClose={() => setShowArchive(false)}
        onRestore={restoreConversation} onEvent={onEvent} />}

      <main className="page" data-k={current?.k} data-page={current?.key} data-bare={bare || undefined}>
        {current ? (
          <>
            {/* The top bar carries the page's name and facts; a phone has no top bar, so there the page says them. */}
            {phone && (
              <header className="page-head">
                <div className="page-heading">
                  <h1><Icon name={current.icon} />{current.title}</h1>
                  {!bare && (current.topline || current.summary) && <p className="page-sub">{current.topline?.(state) ?? current.summary?.(state.modules[moduleOf(current)], state)}</p>}
                </div>
                {pageHistory}
              </header>
            )}
            <div className="page-body">{current.render({
              snapshot: state.modules[moduleOf(current)], fresh, areas: state.areas ?? [], state, name, saveName,
              focus: inboxFocus, onFocused, openConversation, line, refresh: alfred.refresh,
              // The column stays the page's while the user looks at the pages list: it only slides out of view.
              go: goTo, item: route.item, onItem: clearItem, side: current.side && navVisible && !phone ? sideHost : null,
              dev: { session: route.session, newSession, onSession: openSession, refresh: alfred.refresh, highlighted, onEvent, pageTitle, automationTitle: automationOf },
              chat: { selected, onSelect: openHere, onShowArchive: () => setShowArchive(true), onArchive: archiveConversation, highlighted, pageTitle, automationTitle: automationOf, onEvent, onView },
            })}</div>
            {/* Under the page: the page's own controls are at its top, Zirma and search at its foot. */}
            {barHere && (
              <AskBar state={state} selected={selected} figure={figure} suggestions={view?.suggestions ?? []} find={find} page={current.key} about={about} onAbout={setAbout}
                onAsk={ask} onOpen={showZirma} onProposal={showProposal} onEvent={onEvent} />
            )}
          </>
        ) : (
          <div className="empty"><p className="empty-title">{t("page.none")}</p><p className="quiet">{t("page.noneHint")}</p></div>
        )}
      </main>

      {alfredMode !== "closed" && panel}
      {accessRequest && (
        <aside className="dev-access-notice" aria-label={t("devices.dev")} aria-live="polite">
          <DevAccessApproval key={accessRequest.id} device={accessRequest} onDecision={alfred.refresh} />
        </aside>
      )}

      {!phone && (
        <>
          {navMode === "full" && <div className="resizer resizer-nav" onPointerDown={(event) => { navStart.current = layout.navW; navDrag(event); }}
            onDoubleClick={toggleNav} title={t("resize.nav")} />}
          {alfredMode === "open" && (
            <div className="resizer resizer-alf" onPointerDown={alfDrag} onDoubleClick={() => setLayout({ alfW: ALF.def })} title={t("resize.alf")} />
          )}
        </>
      )}

      {phone && sheet !== "alfred" && (
        <Dock state={state} pages={listed} page={navigationPage} figure={figure} onPage={goPage} talk={quick}
          onZirma={() => (asking || bare ? setSheet("alfred") : setAsking(true))} onMenu={() => setSheet("nav")}
          ask={asking && !bare ? (
            <AskBar dock state={state} selected={selected} figure={figure} suggestions={view?.suggestions ?? []} find={find} page={current?.key} about={about} onAbout={setAbout}
              onAsk={ask} onOpen={() => setSheet("alfred")} onProposal={showProposal} onEvent={onEvent} onBack={() => { setAsking(false); setAbout(null); }} />
          ) : undefined} />
      )}

      {edge && edgeTo && (
        <div className="edge-pull" data-side={edge.side} data-k={edgeTo.k} data-armed={edge.pull >= 1 || undefined} aria-hidden="true"
          style={{ "--pull": edge.pull.toFixed(3) } as CSSProperties}><Icon name={edgeTo.icon} /></div>
      )}

      {palette && (
        <Palette find={find} onAsk={askAnywhere} onClose={() => setPalette(false)} content={{
          todo: snapshotOf(state, "todo"),
          calendar: snapshotOf(state, "calendar"),
          mail: snapshotOf(state, "mail"),
          notes: !!snapshotOf(state, "note"),
          onOpen: goTo,
        }} />
      )}

      {!firstRun && <Says<Notice>
        items={shown} id={(notice) => notice.id} lines={(notice) => noticeSaid(notice, name, inInbox)} stayMs={(notice) => STAY_MS[notice.kind] ?? 25_000}
        remove={unshow} onMood={setSpeaking} done={(notice, outcome: Outcome) => {
          if (outcome === "timeout") return; // left in 通知, not acknowledged
          const reminded = reminderPage(notice);
          if (reminded) {
            // Said is told: a reminder is gone once it has been seen, and opening it shows what it is about.
            acknowledge(notice);
            if (outcome === "open") goTo(reminded.page, reminded.item);
            return;
          }
          const item = inboxTarget(notice);
          if (item) {
            if (outcome === "open") showInboxItem(item);
            return; // The item closes when the user handles it in the Inbox.
          }
          acknowledge(notice);
          if (outcome === "open" && notice.payload.runId) openRun(String(notice.payload.runId), String(notice.payload.conversationId ?? "") || undefined);
        }}
      />}
    </div>
  );
}
