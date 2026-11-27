/** A page the assistant keeps (notes-two-layers.md 4.4, 4.7, 4.8), as the user reads it: one line on top says who
 * keeps it, from how many pages and when it was brought up to date, with "Make it mine"; each line ends in small
 * numbers for its sources, and a × for "not right, remove this line"; the sources are listed at the bottom. A number
 * opens that page with the line flashing. A page changed elsewhere asks: make it yours, or give it back. On the page
 * about the user, facts from outside the notes wait with "Remember this?". Read only: nothing here is typed in. */
import type { PageDetail, Suggestion } from "@zirma/module-notes/types";
import { t } from "../i18n/index.ts";
import { Icon } from "../shell/icons.tsx";
import { when } from "../shell/Nav.tsx";
import { PageGlyph } from "./pageIcons.tsx";

/** A line's words as they read: links by their name, emphasis without its marks. */
function readable(text: string): string {
  return text
    .replace(/!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_all, target: string, alias?: string) => alias ?? target.split("/").pop() ?? target)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)(.+?)\1/g, "$2")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1$2");
}

export function KeptView({ detail, onSource, onReject, onAdopt, onReturn, onDecide }: {
  detail: PageDetail;
  /** A source's number was clicked: open that page, flashing the line's words. */
  onSource(page: string, words: string): void;
  onReject(index: number, words: string): void;
  onAdopt(): void;
  onReturn(): void;
  onDecide(suggestion: Suggestion, accept: boolean): void;
}) {
  const kept = detail.kept!;
  const updated = kept.updated ? new Date(kept.updated.replace(" ", "T")) : null;
  const pages = kept.sources.filter((source) => source.page).length;
  const asks = (detail.suggestions ?? []).filter((one) => one.kind === "remember");
  const lineText = (index: number) => kept.sections.flatMap((section) => section.lines).find((line) => line.index === index)?.text ?? "";
  return (
    <div className="nt-kept">
      {kept.state === "edited" && (
        <div className="nt-banner" role="alert">
          <span>{t("notes.kept.edited")}</span>
          <button type="button" className="nt-btn nt-pri" onClick={onAdopt}>{t("notes.kept.adopt")}</button>
          <button type="button" className="nt-btn" onClick={onReturn}>{t("notes.kept.return")}</button>
        </div>
      )}
      <div className="nt-kept-meta">
        <Icon name="alfred" />
        <span>{t(pages === 1 ? "notes.kept.metaOne" : "notes.kept.meta", { n: pages, when: updated && !Number.isNaN(updated.getTime()) ? when(updated.toISOString()) : "—" })}</span>
        {kept.state === "ok" && <button type="button" className="nt-btn" onClick={onAdopt} title={t("notes.kept.adoptHint")}>{t("notes.kept.adopt")}</button>}
      </div>
      {asks.map((ask) => (
        <div key={ask.id} className="nt-sug nt-sug-card" role="group" aria-label={t("notes.sug.label")}>
          <p className="nt-sug-fact">{ask.replace}</p>
          <p className="nt-sug-why">{ask.reason} · {t("notes.sug.remember")}</p>
          <div className="nt-sug-acts">
            <button type="button" className="nt-btn" onClick={() => onDecide(ask, false)}>{t("notes.sug.no")}</button>
            <button type="button" className="nt-btn nt-pri" onClick={() => onDecide(ask, true)}>{t("notes.sug.yes")}</button>
          </div>
        </div>
      ))}
      {!asks.length && !kept.sections.some((section) => section.lines.length) && <p className="nt-kept-empty">{t("notes.kept.empty")}</p>}
      <div className="nt-kept-body">
        {kept.sections.map((section, s) => (
          <section key={s}>
            {section.heading && <h2>{readable(section.heading)}</h2>}
            <ul>
              {section.lines.map((line) => (
                <li key={line.index} className="nt-kept-line">
                  <span className="nt-kept-text">{readable(line.text)}</span>
                  {line.refs.map((ref) => {
                    const source = kept.sources[ref - 1];
                    return source?.page
                      ? <button key={ref} type="button" className="nt-ref" onClick={() => onSource(source.page!, lineText(line.index))} aria-label={source.label} title={source.label}>{ref}</button>
                      : <span key={ref} className="nt-ref" title={source?.label}>{ref}</span>;
                  })}
                  {kept.state === "ok" && (
                    <button type="button" className="nt-kept-x" onClick={() => onReject(line.index, line.text)} aria-label={t("notes.kept.reject")} title={t("notes.kept.reject")}><Icon name="close" /></button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {kept.sources.length > 0 && (
        <div className="nt-sec nt-kept-sources">
          <h3>{t("notes.kept.sources")}</h3>
          <ol>
            {kept.sources.map((source, i) => (
              <li key={i}>
                <span className="nt-ref">{i + 1}</span>
                {source.page
                  ? <button type="button" className="nt-link-row" onClick={() => onSource(source.page!, "")}><PageGlyph name={null} /><span>{source.label}</span></button>
                  : <span className="nt-kept-word">{source.label}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
