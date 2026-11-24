/** Bringing in a browser's bookmarks (docs/design/links.md §4.10.4). Chrome, Safari, Firefox and Edge all export the
 * same HTML file (the old Netscape bookmark format); this reads it, and proposes where each bookmark goes in the
 * user's category tree before anything is written. Pure (no Node): the page reads the file and shows the proposal,
 * and the home node writes what the user confirmed (`link.import`).
 */
import type { Topic } from "./types.ts";
import { classify, normalizeUrl, tidyTitle } from "./url.ts";
import { MAX_TOPIC_DEPTH, topicChain, topicTree } from "./tree.ts";

export interface Bookmark {
  title: string;
  url: string;
  /** The folders it sits in, outermost first. */
  folders: string[];
}

/** The most bookmarks one import takes. */
export const MAX_IMPORT = 5000;
/** How many go to the home node in one request (each request stays far below its 64 KB limit). */
export const IMPORT_CHUNK = 150;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };
const decode = (value: string) => value
  .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  })
  .replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

/** The bookmarks in an exported file, each with its folders. Anything that is not a web address is left out. */
export function parseBookmarks(html: string): Bookmark[] {
  const out: Bookmark[] = [];
  const stack: Array<string | null> = [];
  let pending: string | null = null;
  const token = /<h3\b[^>]*>([\s\S]*?)<\/h3>|<a\b([^>]*)>([\s\S]*?)<\/a>|<dl\b[^>]*>|<\/dl>/gi;
  for (let match = token.exec(html); match; match = token.exec(html)) {
    const whole = match[0].toLowerCase();
    if (match[1] !== undefined) pending = decode(match[1]);
    else if (match[2] !== undefined) {
      const href = /\bhref\s*=\s*"([^"]*)"|\bhref\s*=\s*'([^']*)'/i.exec(match[2]);
      const url = decode(href?.[1] ?? href?.[2] ?? "");
      if (!/^https?:\/\//i.test(url)) continue;
      out.push({ title: decode(match[3]) || url, url, folders: stack.filter((name): name is string => !!name) });
    } else if (whole.startsWith("<dl")) { stack.push(pending); pending = null; } else stack.pop();
  }
  return out;
}

/** Folders a browser makes on its own: they say where a bookmark was kept, not what it is about. */
const BROWSER_FOLDERS = new Set([
  "bookmarks", "bookmarks bar", "bookmarks toolbar", "bookmarks menu", "other bookmarks", "mobile bookmarks", "favorites", "favorites bar",
  "imported", "imported from safari", "imported from chrome", "imported from firefox", "reading list",
  "书签", "书签栏", "书签工具栏", "书签菜单", "其他书签", "移动设备书签", "收藏夹", "收藏夹栏", "阅读列表",
]);
const key = (name: string) => name.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");

/** A site you visit (a home page, a tool, a dashboard) or something to read or watch. A bookmark to the top of a
 * site or one level down, that is not a video or post, is taken for a site. */
export function importKind(url: string): "place" | "clip" {
  const { type, platform } = classify(url);
  if (type === "video" || type === "post" || type === "doc" || (type === "repo" && platform === "github")) return "clip";
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts.length <= 1 && !new URL(url).search ? "place" : "clip";
  } catch { return "clip"; }
}

export interface ImportItem { title: string; url: string; kind: "place" | "clip"; folder?: string }
/** One category of the proposal: a new one, or one the user already has. */
export interface ProposedNode {
  key: string;
  name: string;
  area?: string;
  /** The key of the node it sits under, in this proposal. */
  parent?: string;
  /** The user's own topic it is (matched by name), when it is one. */
  topicId?: string;
  /** The folder names that went into it. */
  from: string[];
  items: ImportItem[];
}
export interface ImportProposal {
  nodes: ProposedNode[];
  /** Bookmarks in no folder. */
  loose: ImportItem[];
  /** Addresses that were there twice, or that the user already has, are not counted twice. */
  total: number;
  /** Left out: past MAX_IMPORT. */
  over: number;
}

/** Where each bookmark goes. Folders of the same name (however written) become one category; a folder with the name of
 * one of the user's topics goes there; a top folder named after an area stands for that area, and one with an area's
 * name in it (「刷题与学习」) is put under that area. Folders deeper than the tree allows are folded into their parent. The user changes the rest. */
