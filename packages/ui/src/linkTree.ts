/** What the Links page shows, worked out without the DOM (docs/design/links.md §4.10): every link with where it sits
 * in the category tree, counts per node, what a search finds, and which view each node was last left in. */
import type { Clip, LinkType, Place, Topic } from "@zirma/module-links/types";
import { topicChain, topicTree, under, type TopicTree } from "@zirma/module-links/tree";
import type { ImportProposal, ProposedNode } from "@zirma/module-links/bookmarks";

/** A place or a clip, as one row. Places count as a type of their own: a site. */
export type Item = { kind: "place"; id: string; title: string; url: string; topicId?: string; type: "site"; place: Place }
  | { kind: "clip"; id: string; title: string; url: string; topicId?: string; type: LinkType; clip: Clip };
export type ItemType = Item["type"];

/** The nodes that are not categories: everything, the latest clips, and what is filed nowhere. */
export type Node = "all" | "recent" | "none" | `area:${string}` | string;

export function itemsOf(places: readonly Place[], clips: readonly Clip[]): Item[] {
  return [
    ...clips.map((clip): Item => ({ kind: "clip", id: clip.id, title: clip.title, url: clip.url, topicId: clip.topicId, type: clip.type, clip })),
    ...places.map((place): Item => ({ kind: "place", id: place.id, title: place.title, url: place.url, topicId: place.topicId, type: "site", place })),
  ];
}

export interface Tree extends TopicTree {
  /** The areas that hold a category, in the user's order, then `area:` for topics with no area. */
  roots: string[];
}

export function linkTree(topics: readonly Topic[], areaIds: readonly string[]): Tree {
  const tree = topicTree(topics);
  // Only areas that hold a category: an empty area is a row of nothing, and the tree's own "new category" reaches it.
  const roots = [...areaIds.map((id) => `area:${id}`).filter((root) => tree.children.has(root)), ...(tree.children.has("area:") ? ["area:"] : [])]
    .filter((root, index, all) => all.indexOf(root) === index);
  // Topics in an area the user has since removed sit with the topics that have none.
  for (const [key, list] of tree.children) {
    if (key.startsWith("area:") && key !== "area:" && !areaIds.includes(key.slice(5))) {
      tree.children.set("area:", [...(tree.children.get("area:") ?? []), ...list]);
      tree.children.delete(key);
      if (!roots.includes("area:")) roots.push("area:");
    }
  }
  return { ...tree, roots };
}

/** The node's topics, itself included; for an area, all of its topics. */
export const nodeTopics = (tree: Tree, node: Node): Set<string> => under(tree, node);

export function inNode(tree: Tree, node: Node, items: readonly Item[]): Item[] {
  if (node === "all") return [...items];
  if (node === "none") return items.filter((item) => !item.topicId || !tree.byId.has(item.topicId));
  if (node === "recent") return items.filter((item) => item.kind === "clip" && isRecent(item.clip));
  const set = nodeTopics(tree, node);
  return items.filter((item) => !!item.topicId && set.has(item.topicId));
}

/** Newly saved and not looked at: the clips the page puts first. */
export const isRecent = (clip: Clip, now = Date.now()) => clip.fetch === "pending" || (clip.state === "unread" && now - Date.parse(clip.savedAt) < 7 * 86_400_000);

/** How many items sit at or below each node. */
export function counts(tree: Tree, items: readonly Item[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) {
    const topic = item.topicId ? tree.byId.get(item.topicId) : undefined;
    if (!topic) { out.set("none", (out.get("none") ?? 0) + 1); continue; }
    const chain = topicChain(tree, topic.id);
    for (const step of chain) out.set(step.id, (out.get(step.id) ?? 0) + 1);
    const root = tree.roots.includes(`area:${chain[0].area ?? ""}`) ? `area:${chain[0].area ?? ""}` : "area:";
    out.set(root, (out.get(root) ?? 0) + 1);
  }
  return out;
}

