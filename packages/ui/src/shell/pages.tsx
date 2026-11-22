/** The workspace's pages. A module's page is one of its views: the home node says which exist (StateResponse.views),
 * this registry says how to draw them, and the page gets only its own module's snapshot and the shared helpers.
 * Core pages (`core.*`: the inbox, later automations) belong to the shell and read the core's state.
 */
import type { ReactNode } from "react";
import type { Area, StateResponse, ViewContext } from "@alfred/protocol";
import type { CalendarSnapshot } from "@alfred/module-calendar/types";
import type { MailSnapshot } from "@alfred/module-mail/types";
import type { LinksSnapshot } from "@alfred/module-links/types";
import type { TodoSnapshot } from "@alfred/module-todo/types";
import { Automations } from "../Automations.tsx";
import { Calendar } from "../Calendar.tsx";
import { Mail } from "../Mail.tsx";
import { automationTitle, whenText } from "../automationText.ts";
import { Dev, sessionsOf, type DevProps } from "../Dev.tsx";
import type { NamePreference } from "../InboxEntry.tsx";
import { Inbox } from "../Inbox.tsx";
import { Links } from "../Links.tsx";
import { Settings } from "../Settings.tsx";
import { Today } from "../Today.tsx";
import { Todos } from "../Todos.tsx";
import { intlLocale, t, type Key } from "../i18n/index.ts";
import type { PageLine } from "./about.ts";
import { inboxItems, waitingCount } from "./inbox.ts";
import type { IconName } from "./icons.tsx";
import { todayModel, todaySummary } from "./today.ts";

export interface PageProps extends NamePreference {
  snapshot: unknown;
  /** Reload the current snapshot after a user action. */
  refresh(): void;
  /** Subjects (like `todo:abc`) Alfred changed in the last few seconds. */
  fresh: ReadonlySet<string>;
  /** The shared areas of life (core's kernel), for pages that sort by them. */
  areas: Area[];
  /** Core pages only: the whole state, and ways to reach the rest of the workspace. */
  state: StateResponse;
  onEnterInbox?: () => void;
  focus: string | null;
  onFocused(): void;
  openConversation(conversationId: string, runId?: string): void;
  /** To another page, and to one thing on it: an Inbox item (`p:…`), a letter (`<account>|<id>`). */
  go(page: string, item?: string): void;
  /** The thing a page was asked to bring up, and how it says it has. Mail's; the Inbox has `focus`. */
  item: string | null;
  onItem(): void;
  /** The Code page: its open session and what a conversation needs. */
  dev: Omit<DevProps, "state">;
  /** The bar under the page: where words about a thing picked on this page are written. */
  line: PageLine;
}

export interface PageDef {
  /** `<module>.<view>`, as the home node names the view. */
  key: string;
  title: string;
  icon: IconName;
  /** Category colour slot (tokens.css `data-k`). */
  k: string;
  /** Where it lives: above the workspaces (今天: Alfred's note about all of them, alone at the top of the sidebar,
   * whichever workspace is in it), the daily workspace, the other modules, coding, or the app itself (settings). */
  group: "alfred" | "work" | "modules" | "dev" | "system";
  /** The page draws its own top (no title and summary above it), and Alfred's panel steps aside for it. */
  bare?: boolean;
  /** A number for the sidebar, or nothing. */
  badge?(snapshot: unknown, state: StateResponse): number | undefined;
  /** One plain line under the page title: the facts. It also tells Alfred what you were looking at when you ask. */
  summary?(snapshot: unknown, state: StateResponse): string;
  /** What the quiet line beside the page's name says when it is not the summary: 今天 shows the date, since its
   * facts are the page itself. */
  topline?(state: StateResponse): string;
  /** Alfred's line about the page, shown under its name while nothing is going on. A few words: how many things,
   * not a sentence about them. */
  headline?(snapshot: unknown, state: StateResponse): string;
  /** Questions worth asking from this page, most useful first; the chips above the composer. */
  suggestions?(snapshot: unknown, state: StateResponse): Key[];
  render(props: PageProps): ReactNode;
}

