/** How to write in a page, on one small card: the Markdown the editor turns into blocks as you type, the keys, and
 * what pasting does. Opened from a quiet "?" in the page's corner (and from ⋯ on a phone, where the corner is the
 * dock's). The written forms are the same in every language; only what they do is translated. */
import { useEffect, useRef } from "react";
import { t, type Key } from "../i18n/index.ts";
import { Icon } from "../shell/icons.tsx";

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

/** What you type, and what it makes; examples in the user's language. */
function rows(): Array<{ group: Key; rows: Array<[string, Key]> }> {
  const page = t("notes.help.exPage"), name = t("notes.help.exName"), picture = t("notes.help.exPicture");
  return [
    { group: "notes.help.lines", rows: [
      ["# ", "notes.help.h1"], ["## ", "notes.help.h2"], ["### ", "notes.help.h3"],
      ["- ", "notes.help.bullet"], ["1. ", "notes.help.ordered"], ["[] ", "notes.help.task"], ["[x] ", "notes.help.taskDone"],
      ["> ", "notes.help.quote"], ["```", "notes.help.code"], ["---", "notes.help.rule"],
    ] },
    { group: "notes.help.words", rows: [
      [`[[${page}]]`, "notes.help.link"], [`[[${page}|${name}]]`, "notes.help.alias"], [`![[${picture}]]`, "notes.help.embed"],
      [`**${t("notes.help.exBold")}**`, "notes.help.bold"], [`\`${t("notes.help.exCode")}\``, "notes.help.inlineCode"],
    ] },
    { group: "notes.help.keys", rows: [
      [`${MOD}B`, "notes.help.bold"], [`${MOD}I`, "notes.help.italic"], [`${MOD}E`, "notes.help.inlineCode"], [`${MOD}⇧X`, "notes.help.strike"],
      ["Tab", "notes.help.indent"], ["⇧Tab", "notes.help.outdent"], [`${MOD}Z`, "notes.help.undo"],
    ] },
    { group: "notes.help.paste", rows: [
      [t("notes.help.pasteImageKey"), "notes.help.pasteImage"], [t("notes.help.pasteUrlKey"), "notes.help.pasteUrl"],
    ] },
  ];
}

export function CheatSheet({ onClose }: { onClose(): void }) {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (event: MouseEvent) => { if (card.current && !card.current.contains(event.target as Node) && !(event.target as Element).closest?.(".nt-help-btn")) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing) onClose(); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", escape); };
  }, [onClose]);
  return (
    <div className="nt-help" ref={card} role="dialog" aria-label={t("notes.help.title")}>
      <div className="nt-help-head"><b>{t("notes.help.title")}</b><button type="button" className="nt-ib" onClick={onClose} aria-label={t("common.close")}><Icon name="close" /></button></div>
      <div className="nt-help-body">
        {rows().map(({ group, rows: lines }) => (
          <section key={group}>
            <h4>{t(group)}</h4>
            <dl>{lines.map(([written, meaning]) => (
              <div key={written + meaning}><dt><code>{written}</code></dt><dd>{t(meaning)}</dd></div>
            ))}</dl>
          </section>
        ))}
        <p className="nt-help-foot">{t("notes.help.foot")}</p>
      </div>
    </div>
  );
}
