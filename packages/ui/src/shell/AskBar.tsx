/** Where you talk to Alfred while its panel is closed, and where you search: one line under the page, with Alfred's
 * figure in it. The page's own controls are at its top; Alfred is at its foot, as it is on a phone and in the panel.
 * What it answers comes out of the bar as a card about the newest turn only, and what it changed shows on the page
 * itself. A conversation that grows is opened in the panel from the card. On a phone the bar takes the place of the
 * dock's tabs, and the dock's figure stays where it is.
 *
 * It is also the one place to search (⌘K comes here): words that name a page, a command or a conversation list
 * those above the bar, and Enter goes to the page or command they name; anything else Enter says to Alfred.
 *
 * And it is where words about one thing on the page are written (shell/about.ts): a mail to answer, a draft to
 * change. The thing sits in the bar before the field, the words go to it, and what comes of them shows on the page
 * where the thing is, so the card stays down for that turn unless it has something the page cannot show.
 *
 * The bar is a row of the page, not something floating over it, so nothing on the page is ever under it. Only the
 * card, the suggestions and what was found sit over the page, and only for a while.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { CoreEvent, Proposal, Run, StateResponse } from "@alfred/protocol";
import { api } from "../api.ts";
import { Request } from "../Conversation.tsx";
import type { FigureState } from "../entity/tesseract.js";
import { useLiveText } from "../live.ts";
import { t } from "../i18n/index.ts";
import { outcomeText } from "../Inbox.tsx";
import { ConversationReply } from "../ConversationReply.tsx";
import { Markdown } from "../Markdown.tsx";
import { describeReceipt, errorText } from "../receipts.ts";
import { MicButton } from "../voice/MicButton.tsx";
import { AttachButton, AttachChips, useAttachments } from "../attach.tsx";
import { appendDictation } from "../voice/wav.ts";
import type { About } from "./about.ts";
import { newestRun, standing } from "./ask.ts";
import { defaultPick, findItems, type FindSources } from "./find.ts";
import { Figure } from "./Figure.tsx";
import { Icon } from "./icons.tsx";
import { MOD } from "./Nav.tsx";
import "./ask.css";

/** How many found things are listed above the bar; typing more narrows them. */
const FOUND = 6;
/** A card that only confirms something done folds away by itself after this long (never under the pointer). */
const FOLD_MS = 8000;

const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** A proposal the run left, decided right here; its details and "change it" are in the inbox. */
function Decide({ proposal, onLook, onDecided }: { proposal: Proposal; onLook(): void; onDecided(said: string): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    action().catch((reason: Error) => setError(reason.message)).finally(() => setBusy(false));
  };
  return (
    <div className="ask-decide" data-notice-item={`p:${proposal.id}`}>
      <ol>{proposal.steps.map((step, n) => <li key={n}>{step.preview}</li>)}</ol>
      <div className="turn-actions">
        {!proposal.stale && (
          <button type="button" disabled={busy} onClick={() => act(() => api.accept(proposal.id).then(({ proposal: done }) => onDecided(outcomeText(done))))}>
            {proposal.steps.length > 1 ? t("inbox.acceptN", { n: proposal.steps.length }) : t("inbox.accept")}
          </button>
        )}
        <button type="button" className="ghost" disabled={busy} onClick={onLook}>{t("notice.look")}</button>
        <button type="button" className="ghost" disabled={busy} onClick={() => act(() => api.decline(proposal.id))}>{t("common.no")}</button>
      </div>
      {error && <p className="problem small" role="alert">{error}</p>}
    </div>
  );
}

interface CardProps {
  run: Run;
  unread: boolean;
  live?: string;
  /** What it is doing right now, from its steps. */
  doing?: string;
  receipts: CoreEvent[];
  proposal?: Proposal;
  /** What accepting or declining here came to, once the proposal is no longer open. */
  decided?: string;
  onOpen(): void;
  onProposal(id: string): void;
  onDecided(said: string): void;
  onClose(): void;
  onHover(hovered: boolean): void;
}