export function proposeImport(bookmarks: readonly Bookmark[], topics: readonly Topic[], areas: ReadonlyArray<{ id: string; name: string }>, have: ReadonlySet<string> = new Set()): ImportProposal {
  const tree = topicTree(topics);
  const nodes = new Map<string, ProposedNode>();
  const loose: ImportItem[] = [];
  const seen = new Set<string>();
  let total = 0, over = 0;
  const areaFor = (name: string) => {
    const k = key(name);
    return areas.find((area) => key(area.name) === k) ?? areas.find((area) => key(area.name).length >= 2 && k.includes(key(area.name)));
  };
  const nodeFor = (path: string[], inArea?: string): ProposedNode | undefined => {
    let parent: ProposedNode | undefined;
    for (const folder of path) {
      const nodeKey = `${parent?.key ?? inArea ?? ""}/${key(folder)}`;
      let node = nodes.get(nodeKey);
      if (!node) {
        // The user's own topic of this name, at this level: under the same parent, or at the top for a top folder.
        const own = topics.find((topic) => key(topic.name) === key(folder) && (parent ? topic.parentId === parent.topicId : !topic.parentId || topicChain(tree, topic.id).length === 1))
          ?? (!parent ? topics.find((topic) => key(topic.name) === key(folder)) : undefined);
        const area = own ? own.area : parent ? parent.area : inArea ?? areaFor(folder)?.id;
        // A folder named after an area only says which area: its bookmarks need a category of their own all the same.
        node = { key: nodeKey, name: own?.name ?? folder, ...(area ? { area } : {}), ...(parent ? { parent: parent.key } : {}), ...(own ? { topicId: own.id } : {}), from: [], items: [] };
        nodes.set(nodeKey, node);
      }
      if (!node.from.includes(folder)) node.from.push(folder);
      parent = node;
    }
    return parent;
  };
  for (const bookmark of bookmarks) {
    let url: string;
    try { url = normalizeUrl(bookmark.url); } catch { continue; }
    if (seen.has(url) || have.has(url)) continue;
    seen.add(url);
    if (total >= MAX_IMPORT) { over++; continue; }
    total++;
    // The browser's own folders go; the tree takes at most two levels, so deeper folders fold into the second.
    let folders = bookmark.folders.filter((folder, index) => !(index === 0 && BROWSER_FOLDERS.has(folder.toLowerCase().trim())) && folder.trim());
    const item: ImportItem = { title: tidyTitle(bookmark.title, url).title.slice(0, 300), url, kind: importKind(url), ...(folders.length ? { folder: folders[folders.length - 1] } : {}) };
    // A top folder named exactly after an area is that area: the folders in it are its categories.
    const named = folders.length > 1 ? areas.find((area) => key(area.name) === key(folders[0])) : undefined;
    if (named) folders = folders.slice(1);
    const path = folders.length > MAX_TOPIC_DEPTH ? [folders[0], folders[folders.length - 1]] : folders;
    const node = nodeFor(path, named?.id);
    if (node) node.items.push(item); else loose.push(item);
  }
  return { nodes: [...nodes.values()], loose, total, over };
}

/** What the home node is sent for one bookmark: where it goes as names, so a request stands on its own. */
export interface ImportEntry {
  url: string;
  title: string;
  kind: "place" | "clip";
  /** The topic's names from the top of the area down (one or two), and its area. None: unfiled. */
  path?: string[];
  area?: string;
}

/** The proposal as the user left it, as entries to send. Nodes merged into another carry their bookmarks there. */
export function importEntries(proposal: ImportProposal, topics: readonly Topic[]): ImportEntry[] {
  const tree = topicTree(topics);
  const byKey = new Map(proposal.nodes.map((node) => [node.key, node]));
  const pathOf = (node: ProposedNode): { path: string[]; area?: string } => {
    if (node.topicId && tree.byId.has(node.topicId)) {
      const chain = topicChain(tree, node.topicId);
      return { path: chain.map((topic) => topic.name), ...(chain[0].area ? { area: chain[0].area } : {}) };
    }
    const parent = node.parent ? byKey.get(node.parent) : undefined;
    if (!parent) return { path: [node.name], ...(node.area ? { area: node.area } : {}) };
    const above = pathOf(parent);
    return { path: [...above.path, node.name].slice(-MAX_TOPIC_DEPTH), ...(above.area ? { area: above.area } : {}) };
  };
  const out: ImportEntry[] = [];
  for (const node of proposal.nodes) {
    const where = pathOf(node);
    for (const item of node.items) out.push({ url: item.url, title: item.title, kind: item.kind, ...where });
  }
  for (const item of proposal.loose) out.push({ url: item.url, title: item.title, kind: item.kind });
  return out;
}
