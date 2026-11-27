/** The Links page (docs/design/links.md): the places you keep going to, as a row of tiles, and everything kept in a
 * tree of categories beside it (§4.10): a list or cards per category, one search for categories and links, and
 * bookmarks brought in from a browser. A card says what the thing is called, where it is, why you saved
 * it and what it is filed under; opened, it shows what the page says of itself and what you can do with it.
 * L1: a saved page is looked up for its title; it is not read or summarised yet, and the card does not pretend so.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Area } from "@zirma/protocol";
import type { Clip, ClipState, LinksSnapshot, LinkType, Topic } from "@zirma/module-links/types";
import { classify, parseLinkPaste } from "@zirma/module-links/url";
import { topicChain, topicTree } from "@zirma/module-links/tree";
import { byNewest, counts, inNode, isRecent, itemsOf, linkTree, nodePath, nodeTopics, readViews, searchItems, searchTopics, searchWords, writeViews, type Item, type ItemType, type View } from "./linkTree.ts";
import { Menu, TreeNav } from "./LinksTree.tsx";
import { Mark, PlaceCard, Row, Tile, sourceOf } from "./LinkRows.tsx";
import { ImportBookmarks } from "./LinkImport.tsx";
import { Pop } from "./shell/Pop.tsx";
import { clipSections, playbackTime } from "./clipSections.ts";
import { legacyShareClip, linkSaveFields } from "./linkShareCompat.ts";
import { Pill } from "./AddBar.tsx";
import { SiteIcon, linkFileUrl, useOp } from "./linkControls.tsx";
import { Places } from "./Places.tsx";
import { LinkDeleteDialog, onDeleteKey } from "./LinkDeleteDialog.tsx";
import { Icon } from "./shell/icons.tsx";
import { Select } from "./shell/Select.tsx";
import { OutLink } from "./Linked.tsx";
import { getLocale, t, type Key, type Locale } from "./i18n/index.ts";
import { when } from "./shell/Nav.tsx";
import "./links-page.css";
import "./links-tree.css";

/** How a platform is called; anything else goes by its site. */
const PLATFORM: Record<string, string | Record<Locale, string>> = {
  youtube: "YouTube", bilibili: { zh: "B 站", en: "Bilibili" }, xiaohongshu: { zh: "小红书", en: "Xiaohongshu" }, github: "GitHub", arxiv: "arXiv", wechat: { zh: "公众号", en: "WeChat" },
  zhihu: { zh: "知乎", en: "Zhihu" }, x: "X", weibo: { zh: "微博", en: "Weibo" }, reddit: "Reddit", hackernews: "Hacker News", douyin: { zh: "抖音", en: "TikTok" }, vimeo: "Vimeo",
};
const platformName = (id: string): string | undefined => { const name = PLATFORM[id]; return typeof name === "object" ? name[getLocale()] : name; };
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
  const areaName = (id: string | undefined) => areas.find((area) => area.id === id)?.name;
  return (
    <Select className="lk-pick" value={value} disabled={disabled} label={label}
      onChange={(next) => { if (next === NEW_TOPIC) setNaming(true); else onPick({ topicId: next }); }}
      options={topicChoices(topics, areaName)} />
  );
}

/** The menu's value for 「new topic」: no topic id has this shape. */
const NEW_TOPIC = "+";
function topicChoices(topics: Topic[], areaName: (id: string | undefined) => string | undefined) {
  const tree = topicTree(topics);
  const path = (topic: Topic) => {
    const chain = topicChain(tree, topic.id);
    return [areaName(chain[0]?.area), ...chain.map((step) => step.name)].filter(Boolean).join(" › ");
  };
  return [
    { value: "", label: t("links.topic.none") },
    ...topics.map((topic) => ({ value: topic.id, label: path(topic) })).sort((a, b) => a.label.localeCompare(b.label)),
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
  const areaName = (id: string | undefined) => areas.find((area) => area.id === id)?.name;
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
  const coverUrl = linkFileUrl(clip.cover);
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
            {clip.byZirma && <span className="by">{t("links.byZirma")}</span>}
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

const NODE_KEY = "zirma.links.node";
const OPEN_KEY = "zirma.links.open";
const stored = <T,>(key: string, fallback: T): T => { try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };
const store = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not remembered */ } };
/** Below this width the tree folds into the page: areas first, then category after category, tapped into. */
const NARROW = 720;

