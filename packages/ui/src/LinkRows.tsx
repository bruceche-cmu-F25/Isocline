/** The two ways the Links page draws what is in a category (docs/design/links.md §4.10.2): a row each (the list), or a
 * card each, row after row (the grid). A site's card is a small tile; a saved thing's is the page's usual card.
 * Opening either shows it as a card over the blurred page. */
import { useState, type DragEvent } from "react";
import type { Area } from "@isocline/protocol";
import type { Clip, Place } from "@isocline/module-links/types";
import { classify } from "@isocline/module-links/url";
import type { Item, Tree } from "./linkTree.ts";
import { DRAG_LINK, TopicList } from "./LinksTree.tsx";
import { SiteIcon, linkFileUrl, useOp } from "./linkControls.tsx";
import { LinkDeleteDialog, onDeleteKey } from "./LinkDeleteDialog.tsx";
import { playbackTime } from "./clipSections.ts";
import { OutLink } from "./Linked.tsx";
import { Pop } from "./shell/Pop.tsx";
import { Icon } from "./shell/icons.tsx";
import { t, type Key } from "./i18n/index.ts";

const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

/** A site's letter, in a colour of its own, until (or unless) its icon is kept. */
export function Mark({ url, title }: { url: string; title: string }) {
  const name = host(url);
  const hue = [...name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);
  const letter = (/[\p{L}\p{N}]/u.exec(title)?.[0] ?? /[\p{L}\p{N}]/u.exec(name)?.[0] ?? "?").toUpperCase();
  return <span className="lr-mark" style={{ background: `oklch(.62 .11 ${hue})` }} aria-hidden="true">{letter}</span>;
}

const iconOf = (item: Item) => item.kind === "place" ? item.place.icon : item.clip.icon;
const dragLink = (item: Item) => (event: DragEvent) => { event.dataTransfer.setData(DRAG_LINK, item.id); event.dataTransfer.setData("text/uri-list", item.url); event.dataTransfer.effectAllowed = "move"; };

/** Where a saved thing came from, short: the platform or site, who made it, how long it runs. */
export function sourceOf(item: Item, platformName: (id: string) => string | undefined): string {
  if (item.kind === "place") return host(item.url);
  const clip = item.clip;
  const platform = platformName(clip.platform);
  const site = platform && (clip.site === classify(clip.url).host || clip.site.toLowerCase() === clip.platform) ? undefined : clip.site;
  return [platform, clip.author ?? site, clip.durationSeconds ? playbackTime(clip.durationSeconds) : undefined].filter(Boolean).join(" · ");
}

export function Row({ item, sub, k, fresh, platformName, onOpen }: {
  item: Item; sub?: string; k?: string; fresh?: boolean; platformName(id: string): string | undefined; onOpen(): void;
}) {
  const clip = item.kind === "clip" ? item.clip : undefined;
  const cover = clip?.cover && clip.type === "video" ? linkFileUrl(clip.cover) : undefined;
  const [broken, setBroken] = useState(false);
  const state = clip && (clip.state === "unread" || clip.state === "todo") ? clip.state : undefined;
  return (
    <li className="lr-row" data-fresh={fresh || undefined} data-k={k} draggable onDragStart={dragLink(item)}>
      <button type="button" className="lr-open" onClick={onOpen}>
        {cover && !broken
          ? <span className="lr-cover"><img src={cover} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} /></span>
          : <SiteIcon icon={iconOf(item)} fallback={<Mark url={item.url} title={item.title} />} />}
        <span className="lr-text">
          <span className="lr-title">{item.title}</span>
          <span className="lr-sub">{sub ?? sourceOf(item, platformName)}</span>
        </span>
        {state && <span className="lr-state" data-s={state} title={t(`links.state.${state}` as Key)} />}
      </button>
      <OutLink className="lr-go" href={item.url} label={t("links.open")}>↗</OutLink>
    </li>
  );
}

/** One card in the grid, the same for a site and a saved thing: its icon, its name, where it is; a cover on top
 * only when there is one (a video, a Xiaohongshu note), so a card without one wastes no room. */
