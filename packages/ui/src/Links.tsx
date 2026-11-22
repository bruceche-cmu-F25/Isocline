/** The Links page (docs/design/links.md): the places you keep going to, as a row of tiles, and what you saved from
 * the internet, as cards in one block per topic. A card says what the thing is called, where it is, why you saved
 * it and what it is filed under; opened, it shows what the page says of itself and what you can do with it.
 * L1: a saved page is looked up for its title; it is not read or summarised yet, and the card does not pretend so.
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import type { Area } from "@alfred/protocol";
import type { Clip, ClipState, LinksSnapshot, LinkType, Topic } from "@alfred/module-links/types";
import { classify, parseLinkPaste } from "@alfred/module-links/url";
import { clipSections, playbackTime } from "./clipSections.ts";
import { legacyShareClip, linkSaveFields } from "./linkShareCompat.ts";
import { AddBar, Pill } from "./AddBar.tsx";
import { SiteIcon, useLinkFile, useOp } from "./linkControls.tsx";
import { Places } from "./Places.tsx";
import { LinkDeleteDialog, onDeleteKey } from "./LinkDeleteDialog.tsx";
import { Icon } from "./shell/icons.tsx";
import { Select } from "./shell/Select.tsx";
import { OutLink } from "./Linked.tsx";
import { getLocale, t, type Key } from "./i18n/index.ts";
import { when } from "./shell/Nav.tsx";
import "./links-page.css";

/** How a platform is called; anything else goes by its site. */
const PLATFORM: Record<string, string | [string, string]> = {
  youtube: "YouTube", bilibili: ["B 站", "Bilibili"], xiaohongshu: ["小红书", "Xiaohongshu"], github: "GitHub", arxiv: "arXiv", wechat: ["公众号", "WeChat"],
  zhihu: ["知乎", "Zhihu"], x: "X", weibo: ["微博", "Weibo"], reddit: "Reddit", hackernews: "Hacker News", douyin: ["抖音", "TikTok"], vimeo: "Vimeo",
};
const platformName = (id: string): string | undefined => { const name = PLATFORM[id]; return Array.isArray(name) ? name[getLocale() === "en" ? 1 : 0] : name; };
const TYPES: LinkType[] = ["video", "article", "post", "repo", "doc"];
/** Why a page could not be looked up, in the user's words, by the home node's short code. */
const WHY: Record<string, Key> = { login: "links.why.login", status: "links.why.status", timeout: "links.why.timeout", network: "links.why.timeout", not_html: "links.why.notPage" };
const STATES: ClipState[] = ["unread", "seen", "todo"];

const GLYPH: Record<LinkType, ReactNode> = {
  video: <path d="M7 5.5v9l7.5-4.5z" fill="currentColor" stroke="none" />,
  article: <path d="M5 6h10M5 10h10M5 14h6" />,
  post: <><rect x="4.5" y="4.5" width="11" height="11" rx="2.5" /><path d="M7.5 12.5l2-2 1.5 1.5 1.5-2" /></>,
  repo: <path d="M7.5 6L4 10l3.5 4M12.5 6L16 10l-3.5 4" />,
  doc: <path d="M6 3.5h5.5L15 7v9.5H6zM11.5 3.5V7H15M8.5 11h4M8.5 13.5h4" />,
};

/** A topic chooser: the user's topics, none, or a new one named on the spot. */
function TopicPick({ topics, areas, value, disabled, label, onPick }: {
  topics: Topic[]; areas: Area[]; value: string; disabled?: boolean; label: string; onPick(choice: { topicId: string } | { topic: string }): void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  if (naming) {
    const done = () => { const next = name.trim(); setNaming(false); setName(""); if (next) onPick({ topic: next }); };
    return (
      <input className="lk-pick lk-new" autoFocus value={name} maxLength={60} placeholder={t("links.topic.name")} aria-label={t("links.topic.name")}
        onChange={(event) => setName(event.target.value)} onBlur={done}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); done(); } if (event.key === "Escape") { setNaming(false); setName(""); } }} />
    );
  }
  const areaName = (id: string | undefined) => areas.find((area) => area.id === id)?.name[getLocale()];
  return (
    <Select className="lk-pick" value={value} disabled={disabled} label={label}
      onChange={(next) => { if (next === NEW_TOPIC) setNaming(true); else onPick({ topicId: next }); }}
      options={topicChoices(topics, areaName)} />
  );
}

