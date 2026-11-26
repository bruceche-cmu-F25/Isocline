import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../api.ts";
import { t, type Key } from "../i18n/index.ts";
import { findContent, findItems, type ContentSources, type FindItem, type FindSources } from "./find.ts";
import { Icon } from "./icons.tsx";
import { MicButton } from "../voice/MicButton.tsx";
import { appendDictation } from "../voice/wav.ts";

type Item = Omit<FindItem, "kind"> & { kind: FindItem["kind"] | "ask" };
type Kind = Item["kind"];

export interface PaletteProps {
  find: FindSources;
  /** The things on the pages: todos, events, letters. */
  content: ContentSources;
  /** Ask Zirma in words: the text becomes a message in the open conversation (or a new one). */
  onAsk(text: string): void;
  onClose(): void;
}

/** Where each kind is listed, and under which heading. Places and folders share one. */
const SECTIONS: ReadonlyArray<{ kinds: readonly Kind[]; title: Key }> = [
  { kinds: ["page"], title: "pal.pages" },
  { kinds: ["command"], title: "pal.commands" },
  { kinds: ["todo"], title: "page.todos" },
  { kinds: ["event"], title: "page.calendar" },
  { kinds: ["folder", "place"], title: "links.places" },
  { kinds: ["mail"], title: "page.mail" },
  { kinds: ["note"], title: "page.notes" },
  { kinds: ["conversation"], title: "pal.conversations" },
];

/** ⌘K, anywhere, like Spotlight: one field in the middle of the window that finds a page, a command, a todo, an
 * event, a letter, a site or a conversation, and opens it; or, at the foot, says the words to Zirma. What is listed
 * is grouped by kind, with the best match on top. The ask bar under the page is for talking to Zirma (`/`). */
export function Palette({ find, content, onAsk, onClose }: PaletteProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  // Notes are searched on the home node (their words are not in the state): a moment after typing stops.
  const [notes, setNotes] = useState<FindItem[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (!q || !content.notes) { setNotes([]); return; }
    let live = true;
    const timer = window.setTimeout(() => {
      api.query<Array<{ id: string; title: string; line: string }>>("note.search", { q, limit: 6 }).then((hits) => {
        if (!live || !Array.isArray(hits)) return;
        setNotes(hits.map((hit) => ({ kind: "note", id: `note:${hit.id}`, label: hit.title, detail: hit.line || undefined, icon: "write", run: () => content.onOpen("note.list", hit.id) })));
      }, () => { if (live) setNotes([]); });
    }, 120);
    return () => { live = false; window.clearTimeout(timer); };
  }, [query, content.notes, content.onOpen]);

  const { top, groups, items } = useMemo(() => {
    const q = query.trim();
    const found = [...findItems(query, find), ...findContent(query, content), ...notes];
    // The best match: what Enter opens. A page or command named outright, else the first thing found in the order
    // the sections show them; a conversation only when nothing else matches, as in the ask bar.
    const ordered = SECTIONS.flatMap(({ kinds }) => found.filter((item) => kinds.includes(item.kind)));
    const best = q ? ordered.find((item) => item.kind !== "conversation") ?? ordered[0] : undefined;
    const groups = SECTIONS.map(({ kinds, title }) => ({ title, items: ordered.filter((item) => kinds.includes(item.kind) && item !== best) }))
      .filter((group) => group.items.length);
    const ask: Item | undefined = q ? { kind: "ask", id: "ask", label: t("pal.ask", { text: q }), icon: "chat", run: () => onAsk(q) } : undefined;
    // Nothing found: the words go to Zirma, the only row.
    const items: Item[] = [...(best ? [best] : []), ...groups.flatMap((group) => group.items), ...(ask ? [ask] : [])];
    return { top: best, groups, items };
  }, [query, find, content, onAsk, notes]);

  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => { list.current?.querySelector(`#pal-${index}`)?.scrollIntoView({ block: "nearest" }); }, [index]);

  const choose = (item: Item | undefined) => { if (!item) return; onClose(); item.run(); };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setIndex((current) => Math.min(items.length - 1, current + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setIndex((current) => Math.max(0, current - 1)); }
    else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); choose(items.at(-1)?.kind === "ask" ? items.at(-1) : undefined); }
    else if (event.key === "Enter") { event.preventDefault(); choose(items[index]); }
    else if (event.key === "Escape") { event.preventDefault(); onClose(); }
  };

  let n = 0;
  const row = (item: Item) => {
    const at = n++;
    return (
      <li key={item.id}>
        <button type="button" id={`pal-${at}`} role="option" aria-selected={at === index} data-kind={item.kind}
          onMouseMove={() => setIndex(at)} onClick={() => choose(item)}>
          <Icon name={item.icon} />
          <span className="pal-label">{item.label}</span>
          {item.detail && <small>{item.detail}</small>}
          {item.unread && <i className="mark" data-k="alfred" role="img" aria-label={t("nav.unreadReply")} />}
          {item.kind === "ask" ? <kbd>{at === index ? "↵" : "⌘↵"}</kbd> : item.hint ? <kbd>{at === index ? "↵" : item.hint}</kbd> : at === index ? <kbd>↵</kbd> : null}
        </button>
      </li>
    );
  };
  const ask = items.at(-1)?.kind === "ask" ? items.at(-1) : undefined;

  return (
    <div className="palette" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="pal" role="dialog" aria-modal="true" aria-label={t("pal.label")}>
        <span className="with-mic pal-field">
          <Icon name="search" />
          <input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKey}
            placeholder={t("pal.placeholder")} aria-label={t("pal.label")}
            role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={items[index] ? `pal-${index}` : undefined} />
          <MicButton className="small" onText={(words) => { setQuery((now) => appendDictation(now, words)); input.current?.focus(); }} />
        </span>
        <ul id="palette-list" role="listbox" ref={list}>
          {top && <li className="pal-head" role="presentation">{t("pal.top")}</li>}
          {top && row(top)}
          {groups.map((group) => [
            <li key={`h:${group.title}`} className="pal-head" role="presentation">{t(group.title)}</li>,
            ...group.items.map(row),
          ])}
          {ask && <li className="pal-head" role="presentation">{t("pal.alfred")}</li>}
          {ask && row(ask)}
        </ul>
      </div>
    </div>
  );
}
