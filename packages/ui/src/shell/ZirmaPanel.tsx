import type { CoreEvent, StateResponse } from "@zirma/protocol";
import type { FigureState } from "../entity/tesseract.js";
import { Conversation } from "../Conversation.tsx";
import { Figure } from "./Figure.tsx";
import { Icon } from "./icons.tsx";
import { waitingCount } from "./inbox.ts";
import { t, getAssistant } from "../i18n/index.ts";
import { MOD } from "./Nav.tsx";
import type { PageView } from "./pages.tsx";

/** What the figure shows, from the world as this device sees it: greeting on open, amber when anything waits for
 * you (a question, a proposal), the rolling tesseract while a reply streams in the open conversation, the slow double turn while any
 * run works, else calm. */
export function figureState(state: StateResponse, selected: string | null, writing: ReadonlySet<string>, greeting: boolean): FigureState {
  if (greeting) return "hello";
  if (waitingCount(state) > 0) return "notice";
  if (state.runs.some((run) => run.conversationId === selected && run.state === "running" && writing.has(run.id))) return "flow";
  if (state.runs.some((run) => run.state === "running")) return "work";
  if (state.runs.some((run) => run.state === "queued")) return "think";
  return "rest";
}

export interface ZirmaPanelProps {
  selected: string | null;
  figure: FigureState;
  phone: boolean;
  highlighted: ReadonlySet<string>;
  /** The page beside Zirma: what a question asked now is about. */
  view?: PageView;
  /** A page's title by its key, for "asked on" labels. */
  pageTitle(view: string): string | undefined;
  /** An automation's name by its id, for the runs it started. */
  automationTitle(id: string): string | undefined;
  onEvent(listener: (event: CoreEvent) => void): () => void;
  onView(module: string, view: string): void;
  onStarted(conversationId: string): void;
  /** The open conversation on the Chats page, across the whole page (docs/design/chat.md §4.3). */
  onOpenChats(): void;
  onClose(): void;
}

/** Zirma beside the page: one row with the figure and the page it is looking at, then the open conversation. */
export function ZirmaPanel({ selected, figure, phone, highlighted, view, pageTitle, automationTitle, onEvent, onView, onStarted, onOpenChats, onClose }: ZirmaPanelProps) {
  return (
    <aside className="alfred" aria-label={getAssistant()}>
      <header className="alf-head">
        <Figure state={figure} size={28} anchor />
        <p className="alf-name">Zirma{view && <span className="alf-looking">{t("panel.looking", { page: view.title })}</span>}</p>
        <div className="alf-tools">
          {!phone && (
            <button type="button" className="icon-btn" onClick={onOpenChats} aria-label={t("panel.openChats")} title={t("panel.openChats")}>
              <Icon name="chat" />
            </button>
          )}
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("panel.close")} title={phone ? t("panel.close") : t("panel.closeKey", { key: `${MOD}.` })}>
            <Icon name={phone ? "down" : "panel"} />
          </button>
        </div>
      </header>
      <Conversation key={selected ?? "new"} id={selected} highlighted={highlighted} slim
        context={view?.context} suggestions={view?.suggestions ?? []} pageTitle={pageTitle} automationTitle={automationTitle}
        onEvent={onEvent} onView={onView} onStarted={onStarted} />
    </aside>
  );
}