/** A search's words: everything typed, split on spaces, each to be found. */
export const searchWords = (query: string) => query.trim().toLowerCase().split(/\s+/).filter(Boolean);

/** A node's path in names: "Learning › Roadmaps", the area first. */
export function nodePath(tree: Tree, node: Node, areaName: (id: string) => string | undefined): string[] {
  if (node.startsWith("area:")) return [areaName(node.slice(5)) ?? ""];
  const chain = topicChain(tree, node);
  if (!chain.length) return [];
  return [areaName(chain[0].area ?? "") ?? "", ...chain.map((topic) => topic.name)].filter(Boolean);
}

/** The items a search finds: every word in the title, the site, the address, the note, the page's description or
 * the category's path. Those with the words in their title come first, then the newest. */
export function searchItems(items: readonly Item[], words: readonly string[], pathOf: (item: Item) => string): Item[] {
  if (!words.length) return [...items];
  const scored = items.flatMap((item) => {
    const clip = item.kind === "clip" ? item.clip : undefined;
    const hay = [item.title, item.url, clip?.site, clip?.author, clip?.note, clip?.description, pathOf(item)].filter(Boolean).join(" ").toLowerCase();
    if (!words.every((word) => hay.includes(word))) return [];
    const title = item.title.toLowerCase();
    return [{ item, inTitle: words.every((word) => title.includes(word)) }];
  });
  return scored.sort((a, b) => Number(b.inTitle) - Number(a.inTitle)).map((entry) => entry.item);
}

/** The categories a search finds: every word in the category's path. */
export function searchTopics(tree: Tree, words: readonly string[], pathOf: (id: string) => string, within?: Set<string>): Topic[] {
  if (!words.length) return [];
  return [...tree.byId.values()].filter((topic) => (!within || within.has(topic.id)) && words.every((word) => pathOf(topic.id).toLowerCase().includes(word)));
}

/** Newest first; sites, which have no date, after the clips, by name. */
export function byNewest(a: Item, b: Item): number {
  if (a.kind === "clip" && b.kind === "clip") return b.clip.savedAt.localeCompare(a.clip.savedAt);
  if (a.kind !== b.kind) return a.kind === "clip" ? -1 : 1;
  return a.title.localeCompare(b.title);
}

export type View = "list" | "grid";
const VIEW_KEY = "zirma.links.view";
/** Each node remembers its own view on this device; list unless the user changed it. */
export function readViews(): Record<string, View> {
  try { const value = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}"); return value && typeof value === "object" ? value : {}; } catch { return {}; }
}
export function writeViews(views: Record<string, View>): void {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(views)); } catch { /* the choice just is not remembered */ }
}

/** One proposed category joins another: its bookmarks go there; a category under it moves along, or, when the target
 * already sits under another (the tree is two deep), gives its bookmarks to the target too. */
export function mergeProposed(proposal: ImportProposal, from: string, into: string): ImportProposal {
  if (from === into) return proposal;
  const source = proposal.nodes.find((node) => node.key === from);
  const target = proposal.nodes.find((node) => node.key === into);
  if (!source || !target) return proposal;
  const children = proposal.nodes.filter((node) => node.parent === from);
  const flatten = !!target.parent || children.some((child) => child.key === into);
  const moved: ProposedNode = { ...target, from: [...new Set([...target.from, ...source.from])], items: [...target.items, ...source.items, ...(flatten ? children.flatMap((child) => child.items) : [])] };
  const nodes = proposal.nodes.flatMap((node) => {
    if (node.key === from || (flatten && node.parent === from)) return [];
    if (node.key === into) return [moved];
    if (node.parent === from) return [{ ...node, parent: into, ...(target.area ? { area: target.area } : {}) }];
    return [node];
  });
  return { ...proposal, nodes };
}

/** A proposed category's area changes, and its children's with it. */
export function setProposedArea(proposal: ImportProposal, key: string, area: string | undefined): ImportProposal {
  return { ...proposal, nodes: proposal.nodes.map((node) => node.key === key || node.parent === key ? { ...node, area } : node) };
}
