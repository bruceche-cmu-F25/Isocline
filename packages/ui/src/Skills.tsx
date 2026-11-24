/** Settings → Skills: the instructions Isocline reads when a task calls for one (after pi-web's Settings › Skills, github.com/agegr/pi-web, MIT).
 *
 * A plain list: one line per skill, its name, what it is for, and a switch (off stays on disk, and Isocline is not told
 * about it). Ten are shown, and the rest open under them. A skill's name opens its instructions in a card over the page, where it can also be removed. Under the
 * list, one box adds more: what is typed narrows the skills other agents on this Mac already have (they are copied
 * in), and searching asks skills.sh. Only on the Mac Isocline runs on.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { FoundSkill, SkillContent, SkillInfo, SkillSearchResponse, SkillSearchResult, SkillsResponse, SkillUpdatesResponse } from "@isocline/protocol";
import { request as call } from "./api.ts";
import { intlLocale, t } from "./i18n/index.ts";
import { Markdown } from "./Markdown.tsx";

/** How many skills a list shows before "show all": Isocline's own, and the ones found on this Mac. */
const FEW = 10;

/** A card in the middle of the window, the page blurred behind it; Escape or a click beside it puts it away. */
function Pop({ onClose, children }: { onClose(): void; children: ReactNode }) {
  useEffect(() => {
    const escape = (press: KeyboardEvent) => { if (press.key === "Escape" && !press.isComposing) onClose(); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  });
  return createPortal(
    <div className="ev-pop" role="presentation" onMouseDown={(down) => { if (down.target === down.currentTarget) onClose(); }}>{children}</div>,
    document.body,
  );
}

function SkillCard({ skill, onClose, onRemove }: { skill: SkillInfo; onClose(): void; onRemove(): void }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    let alive = true;
    call<SkillContent>(`/api/skills/content?id=${encodeURIComponent(skill.id)}`).then((next) => { if (alive) setContent(next.content); }, (reason: Error) => { if (alive) setError(reason.message); });
    return () => { alive = false; };
  }, [skill.id]);
  return (
    <div className="ev-edit skill-card" role="dialog" aria-modal="true" aria-label={skill.name}>
      <div className="ev-card-head">
        <b>{skill.name}</b>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close")} autoFocus>×</button>
      </div>
      <p>{skill.description}</p>
      {skill.source && <p className="quiet"><a className="dev-link" href={skill.source.url} target="_blank" rel="noopener noreferrer">{skill.source.url.replace(/^https?:\/\//, "")} ↗</a></p>}
      {error && <p className="problem" role="alert">{error}</p>}
      {content === null && !error ? <p className="quiet">{t("skills.reading")}</p> : content !== null && <Markdown text={content} className="skill-text" />}
      <div className="ev-foot">
        <span>{asking && t("skills.remove.confirm", { name: skill.name })}</span>
        {asking && <button type="button" className="set-button ghost" onClick={() => setAsking(false)}>{t("common.cancel")}</button>}
        <button type="button" className="set-button ghost" onClick={() => (asking ? onRemove() : setAsking(true))}>{t("mcp.remove")}</button>
      </div>
    </div>
  );
}

export function Skills() {
  const [data, setData] = useState<SkillsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  /** One box: what is typed narrows the Mac's skills as it is typed, and is what skills.sh is asked for. */
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkillSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [updates, setUpdates] = useState<SkillUpdatesResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [all, setAll] = useState(false);
  const [allFound, setAllFound] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(() => call<SkillsResponse>("/api/skills").then((next) => { if (alive.current) setData(next); }, (reason: Error) => setError(reason.message)), []);
  useEffect(() => { void load(); }, [load]);

  const run = (key: string, action: () => Promise<unknown>) => {
    setError(null);
    setBusy(key);
    return action().then(() => load(), (reason: Error) => { setError(reason.message); void load(); }).finally(() => { if (alive.current) setBusy(null); });
  };
  const toggle = (skill: SkillInfo) => run(skill.id, () => call(`/api/skills/${skill.enabled ? "disable" : "enable"}`, { id: skill.id }));
  const remove = (skill: SkillInfo) => { setViewing(null); void run(skill.id, () => call("/api/skills/remove", { id: skill.id })); };
  const addFound = (found: FoundSkill) => run(found.path, () => call("/api/skills/add", { path: found.path }));
  const install = (result: SkillSearchResult) => run(result.package, async () => {
    await call("/api/skills/add", { package: result.package });
    setResults((current) => current?.map((item) => (item.package === result.package ? { ...item, added: true } : item)) ?? null);
  });
  const update = (skill: SkillInfo) => run(skill.id, async () => {
    await call("/api/skills/update", { id: skill.id });
    setUpdates((current) => current && { ...current, updates: current.updates.filter((id) => id !== skill.id) });
  });
  const search = (event: FormEvent) => {
    event.preventDefault();
    if (!query.trim() || searching) return;
    setError(null);
    setSearching(true);
    call<SkillSearchResponse>("/api/skills/search", { query: query.trim() })
      .then((next) => { if (alive.current) setResults(next.results); }, (reason: Error) => setError(reason.message))
      .finally(() => { if (alive.current) setSearching(false); });
  };
  const check = () => {
    setError(null);
    setChecking(true);
    call<SkillUpdatesResponse>("/api/skills/updates", {})
      .then((next) => { if (alive.current) setUpdates(next); }, (reason: Error) => setError(reason.message))
      .finally(() => { if (alive.current) setChecking(false); });
  };

  const skills = data?.skills ?? [];
  /** The first ten, and any past them that an update was found for (its button is the reason to look). */
  const shown = all ? skills : skills.filter((skill, at) => at < FEW || updates?.updates.includes(skill.id));
  const fromSite = skills.some((skill) => skill.source);
  const count = new Intl.NumberFormat(intlLocale(), { notation: "compact", maximumFractionDigits: 1 });
  const needle = query.trim().toLowerCase();
  const found = (data?.found ?? []).filter((skill) => !needle || skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle));
  const foundShown = allFound || needle ? found : found.slice(0, FEW);
  const viewed = skills.find((skill) => skill.id === viewing);
  const add = (key: string, added: boolean, onAdd: () => void) => (added
    ? <span className="skill-done">{t("skills.added")}</span>
    : <button type="button" className="skill-add" disabled={!!busy} onClick={onAdd}>{t(busy === key ? "skills.adding" : "mcp.add")}</button>);

  return (
    <section className="set-section">
      <h2>{t("settings.tab.skills")}</h2>
      <p className="quiet">{t("skills.sub")}</p>
      {error && <p className="problem small" role="alert">{error}</p>}
      {data?.problems.map((problem) => <p className="problem small" key={problem}>{problem}</p>)}

      {data && skills.length === 0 && <p className="quiet small skill-none">{t("skills.none")}</p>}
      {skills.length > 0 && (
        <ul className="skill-list">
          {shown.map((skill) => (
            <li className="skill-item" key={skill.id}>
              <button type="button" className="skill-words" onClick={() => setViewing(skill.id)}>
                <b>{skill.name}</b><span>{skill.description}</span>
              </button>
              {updates?.updates.includes(skill.id) && <button type="button" className="skill-add" disabled={!!busy} onClick={() => void update(skill)}>{t("skills.update")}</button>}
              <button type="button" className="set-switch" role="switch" aria-checked={skill.enabled} aria-label={t("mcp.use", { name: skill.name })} disabled={!!busy} onClick={() => void toggle(skill)} />
            </li>
          ))}
        </ul>
      )}
      {skills.length > FEW && <button type="button" className="skill-add skill-more" onClick={() => setAll(!all)}>{all ? t("skills.fewer") : t("skills.all", { n: skills.length })}</button>}
      {fromSite && (
        <p className="quiet small skill-foot">
          <button type="button" className="usage-refresh" disabled={checking} onClick={check}>{t(checking ? "skills.checking" : "skills.check")}</button>
          {updates && !checking && <span>{updates.updates.length ? t("skills.updates", { n: updates.updates.length }) : t("skills.upToDate")}{updates.failed.length ? ` · ${t("skills.checkFailed", { n: updates.failed.length })}` : ""}</span>}
        </p>
      )}

      <h3 className="set-sub">{t("skills.add")}</h3>
      <form className="set-actions skill-search" onSubmit={search}>
        <input className="model-input" type="search" value={query} placeholder={t("skills.find.placeholder")} aria-label={t("skills.find.placeholder")} autoComplete="off" spellCheck={false} maxLength={200}
          onChange={(event) => setQuery(event.target.value)} />
        <button type="submit" className="set-button ghost" disabled={!query.trim() || searching}>{t(searching ? "skills.searching" : "skills.search")}</button>
      </form>

      {results && (
        <>
          <h4 className="skill-group">skills.sh</h4>
          {results.length === 0 && <p className="quiet small skill-none">{t("skills.find.none")}</p>}
          <ul className="skill-list skill-results">
            {results.map((result) => (
              <li className="skill-item" key={result.package}>
                <a className="skill-words" href={result.url} target="_blank" rel="noopener noreferrer">
                  <b>{result.name}</b><span>{result.source}{result.installs > 0 && ` · ${t("skills.installs", { n: count.format(result.installs) })}`}</span>
                </a>
                {add(result.package, result.added, () => void install(result))}
              </li>
            ))}
          </ul>
        </>
      )}

      {(data?.found.length ?? 0) > 0 && (found.length > 0 || !results) && (
        <>
          <h4 className="skill-group">{t("skills.found", { n: found.length })}</h4>
          <ul className="skill-list skill-found">
            {foundShown.map((skill) => (
              <li className="skill-item" key={skill.path}>
                <span className="skill-words" title={skill.description}><b>{skill.name}</b><span>{skill.description}</span></span>
                {add(skill.path, false, () => void addFound(skill))}
              </li>
            ))}
          </ul>
          {!needle && found.length > FEW && <button type="button" className="skill-add skill-more" onClick={() => setAllFound(!allFound)}>{allFound ? t("skills.fewer") : t("skills.all", { n: found.length })}</button>}
        </>
      )}

      {viewed && <Pop onClose={() => setViewing(null)}><SkillCard skill={viewed} onClose={() => setViewing(null)} onRemove={() => remove(viewed)} /></Pop>}
    </section>
  );
}