/** `side`: the app sidebar's slot while it has room (PageDef.side). The category tree goes there, as Notes' page tree
 * does (links.md §4.10.8); without it the tree stays inside the page. */
export function Links({ snapshot, fresh, areas, focus, onFocused, side }: { snapshot: LinksSnapshot | undefined; fresh: ReadonlySet<string>; areas: Area[]; focus?: string | null; onFocused?(): void; side?: HTMLElement | null }) {
  const { places = [], folders = [], clips: rawClips = [], topics = [] } = snapshot ?? {};
  const clips = useMemo(() => snapshot?.sharedTitles ? rawClips : rawClips.map(legacyShareClip), [rawClips, snapshot?.sharedTitles]);
  const [draft, setDraft] = useState("");
  const [pick, setPick] = useState<{ topicId: string } | { topic: string }>({ topicId: "" });
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useOp(setError);

  const tree = useMemo(() => linkTree(topics, areas.map((area) => area.id)), [topics, areas]);
  const items = useMemo(() => itemsOf(places, clips), [places, clips]);
  const [nodeRaw, setNodeRaw] = useState<string>(() => stored(NODE_KEY, "all"));
  // A category that is gone (removed, merged, or on another device) falls back to everything.
  const node = nodeRaw === "all" || nodeRaw === "recent" || nodeRaw === "none" || (nodeRaw.startsWith("area:") ? tree.roots.includes(nodeRaw) : tree.byId.has(nodeRaw)) ? nodeRaw : "all";
  const [open, setOpen] = useState<Set<string>>(() => new Set(stored<string[]>(OPEN_KEY, [])));
  const [scopeAll, setScopeAll] = useState(false);
  const [views, setViews] = useState(readViews);
  const [type, setType] = useState<ItemType | "all">("all");
  const [only, setOnly] = useState<"all" | "unread" | "todo">("all");
  const [opened, setOpened] = useState<string | null>(null);
  const [expandedShelf, setExpandedShelf] = useState(false);
  const [importing, setImporting] = useState(false);
  const [menu, setMenu] = useState(false);
  const [treeHidden, setTreeHidden] = useState(() => stored("zirma.links.treeHidden", false));
  const [said, setSaid] = useState<{ text: string; undo?: () => void } | null>(null);
  const [narrow, setNarrow] = useState(false);
  const page = useRef<HTMLElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const element = page.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < NARROW));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!said) return;
    const timer = setTimeout(() => setSaid(null), 6000);
    return () => clearTimeout(timer);
  }, [said]);
  useEffect(() => {
    const find = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f" && page.current?.offsetParent) { event.preventDefault(); field.current?.focus(); field.current?.select(); }
    };
    document.addEventListener("keydown", find);
    return () => document.removeEventListener("keydown", find);
  }, []);

  const go = (next: string) => {
    setNodeRaw(next); store(NODE_KEY, next);
    setType("all"); setOnly("all"); setScopeAll(false);
    // Opening a node shows where it is in the tree.
    const chain = next.startsWith("area:") || !tree.byId.has(next) ? [] : topicChain(tree, next);
    const nextOpen = new Set(open);
    if (chain.length) nextOpen.add(tree.roots.includes(`area:${chain[0].area ?? ""}`) ? `area:${chain[0].area ?? ""}` : "area:");
    for (const topic of chain) nextOpen.add(topic.id);
    if (next.startsWith("area:")) nextOpen.add(next);
    if (nextOpen.size !== open.size) { setOpen(nextOpen); store(OPEN_KEY, [...nextOpen]); }
    page.current?.querySelector(".lk-col")?.scrollTo({ top: 0 });
  };
  const toggle = (key: string) => { const next = new Set(open); if (next.has(key)) next.delete(key); else next.add(key); setOpen(next); store(OPEN_KEY, [...next]); };
  const view: View = views[node] ?? "list";
  const setView = (next: View) => { const all = { ...views, [node]: next }; setViews(all); writeViews(all); };

  // One field on top: words search what is kept; an address offers to keep it (in the open category unless another is
  // chosen). A bare host ("roadmap.sh") does both.
  const found = useMemo(() => parseLinkPaste(draft), [draft]);
  const kind = found ? classify(found.url) : null;
  const query = found && /https?:\/\//i.test(draft) ? "" : draft;
  const save = () => {
    if (!found || busy) return;
    const where = "topic" in pick ? { topic: pick.topic } : pick.topicId ? { topicId: pick.topicId } : tree.byId.has(node) ? { topicId: node } : {};
    void run("link.save", { ...linkSaveFields(draft, found, snapshot?.sharedTitles), ...where }, () => { setDraft(""); setPick({ topicId: "" }); });
  };

  const areaById = (id: string | undefined) => areas.find((area) => area.id === id);
  const areaName = (key: string) => key === "area:" || key === "" ? t("links.tree.noArea") : areaById(key.replace(/^area:/, ""))?.name ?? "";
  const kOfRoot = (root: string) => root === "area:" ? "gray" : areaById(root.slice(5))?.k ?? "gray";
  const kOf = (topicId: string | undefined) => { const chain = topicChain(tree, topicId); return chain.length ? areaById(chain[0].area)?.k ?? "gray" : "gray"; };
  const pathText = (topicId: string | undefined) => topicId && tree.byId.has(topicId) ? nodePath(tree, topicId, (id) => areaName(id)).join(" › ") : "";
  const itemPath = (item: Item) => pathText(item.topicId);

  const words = searchWords(query);
  const searching = words.length > 0;
  const scoped = searching && !scopeAll && node !== "all" && node !== "recent";
  const matches = useMemo(() => searching ? searchItems(items, words, itemPath) : items, [items, query, tree]); // eslint-disable-line react-hooks/exhaustive-deps
  const treeCounts = useMemo(() => counts(tree, matches), [tree, matches]);
  treeCounts.set("all", matches.length);
  treeCounts.set("recent", clips.filter((clip) => isRecent(clip)).length);
  const countsAll = useMemo(() => counts(tree, items), [tree, items]);

  const fileTo = (id: string, topicId: string) => {
    const item = items.find((candidate) => candidate.id === id);
    if (!item || (item.topicId ?? "") === topicId) return;
    const before = item.topicId ?? "";
    const send = (to: string) => item.kind === "clip" ? run("link.update", { id, patch: { topicId: to } }) : run("link.place", { id, topicId: to });
    void send(topicId).then(() => setSaid({ text: t("links.tree.moved", { title: item.title, to: pathText(topicId) || t("links.tree.none") }), undo: () => void send(before) }));
  };

  const filtered = (list: Item[]) => list.filter((item) => (type === "all" || item.type === type) && (only === "all" || (item.kind === "clip" && item.clip.state === only)));
  /** A run of items, as rows or as cards. `path`: each says where it is filed (search, and the newest). */
  const draw = (list: Item[], options: { path?: boolean; as?: View } = {}) => {
    if (!list.length) return null;
    const sub = (item: Item) => options.path ? [itemPath(item) || t("links.tree.none"), sourceOf(item, platformName)].filter(Boolean).join(" · ") : undefined;
    const common = (item: Item) => ({ item, k: kOf(item.topicId), fresh: fresh.has(`link:${item.id}`), platformName, onOpen: () => setOpened(item.id), sub: sub(item) });
    if ((options.as ?? view) === "list") return <ul className="lr-rows">{list.map((item) => <Row key={item.id} {...common(item)} />)}</ul>;
    // Cards with a cover go together first: next to them a card without one would stretch to their height.
    const covered = list.filter((item) => item.kind === "clip" && !!item.clip.cover);
    const plain = list.filter((item) => !(item.kind === "clip" && item.clip.cover));
    return <>
      {covered.length > 0 && <ul className="lg-tiles lg-covered">{covered.map((item) => <Tile key={item.id} {...common(item)} />)}</ul>}
      {plain.length > 0 && <ul className="lg-tiles">{plain.map((item) => <Tile key={item.id} {...common(item)} />)}</ul>}
    </>;
  };
  /** A category as a card: its name and count, what is under it, and a few of its sites' icons. */
  const categoryCard = (key: string, name: string, k: string) => {
    const inside = inNode(tree, key, items).sort(byNewest);
    const icons: Item[] = [];
    for (const item of inside) {
      if (icons.length >= 5) break;
      if (!icons.some((other) => sourceHost(other.url) === sourceHost(item.url))) icons.push(item);
    }
    const kids = key === "none" ? [] : (tree.children.get(key) ?? []).map((kid) => kid.name);
    return (
      <li key={key} className="lc-card" data-k={k}>
        <button type="button" onClick={() => go(key)}>
          <span className="lc-head"><span className="lc-name">{name}</span><span className="lc-n">{searching ? treeCounts.get(key) ?? 0 : inside.length}</span></span>
          {kids.length > 0 && <span className="lc-sub">{kids.join(" · ")}</span>}
          <span className="lc-icons">{icons.map((item) => <SiteIcon key={item.id} icon={item.kind === "place" ? item.place.icon : item.clip.icon} fallback={<Mark url={item.url} title={item.title} />} />)}</span>
        </button>
      </li>
    );
  };
  const filters = (list: Item[]) => {
    const kinds = (["site", ...TYPES] as ItemType[]).filter((candidate) => candidate === type || list.some((item) => item.type === candidate));
    const states = (["unread", "todo"] as const).filter((state) => state === only || list.some((item) => item.kind === "clip" && item.clip.state === state));
    if (list.length < 6 && type === "all" && only === "all") return null;
    return (
      <div className="lk-filters" role="group" aria-label={t("links.filter")}>
        {kinds.length > 1 && kinds.map((candidate) => (
          <button type="button" key={candidate} className="chip" aria-pressed={type === candidate} onClick={() => setType(type === candidate ? "all" : candidate)}>
            {t(candidate === "site" ? "links.type.site" : `links.type.${candidate}` as Key)}<span className="count">{list.filter((item) => item.type === candidate).length}</span>
          </button>
        ))}
        {kinds.length > 1 && states.length > 0 && <span className="lk-sep" />}
        {states.map((state) => (
          <button type="button" key={state} className="chip" aria-pressed={only === state} onClick={() => setOnly(only === state ? "all" : state)}>{t(`links.state.${state}` as Key)}</button>
        ))}
      </div>
    );
  };
  /** An area's categories as cards, under a quiet label. */
  const areaCards = (root: string) => {
    const tops = (tree.children.get(root) ?? []).filter((topic) => countsAll.get(topic.id));
    if (!tops.length) return null;
    return (
      <section key={root} className="lk-group" data-k={kOfRoot(root)}>
        <h3 className="lk-label"><span className="mark" /><button type="button" onClick={() => go(root)}>{areaName(root)}</button><span className="count">{countsAll.get(root)}</span></h3>
        <ul className="lc-grid">{tops.map((topic) => categoryCard(topic.id, topic.name, kOfRoot(root)))}</ul>
      </section>
    );
  };

  /** Everything at a glance: the newest, then every category as a card, area by area. */
  const overview = () => {
    if (!items.length) return <p className="quiet empty-list">{t("links.empty")}</p>;
    const newest = itemsOf([], clips.filter((clip) => isRecent(clip)).slice(0, 5));
    const { shelf } = clipSections(clips, "all", "all", Date.now());
    const loose = countsAll.get("none") ?? 0;
    return <>
      {newest.length > 0 && <section className="lk-group"><h3 className="lk-label">{t("links.recent")}<span className="count">{newest.length}</span></h3>{draw(newest, { path: true })}</section>}
      {view === "grid" && shelf.length > 1 && (
        <section className="lk-group">
          <h3 className="lk-label">{t("links.watchLater")}<span className="count">{shelf.length}</span>
            {shelf.length > 4 && <button type="button" className="lk-see" aria-expanded={expandedShelf} onClick={() => setExpandedShelf(!expandedShelf)}>{t(expandedShelf ? "links.shelf.less" : "links.shelf.all")}</button>}
          </h3>
          {draw(itemsOf([], expandedShelf ? shelf : shelf.slice(0, 4)), { as: "grid" })}
        </section>
      )}
      {tree.roots.map(areaCards)}
      {loose > 0 && <section className="lk-group" data-k="gray"><ul className="lc-grid">{categoryCard("none", t("links.tree.none"), "gray")}</ul></section>}
    </>;
  };

  /** One node: an area shows its categories as cards; a category shows what is in it, then each category under it. */
  const nodeView = () => {
    if (node === "recent" || node === "none") {
      const list = filtered(inNode(tree, node, items).sort(byNewest));
      return <>{filters(inNode(tree, node, items))}{draw(list, { path: node === "recent" }) ?? <p className="quiet empty-list">{t("links.emptyFilter")}</p>}</>;
    }
    if (node.startsWith("area:")) return areaCards(node) ?? <p className="quiet empty-list">{t("links.tree.emptyHint")}</p>;
    const all = inNode(tree, node, items);
    const direct = filtered(all.filter((item) => item.topicId === node).sort(byNewest));
    const kids = tree.children.get(node) ?? [];
    return <>
      {filters(all)}
      {drill && kids.length > 0 && <ul className="lc-grid">{kids.map((kid) => categoryCard(kid.id, kid.name, kOf(kid.id)))}</ul>}
      {direct.length > 0 && <section className="lk-group">{draw(direct)}</section>}
      {!drill && kids.map((kid) => {
        const inside = filtered(inNode(tree, kid.id, items).sort(byNewest));
        if (!inside.length && (type !== "all" || only !== "all")) return null;
        return (
          <section key={kid.id} className="lk-group lk-sub" data-k={kOf(kid.id)}>
            <h3 className="lk-subhead"><button type="button" onClick={() => go(kid.id)}>{kid.name}</button><span className="count">{inside.length}</span></h3>
            {draw(inside) ?? <p className="quiet lk-hollow">{t("links.tree.emptyHint")}</p>}
          </section>
        );
      })}
      {!all.length && !kids.length && <p className="quiet empty-list">{t("links.tree.emptyHint")}</p>}
    </>;
  };

  const results = () => {
    const within = scoped ? (node === "none" ? undefined : nodeTopics(tree, node)) : undefined;
    const pool = scoped ? (node === "none" ? inNode(tree, "none", matches) : matches.filter((item) => !!item.topicId && within!.has(item.topicId))) : matches;
    const cats = searchTopics(tree, words, (id) => pathText(id), scoped ? within : undefined).slice(0, 6);
    return <>
      {cats.length > 0 && <section className="lk-group"><h3 className="lk-label">{t("links.search.categories")}</h3>
        <ul className="lc-grid">{cats.map((topic) => categoryCard(topic.id, pathText(topic.id), kOf(topic.id)))}</ul></section>}
      <section className="lk-group"><h3 className="lk-label">{t("links.search.links")}<span className="count">{pool.length}</span></h3>
        {draw(filtered(pool).slice(0, 200), { path: true }) ?? <p className="quiet empty-list">{scoped
          ? <>{t("links.search.noneHere")} <button type="button" className="lk-see" onClick={() => setScopeAll(true)}>{t("links.search.everywhere")}</button></>
          : t("links.search.none")}</p>}
      </section>
    </>;
  };

  const crumbs = node === "all" ? [t("links.tree.all")] : node === "recent" ? [t("links.recent")] : node === "none" ? [t("links.tree.none")] : nodePath(tree, node, (id) => areaName(id));
  const crumbNodes = node.startsWith("area:") || !tree.byId.has(node) ? [node] : [`area:${topicChain(tree, node)[0]?.area ?? ""}`, ...topicChain(tree, node).map((topic) => topic.id)];
  const back = node === "all" ? null : crumbNodes.length > 1 ? crumbNodes[crumbNodes.length - 2] : "all";
  const openedItem = items.find((item) => item.id === opened);
  const showTree = !side && !narrow && !treeHidden;
  // With the tree in the sidebar a narrow page needs no tapping in: it lays out as a wide one does.
  const drill = narrow && !side;
  const treeNav = (inApp: boolean) => <TreeNav tree={tree} areas={areas} counts={treeCounts} node={node} open={open} searching={searching} inApp={inApp}
    onPick={go} onToggle={toggle} onDropLink={fileTo} onError={setError} onSaid={(text) => setSaid({ text })} />;

  return (
    <section className="links" ref={page} aria-label={t("page.links")} data-narrow={narrow || undefined} data-tree={showTree || undefined}>
      <div className="lk-scroll">
        <div className="lk-save">
          <form className="add-bar lk-field" role="search" onSubmit={(event) => { event.preventDefault(); save(); }}>
            <Icon name={found ? "link" : "search"} />
            {scoped && <span className="lk-scope">{t("links.search.in", { name: node === "none" ? t("links.tree.none") : crumbs[crumbs.length - 1] })}
              <button type="button" aria-label={t("links.search.everywhere")} onClick={() => setScopeAll(true)}><Icon name="close" /></button></span>}
            <input ref={field} className="add-text" value={draft} maxLength={2400} spellCheck={false} placeholder={t("links.field")} aria-label={t("links.field")}
              onChange={(event) => { setDraft(event.target.value); if (!event.target.value) setScopeAll(false); }}
              onKeyDown={(event) => { if (event.key === "Escape" && draft) { event.preventDefault(); setDraft(""); setScopeAll(false); } }} />
            {found && <span className="add-pills"><TopicPill topics={topics} areas={areas} pick={"topic" in pick || pick.topicId || !tree.byId.has(node) ? pick : { topicId: node }} onPick={setPick} /></span>}
            {found && <button type="submit" className="add-go" disabled={busy}>{t("links.save")}</button>}
          </form>
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
        {error && <p className="problem small" role="alert">{error}</p>}
        {!searching && <Places places={places.filter((place) => !place.unpinned)} folders={folders} focus={focus} onFocused={onFocused} onError={setError} />}

        <div className="lk-body">
          {showTree && treeNav(false)}
          <div className="lk-col">
            <div className="lk-head">
              {drill && back && !searching && <button type="button" className="lk-back" onClick={() => go(back)} aria-label={t("links.back")}><Icon name="back" /></button>}
              <h2 className="lk-crumbs">
                {searching ? <span>{t("links.search.title")}</span> : drill ? <span>{crumbs[crumbs.length - 1]}</span> : crumbs.map((name, index) => index < crumbs.length - 1 && crumbNodes[index]
                  ? <span key={index}><button type="button" onClick={() => go(crumbNodes[index])}>{name}</button><span className="sep">›</span></span>
                  : <span key={index}>{name}</span>)}
                {!searching && <span className="count">{node === "all" ? items.length : node === "recent" ? treeCounts.get("recent") : inNode(tree, node, items).length}</span>}
              </h2>
              <div className="lk-views" role="group" aria-label={t("links.view.label")}>
                <button type="button" aria-pressed={view === "list"} aria-label={t("links.view.list")} title={t("links.view.list")} onClick={() => setView("list")}><Icon name="list" /></button>
                <button type="button" aria-pressed={view === "grid"} aria-label={t("links.view.grid")} title={t("links.view.grid")} onClick={() => setView("grid")}><Icon name="grid" /></button>
              </div>
              <span className="lk-more-wrap">
                <button type="button" className="lk-icon-btn" aria-label={t("links.more")} title={t("links.more")} aria-expanded={menu} onClick={() => setMenu(!menu)}><Icon name="more" /></button>
                {menu && <Menu onClose={() => setMenu(false)}>
                  <button type="button" role="menuitem" onClick={() => { setMenu(false); setImporting(true); }}>{t("links.import.title")}…</button>
                  {!narrow && !side && <button type="button" role="menuitem" onClick={() => { setMenu(false); setTreeHidden(showTree); store("zirma.links.treeHidden", showTree); }}>{t(showTree ? "links.tree.hide" : "links.tree.show")}</button>}
                </Menu>}
              </span>
            </div>
            {searching ? results() : node === "all" ? overview() : nodeView()}
          </div>
        </div>
      </div>

      {side && createPortal(treeNav(true), side)}
      {openedItem?.kind === "place" && <PlaceCard place={openedItem.place} tree={tree} areas={areas} pathText={pathText} onClose={() => setOpened(null)} onError={setError} />}
      {openedItem?.kind === "clip" && (
        <Pop onClose={() => setOpened(null)}>
          <ul className="lk-cards lk-popcard" role="dialog" aria-label={openedItem.title}>
            <Card clip={openedItem.clip} topics={topics} areas={areas} open fresh={false} onOpen={() => setOpened(null)} onError={setError} />
          </ul>
        </Pop>
      )}
      {importing && <ImportBookmarks topics={topics} areas={areas} onClose={() => setImporting(false)}
        onDone={({ importId, added, filed }) => {
          setImporting(false);
          go("all");
          setSaid({ text: t("links.import.done", { n: added, filed }), undo: () => void run("link.import_undo", { importId }, () => setSaid({ text: t("links.import.undone") })) });
        }} />}
      {said && <div className="lk-toast" role="status"><span>{said.text}</span>
        {said.undo && <button type="button" onClick={() => { const undo = said.undo!; setSaid(null); undo(); }}>{t("links.undo")}</button>}</div>}
    </section>
  );
}

const sourceHost = (url: string) => { try { return new URL(url).hostname; } catch { return url; } };
