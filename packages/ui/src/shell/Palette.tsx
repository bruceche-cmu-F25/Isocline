import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { t } from "../i18n/index.ts";
import { findItems, type FindCommand, type FindSources } from "./find.ts";
import { Icon } from "./icons.tsx";
import { MicButton } from "../voice/MicButton.tsx";
import { appendDictation } from "../voice/wav.ts";

type Item = FindCommand & { unread?: boolean };

export interface PaletteProps {
  find: FindSources;
  /** Ask Alfred in words: the text becomes a message in the open conversation (or a new one). */
  onAsk(text: string): void;
  onClose(): void;
}

/** ⌘K where the ask bar is not on screen (Alfred's panel is open, or the page is Code): go anywhere, run a command,
 * or just say it to Alfred. Where the bar is, ⌘K goes to the bar, which finds the same things (shell/find.ts). */
export function Palette({ find, onAsk, onClose }: PaletteProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  const items = useMemo(() => {
    const q = query.trim();
    const list: Item[] = findItems(query, find);
    if (q) {
      const ask: Item = { id: "ask", label: t("pal.ask", { text: query.trim() }), icon: "chat", hint: "↵", run: () => onAsk(query.trim()) };
      // Saying it is the default when nothing else matches.
      return list.length ? [...list, ask] : [ask];
    }
    return list;
  }, [query, find, onAsk]);

  useEffect(() => { setIndex(0); }, [query]);

  const choose = (item: Item | undefined) => { if (!item) return; onClose(); item.run(); };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setIndex((current) => Math.min(items.length - 1, current + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setIndex((current) => Math.max(0, current - 1)); }
    else if (event.key === "Enter") { event.preventDefault(); choose(items[index]); }
    else if (event.key === "Escape") { event.preventDefault(); onClose(); }
  };

  return (
    <div className="palette" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="pal" role="dialog" aria-modal="true" aria-label={t("pal.label")}>
        <span className="with-mic pal-field">
          <input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKey}
            placeholder={t("pal.placeholder")} aria-label={t("pal.label")}
            role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={items[index] ? `pal-${index}` : undefined} />
          <MicButton className="small" onText={(words) => { setQuery((now) => appendDictation(now, words)); input.current?.focus(); }} />
        </span>
        <ul id="palette-list" role="listbox">
          {items.map((item, n) => (
            <li key={item.id}>
              <button type="button" id={`pal-${n}`} role="option" aria-selected={n === index} onMouseMove={() => setIndex(n)} onClick={() => choose(item)}>
                <Icon name={item.icon} /><span>{item.label}</span>{item.unread && <i className="mark" data-k="alfred" role="img" aria-label={t("nav.unreadReply")} />}{item.hint && <kbd>{item.hint}</kbd>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