export function Tile({ item, sub, k, fresh, platformName, onOpen }: {
  item: Item; sub?: string; k?: string; fresh?: boolean; platformName(id: string): string | undefined; onOpen(): void;
}) {
  const clip = item.kind === "clip" ? item.clip : undefined;
  const [broken, setBroken] = useState(false);
  const cover = clip?.cover && !broken ? linkFileUrl(clip.cover) : undefined;
  const state = clip && (clip.state === "unread" || clip.state === "todo") ? clip.state : undefined;
  return (
    <li className="lg-tile" data-fresh={fresh || undefined} data-k={k} draggable onDragStart={dragLink(item)}>
      <button type="button" className="lg-open" onClick={onOpen}>
        {cover && <span className="lg-cover" data-tall={clip?.platform === "xiaohongshu" || undefined}>
          <img src={cover} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
          {clip?.durationSeconds && <span className="lk-runtime">{playbackTime(clip.durationSeconds)}</span>}
        </span>}
        <span className="lg-body">
          <SiteIcon icon={iconOf(item)} fallback={<Mark url={item.url} title={item.title} />} />
          <span className="lr-text">
            <span className="lg-title">{item.title}</span>
            <span className="lr-sub">{sub ?? sourceOf(item, platformName)}</span>
          </span>
          {state && <span className="lr-state" data-s={state} title={t(`links.state.${state}` as Key)} />}
        </span>
      </button>
      <OutLink className="lr-go" href={item.url} label={t("links.open")}>↗</OutLink>
    </li>
  );
}

/** A site opened: where it is filed, whether it is pinned on top, and the way out to it. */
export function PlaceCard({ place, tree, areas, pathText, onClose, onError }: {
  place: Place; tree: Tree; areas: Area[]; pathText(topicId: string | undefined): string; onClose(): void; onError(message: string | null): void;
}) {
  const { busy, run } = useOp(onError);
  const [filing, setFiling] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [name, setName] = useState(place.title);
  const areaName = (key: string) => key === "area:" ? t("links.tree.noArea") : areas.find((area) => area.id === key.slice(5))?.name ?? "";
  const rename = () => { const next = name.trim(); if (next && next !== place.title) void run("link.rename", { id: place.id, title: next }); };
  return (
    <Pop onClose={onClose}>
      <div className="ev-edit lr-card" role="dialog" aria-label={place.title} onKeyDown={(event) => event.target === event.currentTarget && onDeleteKey(event, () => setConfirming(true))}>
        <div className="lr-card-head">
          <SiteIcon icon={place.icon} fallback={<Mark url={place.url} title={place.title} />} />
          <input className="ev-title" value={name} maxLength={60} aria-label={t("links.place.name", { title: place.title })}
            onChange={(event) => setName(event.target.value)} onBlur={rename} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) (event.target as HTMLInputElement).blur(); }} />
          <button type="button" className="lk-btn quiet" aria-label={t("links.folder.close")} onClick={onClose}><Icon name="close" /></button>
        </div>
        <p className="lr-url">{place.url}</p>
        <p className="quiet">{t("links.site.about")}</p>
        <div className="lr-field">
          <span>{t("links.tree.category")}</span>
          <button type="button" className="lk-btn" aria-expanded={filing} onClick={() => setFiling(!filing)}>{pathText(place.topicId) || t("links.tree.none")}<Icon name="down" /></button>
        </div>
        {filing && <TopicList tree={tree} areaName={areaName} value={place.topicId} onPick={(topicId) => { setFiling(false); void run("link.place", { id: place.id, topicId: topicId === place.topicId ? "" : topicId }); }} />}
        <div className="lr-foot">
          <OutLink className="lk-btn solid" href={place.url}>{t("links.open")} ↗</OutLink>
          <button type="button" className="lk-btn" aria-pressed={!place.unpinned} disabled={busy}
            onClick={() => void run("link.place", { id: place.id, pinned: !!place.unpinned })}>{t(place.unpinned ? "links.site.pin" : "links.site.pinned")}</button>
          <span />
          <button type="button" className="lk-btn quiet" disabled={busy} onClick={() => setConfirming(true)}>{t("links.remove")}</button>
        </div>
        {confirming && <LinkDeleteDialog title={place.title} onCancel={() => setConfirming(false)}
          onDelete={() => { setConfirming(false); void run("link.remove", { id: place.id }, onClose); }} />}
      </div>
    </Pop>
  );
}

export type { Clip };