/** The newest turn: what was asked, in one quiet line, and Alfred's side of it. */
function AskCard({ run, unread, live, doing, receipts, proposal, decided, onOpen, onProposal, onDecided, onClose, onHover }: CardProps) {
  const body = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const where = standing(run);
  const outcome = run.outcome;
  // A long reply scrolls inside the card, following its end as it is written.
  useEffect(() => { const el = body.current; if (el && where === "busy") el.scrollTop = el.scrollHeight; }, [live, where]);
  return (
    <div className="ask-card" role="status" aria-live="polite" data-state={proposal ? "waiting" : where} onPointerEnter={() => onHover(true)} onPointerLeave={() => onHover(false)}>
      <p className="ask-asked">{run.goal}</p>
      <div className="ask-body" ref={body} data-notice-item={outcome ? `result:${run.id}` : undefined}>
        {run.request && <Request key={run.request.id} run={run} request={run.request} />}
        {where === "busy" && !live && <p className="working" role="status"><span className="working-label">{doing ?? t(run.state === "queued" ? "run.queued" : "run.thinking")}</span></p>}
        {live && !outcome && <Markdown className="reply-text live" text={live} />}
        {outcome?.reply && <ConversationReply text={outcome.reply} conversationId={run.conversationId} runId={run.id} unread={unread} />}
        {run.state === "failed" && <p className="problem">{t("run.failed")} {errorText(outcome?.error)}</p>}
        {run.state === "cancelled" && <p className="quiet">{t("run.cancelled")}</p>}
        {run.state === "interrupted" && <p className="problem">{t("run.interrupted")}</p>}
        {proposal && <Decide proposal={proposal} onLook={() => onProposal(proposal.id)} onDecided={onDecided} />}
        {decided && <p className="ask-did">{decided}</p>}
        {receipts.length > 0 && <ul className="ask-did">{receipts.map((event) => <li key={event.id}>{describeReceipt(event)}</li>)}</ul>}
      </div>
      <div className="ask-foot">
        {(run.state === "queued" || run.state === "running") && (
          <button type="button" disabled={busy} onClick={() => { setBusy(true); api.cancel(run.id).catch(() => {}).finally(() => setBusy(false)); }}>{t("common.cancel")}</button>
        )}
        {run.state === "interrupted" && <button type="button" disabled={busy} onClick={() => { setBusy(true); api.resume(run.id).catch(() => {}).finally(() => setBusy(false)); }}>{t("common.continue")}</button>}
        <span className="grow" />
        <button type="button" onClick={onOpen}>{t("ask.open")} ↗</button>
      </div>
      <button type="button" className="ask-close" aria-label={t("panel.close")} onClick={onClose}><Icon name="close" /></button>
    </div>
  );
}

export interface AskBarProps {
  state: StateResponse;
  /** The open conversation: what the card is about. */
  selected: string | null;
  figure: FigureState;
  /** Questions worth asking from the page in view. */
  suggestions: string[];
  /** In the phone's dock: the dock's own figure is the one in sight, and there is a way back to the tabs. */
  dock?: boolean;
  /** What the words can go to instead of being said: pages, commands, conversations. */
  find: FindSources;
  /** The page in view (`mail.inbox`): a turn asked about a thing on it shows there, not in the card. */
  page?: string;
  /** The thing the next words are about, picked on the page. */
  about?: About | null;
  onAbout?(about: null): void;
  /** Sends the words: to the open conversation while it is recent, else as a new one. */
  /** `attachments`: ids of files uploaded for this message. */
  onAsk(text: string, attachments?: string[]): Promise<void>;
  /** Opens the conversation in Alfred's panel. */
  onOpen(): void;
  onProposal(id: string): void;
  onEvent(listener: (event: CoreEvent) => void): () => void;
  onBack?(): void;
}