/** The menu's value for 「new topic」: no topic id has this shape. */
const NEW_TOPIC = "+";
function topicChoices(topics: Topic[], areaName: (id: string | undefined) => string | undefined) {
  return [
    { value: "", label: t("links.topic.none") },
    ...topics.map((topic) => ({ value: topic.id, label: areaName(topic.area) ? `${topic.name} · ${areaName(topic.area)}` : topic.name })),
    { value: NEW_TOPIC, label: t("links.topic.new") },
  ];
}

/** The topic a new link goes under, as a pill in the add bar: none, one of the user's, or a new one named there. */
function TopicPill({ topics, areas, pick, onPick }: {
  topics: Topic[]; areas: Area[]; pick: { topicId: string } | { topic: string }; onPick(choice: { topicId: string } | { topic: string }): void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  if (naming) {
    const done = () => { const next = name.trim(); setNaming(false); setName(""); if (next) onPick({ topic: next }); };
    return (
      <input className="add-new" autoFocus value={name} maxLength={60} placeholder={t("links.topic.name")} aria-label={t("links.topic.name")}
        onChange={(event) => setName(event.target.value)} onBlur={done}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); done(); } if (event.key === "Escape") { setNaming(false); setName(""); } }} />
    );
  }
  const chosen = "topicId" in pick ? topics.find((topic) => topic.id === pick.topicId) : undefined;
  const k = chosen ? areas.find((area) => area.id === chosen.area)?.k : "alfred";
  const text = "topic" in pick ? `${pick.topic} · ${t("links.topic.isNew")}` : chosen?.name ?? t("links.topic.none");
  const areaName = (id: string | undefined) => areas.find((area) => area.id === id)?.name[getLocale()];
  return (
    <Pill icon="tag" text={text} set={"topic" in pick || !!chosen} k={k} label={t("links.topic.pick")} onClear={() => onPick({ topicId: "" })}>
      <Select cover value={"topicId" in pick ? pick.topicId : ""} label={t("links.topic.pick")}
        onChange={(next) => { if (next === NEW_TOPIC) setNaming(true); else onPick({ topicId: next }); }}
        options={topicChoices(topics, areaName)} />
    </Pill>
  );
}

function cardTitle(clip: Clip) {
  if (clip.titleSource === "url") {
    if (clip.platform === "bilibili") return t(clip.type === "video" ? "links.untitled.bilibili" : "links.untitled.bilibiliPage");
    if (clip.platform === "xiaohongshu") return t("links.untitled.xiaohongshu");
  }
  return clip.title;
}