/** The automation that fires next, if any is on. */
/** Today's calendar as the page's lines need it: what is left today, tomorrow's count, and this week's. */
function calendarCounts(snapshot: unknown, now: number = Date.now()) {
  const { today = "", events = [], sources = [] } = (snapshot as CalendarSnapshot | undefined) ?? {};
  const [y, m, d] = (today || "1970-01-01").split("-").map(Number);
  const day = (offset: number) => { const date = new Date(y, m - 1, d + offset); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
  const sinceMonday = (new Date(y, m - 1, d).getDay() + 6) % 7;
  const monday = day(-sinceMonday), sunday = day(6 - sinceMonday);
  const mine = events.filter((event) => event.response !== "declined");
  const todays = mine.filter((event) => event.startDate <= today && event.endDate >= today);
  const left = todays.filter((event) => event.start && event.startDate === today && Date.parse(event.end ?? event.start) > now).sort((a, b) => a.start!.localeCompare(b.start!));
  return {
    sources, today: todays.length, left, broken: sources.some((source) => source.error),
    tomorrow: mine.filter((event) => event.startDate <= day(1) && event.endDate >= day(1)).length,
    week: mine.filter((event) => event.endDate >= monday && event.startDate <= sunday).length,
  };
}

/** The page counts unread mail across categories; the sidebar badge tracks the primary inbox. */
function unreadMail(snapshot: unknown) {
  const { messages = [], sources = [] } = (snapshot as MailSnapshot | undefined) ?? {};
  const inbox = messages.filter((message) => message.inInbox !== false);
  const unread = inbox.filter((message) => message.unread);
  return { sources, canRead: sources.some((source) => source.canRead !== false), all: inbox.length, unread: unread.length,
    primaryUnread: unread.filter((message) => message.category === "primary").length, broken: sources.some((source) => source.error) };
}

function soonest(state: StateResponse) {
  return (state.automations ?? []).filter((automation) => automation.enabled && automation.nextAt).sort((a, b) => a.nextAt!.localeCompare(b.nextAt!))[0];
}

/** Counts the todo page and its lines share. A range running today counts as due today. */
function todoCounts(snapshot: unknown) {
  const { todos = [], today = "" } = (snapshot as TodoSnapshot | undefined) ?? {};
  // Alfred's suggestions are not todos until the user keeps them.
  const open = todos.filter((todo) => !todo.done && !todo.suggested);
  const runsToday = (todo: (typeof open)[number]) => !!todo.due && (todo.due === today || (!!todo.startDate && todo.startDate <= today && todo.due >= today));
  return {
    open: open.length,
    late: open.filter((todo) => !!todo.due && todo.due < today && !runsToday(todo)).length,
    today: open.filter(runsToday).length,
  };
}

const PAGES: PageDef[] = [
  // First, so it is where the app opens: what is next and where to go in (docs/design/today-and-inbox.md).
  {
    key: "core.today", get title() { return t("page.today"); }, icon: "alfred", k: "alfred", group: "alfred",
    summary: (_, state) => todaySummary(state),
    topline: (state) => {
      const [y, m, d] = todayModel(state).date.split("-").map(Number);
      return new Date(y, m - 1, d).toLocaleDateString(intlLocale(), { month: "long", day: "numeric", weekday: "short" });
    },
    headline: (_, state) => todaySummary(state),
    render: ({ state, name, go, openConversation, line }) => <Today state={state} name={name} go={go} onOpenConversation={openConversation} line={line} />,
  },
  {
    key: "core.inbox", get title() { return t("page.inbox"); }, icon: "inbox", k: "warm", group: "work",
    badge: (_, state) => waitingCount(state),
    summary: (_, state) => {
      const waiting = waitingCount(state), rest = inboxItems(state).length - waiting;
      if (!waiting && !rest) return t("page.inbox.clear");
      return waiting ? t("page.inbox.waiting", { n: waiting }) + (rest ? t("page.inbox.rest", { n: rest }) : "") : t("page.inbox.onlyRest", { n: rest });
    },
    headline: (_, state) => {
      const waiting = waitingCount(state), rest = inboxItems(state).length - waiting;
      if (waiting) return t("head.inbox.waiting", { n: waiting });
      return rest ? t("head.inbox.results", { n: rest }) : t("head.inbox.clear");
    },
    suggestions: (_, state) => {
      const waiting = waitingCount(state), any = inboxItems(state).length > 0;
      return waiting ? ["sug.inbox.urgent", "sug.inbox.what"] : any ? ["sug.inbox.what"] : ["sug.inbox.today"];
    },
    render: ({ state, name, saveName, onEnterInbox, focus, onFocused, openConversation, line }) => (
      <Inbox state={state} name={name} saveName={saveName} onEnter={onEnterInbox} focus={focus} onFocused={onFocused} onOpenConversation={openConversation} line={line} />
    ),
  },
  {
    key: "calendar.week", get title() { return t("page.calendar"); }, icon: "cal", k: "now", group: "work",
    summary: (snapshot) => {
      const counts = calendarCounts(snapshot);
      return counts.sources.length ? t("cal.sum", { today: counts.today, week: counts.week }) : t("src.notConnected.cal");
    },
    headline: (snapshot) => {
      const counts = calendarCounts(snapshot);
      if (!counts.sources.length) return t("head.cal.connect");
      if (counts.broken) return t("head.cal.error");
      const next = counts.left[0];
      if (next) return t("head.cal.next", { at: new Date(next.start!).toTimeString().slice(0, 5), title: next.title, n: counts.left.length - 1 });
      return t(counts.today ? "head.cal.doneToday" : "head.cal.free", { n: counts.tomorrow });
    },
    suggestions: (snapshot) => calendarCounts(snapshot).sources.length ? ["sug.cal.afternoon", "sug.cal.freeDay", "sug.cal.tomorrow"] : [],
    render: ({ snapshot, line, state }) => <Calendar snapshot={snapshot as CalendarSnapshot | undefined} line={line} proposals={state.proposals} />,
  },
  {
    key: "todo.list", get title() { return t("page.todos"); }, icon: "todo", k: "blue", group: "work",
    badge: (snapshot) => (snapshot as TodoSnapshot | undefined)?.todos.filter((todo) => !todo.done && !todo.suggested).length,
    summary: (snapshot) => {
      const { open, late } = todoCounts(snapshot);
      return open ? t("page.todos.open", { n: open }) + (late ? t("page.todos.late", { n: late }) : "") : t("page.todos.allDone");
    },
    headline: (snapshot) => {
      const { open, late, today } = todoCounts(snapshot);
      if (late) return today ? t("head.todos.late", { late, today }) : t("head.todos.lateOnly", { late });
      if (today) return t("head.todos.today", { today });
      return open ? t("head.todos.open", { n: open }) : t("head.todos.clear");
    },
    suggestions: (snapshot) => {
      const { open, late } = todoCounts(snapshot);
      if (!open) return [];
      return late ? ["sug.todos.first", "sug.todos.late", "sug.todos.week"] : ["sug.todos.first", "sug.todos.week"];
    },
    render: ({ snapshot, fresh, areas, state, line }) => <Todos snapshot={snapshot as TodoSnapshot} fresh={fresh} areas={areas} automations={state.automations} calendar={state.modules.calendar as CalendarSnapshot | undefined} line={line} />,
  },
  {
    key: "mail.inbox", get title() { return t("page.mail"); }, icon: "mail", k: "teal", group: "modules",
    badge: (snapshot) => unreadMail(snapshot).primaryUnread || undefined,
    summary: (snapshot) => {
      const mail = unreadMail(snapshot);
      if (!mail.sources.length) return t("src.notConnected.mail");
      return mail.canRead ? t("mail.sum", { unread: mail.unread, n: mail.all }) : t("mail.sendOnly");
    },
    headline: (snapshot) => {
      const mail = unreadMail(snapshot);
      if (!mail.sources.length) return t("head.mail.connect");
      if (!mail.canRead) return t("mail.sendOnly");
      if (mail.broken) return t("head.mail.error");
      return mail.unread ? t("head.mail.unread", { n: mail.unread }) : t("head.mail.clear");
    },
    suggestions: (snapshot) => unreadMail(snapshot).canRead ? ["sug.mail.reply", "sug.mail.today", "sug.mail.important"] : [],
    render: ({ snapshot, state, line, item, onItem, refresh }) => <Mail snapshot={snapshot as MailSnapshot | undefined} state={state} line={line} focus={item} onFocused={onItem} refresh={refresh} />,
  },
  {
    key: "link.list", get title() { return t("page.links"); }, icon: "link", k: "violet", group: "modules",
    summary: (snapshot) => {
      const clips = (snapshot as LinksSnapshot | undefined)?.clips ?? [];
      return clips.length ? t("links.sum", { n: clips.length, unread: clips.filter((clip) => clip.state === "unread").length }) : t("links.sum.none");
    },
    headline: (snapshot) => {
      const clips = (snapshot as LinksSnapshot | undefined)?.clips ?? [];
      const unread = clips.filter((clip) => clip.state === "unread").length;
      return unread ? t("head.links.unread", { n: unread }) : t("head.links.clear");
    },
    render: ({ snapshot, fresh, areas }) => <Links snapshot={snapshot as LinksSnapshot | undefined} fresh={fresh} areas={areas} />,
  },
  {
    key: "core.automations", get title() { return t("page.automations"); }, icon: "clock", k: "green", group: "modules",
    summary: (_, state) => {
      const all = state.automations ?? [], next = soonest(state);
      if (!all.length) return t("auto.sum.empty");
      return next ? t("auto.sum.next", { on: all.filter((automation) => automation.enabled).length, when: whenText(next.nextAt!) }) : t("auto.sum.off", { n: all.length });
    },
    headline: (_, state) => {
      const next = soonest(state);
      if (!state.automations?.length) return t("head.auto.empty");
      return next ? t("head.auto.next", { name: automationTitle(next), when: whenText(next.nextAt!) }) : t("head.auto.off");
    },
    suggestions: (_, state) => [
      ...(state.automations?.some((automation) => automation.template === "brief") ? ["sug.auto.brief" as const] : []),
      "sug.auto.weekly", "sug.auto.which",
    ],
    render: ({ state, openConversation }) => <Automations state={state} onOpenConversation={openConversation} />,
  },
  {
    key: "core.dev", get title() { return t("page.dev"); }, icon: "code", k: "violet", group: "dev", bare: true,
    badge: (_, state) => sessionsOf(state).reduce((sum, conversation) => sum + conversation.attention, 0) || undefined,
    summary: (_, state) => state.projects?.length ? t("page.dev.summary", { n: state.projects.length }) : t("page.dev.none"),
    render: ({ state, dev }) => <Dev state={state} {...dev} />,
  },
  {
    key: "core.settings", get title() { return t("page.settings"); }, icon: "gear", k: "gray", group: "system",
    summary: () => t("page.settings.summary"),
    render: ({ name, saveName, dev }) => <Settings name={name} saveName={saveName} onEvent={dev.onEvent} />,
  },
];

/** The pages this home node actually has, in registry order: the core's, then each module view it offers. */
export function availablePages(state: StateResponse): PageDef[] {
  const offered = new Set(Object.entries(state.views).flatMap(([module, views]) => views.map((view) => `${module}.${view.id}`)));
  return PAGES.filter((page) => page.key.startsWith("core.") || offered.has(page.key));
}

export const moduleOf = (page: PageDef) => page.key.split(".")[0];

/** The page as Alfred hears about it with a question: which page, its title and its facts. Context, not a request. */
export interface PageView {
  context: ViewContext;
  title: string;
  headline?: string;
  suggestions: string[];
}
export function pageView(page: PageDef | undefined, state: StateResponse): PageView | undefined {
  if (!page) return undefined;
  const snapshot = state.modules[moduleOf(page)];
  const summary = page.summary?.(snapshot, state);
  return {
    context: { view: page.key, title: page.title, ...(summary ? { summary } : {}) },
    title: page.title,
    headline: page.headline?.(snapshot, state),
    suggestions: (page.suggestions?.(snapshot, state) ?? []).map((key) => t(key)),
  };
}