export function AskBar({ state, selected, figure, suggestions, dock, find, page, about, onAbout, onAsk, onOpen, onProposal, onEvent, onBack }: AskBarProps) {
  const [draft, setDraft] = useState("");
  /** The found thing picked with the arrow keys; null while Enter does its default. */
  const [picked, setPicked] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [card, setCard] = useState(false);
  const [doing, setDoing] = useState<{ runId: string; label: string } | null>(null);
  const [decided, setDecided] = useState<{ runId: string; text: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const hovered = useRef(false);

  const run = newestRun(state.runs, selected);
  const where = run ? standing(run) : null;
  const proposal = run ? state.proposals?.find((candidate) => candidate.runId === run.id) : undefined;


  // "It waits in your inbox" is said by the buttons while it waits, and is no longer so once decided here.
  const settled = !!proposal || decided?.runId === run?.id;
  const receipts = run ? (state.receipts[run.id] ?? []).filter((event) => event.kind !== "proposal.opened" || !settled) : [];

  // The stream ends a moment before the finished reply arrives; the words stay up for that moment.
  const words = useLiveText(run?.id, where === "busy");

  // The card comes up when the open conversation's newest turn moves: asked, waiting for you, done. One that was
  // already over when the bar appeared has been seen; one waiting for you has not been answered.
  const moved = run ? `${run.id}:${where}` : "";
  // A turn about a thing on the page in view is followed there: its draft is written where the thing is. The card
  // is for what the page cannot show: a question back, an answer in words, a failure.
  const inPlace = !!run?.context?.selection && run.context.view === page && (where === "busy" || !!proposal);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; if (where === "waiting") setCard(true); return; }
    if (moved) setCard(!inPlace);
  }, [moved]);
  // A thing was put in the bar: the cursor goes after it.
  const aboutKey = about?.key;
  useEffect(() => { if (aboutKey) { setError(null); field.current?.focus(); } }, [aboutKey]);

  // What it is doing now, from its steps as they happen.
  useEffect(() => onEvent((event) => {
    if (event.kind !== "run.step" || !event.runId) return;
    const label = String(event.payload.label ?? event.payload.tool ?? "");
    if (label === "Ask") return;
    const runId = event.runId;
    setDoing(event.payload.status === "started" ? { runId, label } : (now) => (now?.runId === runId ? null : now));
  }), [onEvent]);

  // A card that only confirmed something done folds away by itself.
  const confirmed = card && run?.state === "completed" && receipts.length > 0 && !proposal;
  useEffect(() => {
    if (!confirmed) return;
    let timer = 0;
    const fold = () => {
      if (hovered.current || field.current?.value) { timer = window.setTimeout(fold, 2000); return; }
      setCard(false);
    };
    timer = window.setTimeout(fold, FOLD_MS);
    return () => window.clearTimeout(timer);
  }, [confirmed, run?.id]);

  // Clicking away: the suggestions go, and a card whose turn is over folds. One still going or waiting stays.
  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node)) return;
      setFocused(false);
      if (where === "over") setCard(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [where]);

  // "/" puts the cursor in the bar, from anywhere that is not a field.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || editable(event.target)) return;
      event.preventDefault();
      field.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // On a phone the bar appears because Alfred was tapped: the cursor goes straight in.
  useEffect(() => { if (dock) field.current?.focus(); }, [dock]);

  const attachments = useAttachments();
  const send = (event?: FormEvent, text = draft) => {
    event?.preventDefault();
    // Files alone are a message too; words about a picked thing take no files.
    const files = about ? [] : attachments.ids;
    const goal = text.trim() || (files.length ? t("attach.look") : "");
    if (!goal || sending || attachments.busy) return;
    setSending(true);
    setError(null);
    setDecided(null);
    if (about) {
      // Words about the thing in the bar go to it; it then leaves the bar.
      about.send(goal)
        // What comes of the words shows on the page: the cursor leaves the bar, so nothing opens over it.
        .then(() => { if (text === draft) setDraft(""); onAbout?.(null); field.current?.blur(); setFocused(false); })
        .catch((reason: Error) => setError(reason.message))
        .finally(() => setSending(false));
      return;
    }
    onAsk(goal, files)
      .then(() => { if (text === draft) setDraft(""); attachments.clear(); setCard(true); })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setSending(false));
  };
  // What the words name, listed above the bar with "ask Alfred" last, next to the field. Enter takes the row that is
  // lit: a page or a command the words name, else asking.
  const found = focused && draft.trim() && !about ? findItems(draft, find).slice(0, FOUND) : [];
  const asking = found.length;
  const lit = found.length ? picked ?? (defaultPick(found) < 0 ? asking : defaultPick(found)) : asking;
  const go = (index: number) => {
    const item = found[index];
    if (!item) { send(); return; }
    setDraft("");
    setPicked(null);
    field.current?.blur();
    setFocused(false);
    item.run();
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter that confirms an IME's candidate is not Enter that sends.
    if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) { event.preventDefault(); return; }
    if (found.length && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      setPicked(Math.max(0, Math.min(asking, lit + (event.key === "ArrowUp" ? -1 : 1))));
      return;
    }
    if (event.key === "Enter" && lit < asking) { event.preventDefault(); go(lit); return; }
    // Backing out of an empty field lets go of the thing it was about.
    if (about && !draft && (event.key === "Escape" || event.key === "Backspace")) { event.preventDefault(); onAbout?.(null); return; }
    if (event.key !== "Escape") return;
    if (card && where === "over") setCard(false);
    else { setFocused(false); field.current?.blur(); if (dock && !draft) onBack?.(); }
  };

  const showCard = card && !!run;
  const chips = about ? about.chips ?? [] : suggestions;
  const offer = focused && !draft.trim() && !sending && (about ? true : !showCard && where !== "busy") && chips.length > 0;
  return (
    <div className="ask" ref={root} data-dock={dock || undefined}>
      {((showCard && !about) || offer || error || found.length > 0 || (attachments.items.length > 0 && !about)) && (
        <div className="ask-over">
          {!about && attachments.items.length > 0 && <div className="ask-files"><AttachChips attachments={attachments} /></div>}
          {showCard && !about && (
            <AskCard key={run.id} run={run} unread={state.conversations.find((chat) => chat.id === run.conversationId)?.unreadReplyId === run.id} live={words} doing={doing?.runId === run.id ? doing.label : undefined} receipts={receipts} proposal={proposal}
              decided={decided?.runId === run.id ? decided.text : undefined}
              onOpen={onOpen} onProposal={onProposal} onDecided={(text) => { if (text) setDecided({ runId: run.id, text }); }} onClose={() => setCard(false)} onHover={(over) => { hovered.current = over; }} />
          )}
          {offer && (
            <div className="ask-chips" role="group" aria-label={t("chips.label")}>
              {/* Not taking the cursor out of the field on the way to being clicked. */}
              {chips.map((text) => <button type="button" key={text} className="suggestion" onMouseDown={(event) => event.preventDefault()} onClick={() => send(undefined, text)}>{text}</button>)}
            </div>
          )}
          {found.length > 0 && (
            <ul className="ask-found" id="ask-found" role="listbox" aria-label={t("pal.label")}>
              {[...found, { id: "ask", label: t("pal.ask", { text: draft.trim() }), icon: "chat" as const, hint: undefined, unread: false }].map((item, n) => (
                <li key={item.id}>
                  <button type="button" id={`ask-found-${n}`} role="option" aria-selected={n === lit} onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setPicked(n)} onClick={() => go(n)}>
                    <Icon name={item.icon} /><span>{item.label}</span>{item.unread && <i className="mark" data-k="alfred" role="img" aria-label={t("nav.unreadReply")} />}<kbd>{n === lit ? "↵" : item.hint}</kbd>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error && <p className="problem small ask-error" role="alert">{error}</p>}
        </div>
      )}
      <form className="ask-form" onSubmit={send} onPaste={about ? undefined : attachments.onPaste} onDrop={about ? undefined : attachments.onDrop} onDragOver={about ? undefined : attachments.onDragOver}>
        {dock
          ? <button type="button" className="icon-btn" onClick={onBack} aria-label={t("ask.back")} title={t("ask.back")}><Icon name="down" /></button>
          : <button type="button" className="ask-figure" onClick={onOpen} aria-label={t("fab.open", { key: `${MOD}.` })} title={t("fab.open", { key: `${MOD}.` })}><Figure state={figure} size={28} anchor /></button>}
        {about && (
          <span className="ask-about">
            <span>{about.label}</span>
            <button type="button" aria-label={t("ask.about.clear")} title={t("ask.about.clear")} onMouseDown={(event) => event.preventDefault()} onClick={() => onAbout?.(null)}><Icon name="close" /></button>
          </span>
        )}
        <input
          ref={field} value={draft} onChange={(event) => { setDraft(event.target.value); setPicked(null); }} onKeyDown={onKey} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          placeholder={about ? about.placeholder : t(where === "busy" ? "composer.working" : "ask.placeholder")} aria-label={about ? about.label : t("pal.label")} maxLength={8000} autoComplete="off" enterKeyHint="send"
          role="combobox" aria-expanded={found.length > 0} aria-controls="ask-found" aria-activedescendant={found.length ? `ask-found-${lit}` : undefined}
        />
        {!dock && !draft && !focused && !about && <kbd aria-hidden="true">{MOD}K</kbd>}
        {!about && <AttachButton attachments={attachments} />}
        <MicButton onText={(text) => { setDraft((now) => appendDictation(now, text)); field.current?.focus(); }} />
        <button type="submit" className="send" disabled={(!draft.trim() && !(attachments.ids.length && !about)) || sending || attachments.busy} aria-label={t("composer.send")}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11M11 5l5 5-5 5" /></svg>
        </button>
      </form>
    </div>
  );
}