function Card({ clip, topics, areas, open, fresh, onOpen, onError }: {
  clip: Clip; topics: Topic[]; areas: Area[]; open: boolean; fresh: boolean; onOpen(): void; onError(message: string | null): void;
}) {
  const { busy, run } = useOp(onError);
  const [confirming, setConfirming] = useState(false);
  const [failedCover, setFailedCover] = useState<string>();
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const mainButton = useRef<HTMLButtonElement>(null);
  const coverUrl = useLinkFile(clip.cover);
  const topic = topics.find((candidate) => candidate.id === clip.topicId);
  const area = areas.find((candidate) => candidate.id === topic?.area);
  const untitled = clip.titleSource === "url";
  const title = cardTitle(clip);
  const looking = untitled && clip.fetch === "pending";
  // A Xiaohongshu note's cover is its own first picture, which stands upright.
  const tall = clip.platform === "xiaohongshu" && !!clip.cover && clip.cover !== failedCover;
  // Where it is: the platform when it is a known one, then who or which site, then when it was saved.
  const platform = platformName(clip.platform);
  const site = platform && (clip.site === classify(clip.url).host || clip.site.toLowerCase() === clip.platform) ? undefined : clip.site;
  const source = [platform, clip.author ?? site].filter(Boolean).join(" · ");
  const saved = when(clip.savedAt);
  const stateName = (state: ClipState) => clip.type === "video" && state === "unread" ? t("links.watchLater") : t(`links.state.${state}` as Key);
  const update = (patch: Record<string, unknown>) => run("link.update", { id: clip.id, patch });
  const editTitle = () => setTitleDraft(untitled ? "" : clip.title);
  const finishTitle = () => { setTitleDraft(null); mainButton.current?.focus(); };
  const saveTitle = () => {
    if (!titleDraft?.trim() || busy) return;
    void run("link.update", { id: clip.id, patch: { title: titleDraft.trim() } }, finishTitle);
  };
  return (
    <li className="lk-card" data-video={clip.type === "video" || undefined} data-cover={tall ? "tall" : undefined} data-open={open || undefined} data-fresh={fresh || undefined} data-k={area?.k ?? "gray"}>
      <button type="button" className="lk-main" ref={mainButton} onClick={() => { setTitleDraft(null); onOpen(); }} aria-expanded={open} aria-keyshortcuts="Delete Backspace"
        onKeyDown={(event) => onDeleteKey(event, () => !busy && setConfirming(true))}>
        <span className="lk-cover">
          {tall && <img className="lk-cover-blur" src={coverUrl} alt="" aria-hidden="true" loading="lazy" decoding="async" />}
          {clip.cover && clip.cover !== failedCover
            ? <img src={coverUrl} alt="" loading="lazy" decoding="async" onError={() => setFailedCover(clip.cover)} />
            : <svg viewBox="0 0 20 20" aria-hidden="true">{GLYPH[clip.type]}</svg>}
          {clip.durationSeconds && <span className="lk-runtime">{playbackTime(clip.durationSeconds)}</span>}
        </span>
        <span className="lk-text">
          <span className="lk-title" data-quiet={untitled || undefined}>{title}</span>
          <span className="lk-where">
            {clip.icon && <SiteIcon icon={clip.icon} fallback={null} />}
            <span className="lk-source" title={source}>
              {platform && clip.author ? <><span className="lk-platform">{platform} · </span>{clip.author}</> : source}
            </span>
            <span className="lk-saved-at"> · {saved}</span>
          </span>
          {clip.note && <span className="lk-note">{clip.note}</span>}
          <span className="lk-foot">
            {topic && <span className="tag">{topic.name}</span>}
            <span className="lk-state" data-s={clip.state}><i />{stateName(clip.state)}</span>
            {looking && <span className="lk-looking"><span className="pulse" />{t("links.looking")}</span>}
            {clip.byAlfred && <span className="by">{t("links.byAlfred")}</span>}
          </span>
        </span>
      </button>
      {!open && <button type="button" className="lk-card-delete" disabled={busy} aria-label={t("links.deleteNamed", { title })}
        title={t("links.remove")} onClick={() => setConfirming(true)}><Icon name="trash" /></button>}
      {open && (
        <div className="lk-more">
          {clip.description && <p className="lk-desc"><span>{t("links.pageSays")}</span>{clip.description}</p>}
          {untitled && !looking && (
            <div className="lk-hint">
              <span>{t(clip.fetch === "failed" ? WHY[clip.fetchError ?? ""] ?? "links.why.other" : "links.noTitle")}</span>
              <button type="button" className="lk-btn quiet" disabled={busy} onClick={() => run("link.refetch", { id: clip.id })}>{t("links.retry")}</button>
            </div>
          )}
          {titleDraft !== null && (
            <form className="lk-title-form" onSubmit={(event) => { event.preventDefault(); saveTitle(); }}>
              <label>{t("links.title.label")}
                <input autoFocus maxLength={300} value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); finishTitle(); } }} />
              </label>
              <button type="submit" className="lk-btn solid" disabled={busy || !titleDraft.trim()}>{t("links.title.save")}</button>
              <button type="button" className="lk-btn quiet" disabled={busy} onClick={finishTitle}>{t("common.cancel")}</button>
            </form>
          )}
          <div className="lk-acts">
            <OutLink className="lk-btn solid" href={clip.url}>{t("links.open")} ↗</OutLink>
            {STATES.map((state) => (
              <button type="button" key={state} className="lk-btn" aria-pressed={clip.state === state} disabled={busy} onClick={() => update({ state })}>{stateName(state)}</button>
            ))}
            <TopicPick topics={topics} areas={areas} value={clip.topicId ?? ""} disabled={busy} label={t("links.topic.of", { title })} onPick={update} />
            {titleDraft === null && <button type="button" className="lk-btn quiet" disabled={busy} onClick={editTitle}>{t(untitled ? "links.title.add" : "links.title.edit")}</button>}
            {!untitled && clip.fetch === "failed" && <button type="button" className="lk-btn quiet" disabled={busy} onClick={() => run("link.refetch", { id: clip.id })}>{t("links.preview.retry")}</button>}
            <span className="grow" />
            <button type="button" className="lk-btn quiet" disabled={busy} onClick={() => setConfirming(true)}>{t("links.remove")}</button>
          </div>
        </div>
      )}
      {confirming && <LinkDeleteDialog title={title} onCancel={() => setConfirming(false)}
        onDelete={() => { setConfirming(false); void run("link.remove", { id: clip.id }); }} />}
    </li>
  );
}

export function Links({ snapshot, fresh, areas, focus, onFocused, libraryControls }: { libraryControls?: ReactNode; snapshot: LinksSnapshot | undefined; fresh: ReadonlySet<string>; areas: Area[]; focus?: string | null; onFocused?(): void }) {
  const { places = [], folders = [], clips = [], topics = [] } = snapshot ?? {};
  const [draft, setDraft] = useState("");
  const [pick, setPick] = useState<{ topicId: string } | { topic: string }>({ topicId: "" });
  const [type, setType] = useState<LinkType | "all">("all");
  const [expandedShelf, setExpandedShelf] = useState(false);
  const [only, setOnly] = useState<ClipState | "all">("all");
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useOp(setError);

  // Preview the same platform title and personal note that the home node will save.
  const found = useMemo(() => parseLinkPaste(draft), [draft]);
  const kind = found ? classify(found.url) : null;
  const save = () => {
    if (!found || busy) return;
    void run("link.save", { ...linkSaveFields(draft, found, snapshot?.sharedTitles), ...("topic" in pick ? { topic: pick.topic } : pick.topicId ? { topicId: pick.topicId } : {}) },
      () => { setDraft(""); setPick({ topicId: "" }); });
  };

  const { recent, filed, shelf } = clipSections(clips, type, only, Date.now());
  // Topics of one area sit together; a topic with a single clip joins the loose ends, so no block holds one card.
  const order = (topic: Topic) => { const index = areas.findIndex((area) => area.id === topic.area); return index < 0 ? areas.length : index; };
  const blocks = [...topics].sort((a, b) => order(a) - order(b)).map((topic) => ({ topic, items: filed.filter((clip) => clip.topicId === topic.id) })).filter((block) => block.items.length >= 2);
  const inBlocks = new Set(blocks.flatMap((block) => block.items.map((clip) => clip.id)));
  const loose = filed.filter((clip) => !inBlocks.has(clip.id));
  // A selected filter stays available until cleared, even when its last matching clip changes or is removed.
  const types = TYPES.filter((candidate) => candidate === type || clips.some((clip) => clip.type === candidate));
  const showTypes = types.length > 1 || type !== "all";
  const card = (clip: Clip) => (
    <Card key={clip.id} clip={snapshot?.sharedTitles ? clip : legacyShareClip(clip)} topics={topics} areas={areas} open={open === clip.id} fresh={fresh.has(`link:${clip.id}`)}
      onOpen={() => setOpen(open === clip.id ? null : clip.id)} onError={setError} />
  );

  return (
    <section className="links" aria-label={t("page.links")}>
      {/* One scroll for the whole page: on a small screen nothing is pinned above the cards. */}
      <div className="lk-scroll">
      {libraryControls}
      <Places places={places} folders={folders} focus={focus} onFocused={onFocused} onError={setError} />

      <div className="lk-save">
        <AddBar value={draft} onChange={setDraft} onSubmit={save} ready={!!found} busy={busy} maxLength={2400} spellCheck={false}
          placeholder={t("links.paste")} label={t("links.paste")} submitLabel={t("links.save")}>
          <TopicPill topics={topics} areas={areas} pick={pick} onPick={setPick} />
        </AddBar>
      </div>
      {found && kind && (
        <p className="lk-will">
          <span className="tag" data-k="gray">{t(`links.type.${kind.type}` as Key)}</span>
          <span>{platformName(kind.platform) ?? kind.host}</span>
          {found.title && <span className="lk-share-title">{found.title}</span>}
          {found.note && <span className="lk-note">{found.note}</span>}
          {"topic" in pick && <span className="tag" data-k="alfred">{pick.topic} · {t("links.topic.isNew")}</span>}
        </p>
      )}
      {draft.trim() && !found && <p className="lk-will quiet">{t("links.noUrl")}</p>}
      {error && <p className="problem small" role="alert">{error}</p>}

        {clips.length > 0 && (showTypes || only !== "all" || clips.some((clip) => clip.state !== "unread")) && (
          <div className="lk-filters" role="group" aria-label={t("links.filter")}>
            {showTypes && (["all", ...types] as const).map((candidate) => (
              <button type="button" key={candidate} className="chip" aria-pressed={type === candidate} onClick={() => setType(candidate)}>
                {candidate === "all" ? t("common.all") : t(`links.type.${candidate}` as Key)}
                <span className="count">{candidate === "all" ? clips.length : clips.filter((clip) => clip.type === candidate).length}</span>
              </button>
            ))}
            {showTypes && <span className="lk-sep" />}
            {(["unread", "todo"] as const).map((state) => (
              <button type="button" key={state} className="chip" aria-pressed={only === state} onClick={() => setOnly(only === state ? "all" : state)}>{t(`links.state.${state}` as Key)}</button>
            ))}
          </div>
        )}
        {recent.length > 0 && (
          <section className="lk-band">
            <h3>{t("links.recent")}<span className="count">{recent.length}</span></h3>
            <ul className="lk-cards">{recent.map(card)}</ul>
          </section>
        )}
        {shelf.length > 0 && (
          <section className="lk-band">
            <h3>{t("links.watchLater")}<span className="count">{shelf.length}</span>
              {shelf.length > 3 && <button type="button" className="lk-edit lk-shelf-toggle" aria-expanded={expandedShelf}
                onClick={() => setExpandedShelf(!expandedShelf)}>{t(expandedShelf ? "links.shelf.less" : "links.shelf.all")}<Icon name="down" /></button>}
            </h3>
            <ul className="lk-cards lk-shelf">{(expandedShelf ? shelf : shelf.slice(0, 3)).map(card)}</ul>
          </section>
        )}
        {clips.length === 0 && <p className="quiet empty-list">{t("links.empty")}</p>}
        {clips.length > 0 && filed.length === 0 && recent.length === 0 && shelf.length === 0 && <p className="quiet empty-list">{t("links.emptyFilter")}</p>}
        {blocks.map(({ topic, items }) => {
          const area = areas.find((candidate) => candidate.id === topic.area);
          return (
            <section className="lk-band lk-topic" key={topic.id} data-k={area?.k ?? "gray"}>
              <h3><span className="mark" />{topic.name}{area && <span className="lk-area">{area.name[getLocale()]}</span>}<span className="count">{items.length}</span></h3>
              <ul className="lk-cards">{items.map(card)}</ul>
            </section>
          );
        })}
        {loose.length > 0 && (
          <section className="lk-band lk-topic" data-k="gray">
            {blocks.length > 0 && <h3><span className="mark" />{t("links.loose")}<span className="count">{loose.length}</span></h3>}
            <ul className="lk-cards">{loose.map(card)}</ul>
          </section>
        )}
      </div>
    </section>
  );
}
