/** The category tree, read (docs/design/links.md §4.10.1). Areas are the roots; under an area sit at most two levels of
 * topics. No imports beyond types, so the page and the home node both use these. */
import type { Topic } from "./types.ts";

/** At most this many levels of topics under an area. */
export const MAX_TOPIC_DEPTH = 2;

export interface TopicTree {
  byId: Map<string, Topic>;
  /** A topic's children, by its id; an area's top topics by `area:<id>`; topics with no area by `area:`. */
  children: Map<string, Topic[]>;
}

export const areaNode = (area: string | undefined) => `area:${area ?? ""}`;

export function topicTree(topics: readonly Topic[]): TopicTree {
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const children = new Map<string, Topic[]>();
  for (const topic of topics) {
    // A parent that is gone (it should not be) leaves its child at the top of its area.
    const key = topic.parentId && byId.has(topic.parentId) ? topic.parentId : areaNode(topic.area);
    const list = children.get(key);
    if (list) list.push(topic); else children.set(key, [topic]);
  }
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return { byId, children };
}

/** The topics from the top of the area down to this one. */
export function topicChain(tree: TopicTree, id: string | undefined): Topic[] {
  const out: Topic[] = [];
  const seen = new Set<string>();
  for (let topic = id ? tree.byId.get(id) : undefined; topic && !seen.has(topic.id); topic = topic.parentId ? tree.byId.get(topic.parentId) : undefined) {
    seen.add(topic.id);
    out.unshift(topic);
  }
  return out;
}

/** 1 for a topic right under its area, 2 under another topic. */
export const topicDepth = (tree: TopicTree, id: string) => topicChain(tree, id).length;

/** A node and everything under it: a topic's id, or `area:<id>` for an area. */
export function under(tree: TopicTree, node: string): Set<string> {
  const out = new Set<string>(node.startsWith("area:") ? [] : [node]);
  const walk = (key: string) => {
    for (const child of tree.children.get(key) ?? []) {
      if (out.has(child.id)) continue;
      out.add(child.id);
      walk(child.id);
    }
  };
  walk(node);
  return out;
}

/** "Learning › Roadmaps", with the area's name first when it is given. */
export function topicPath(tree: TopicTree, id: string | undefined, areaName?: (area: string | undefined) => string | undefined, separator = " › "): string {
  const chain = topicChain(tree, id);
  if (!chain.length) return "";
  const area = areaName?.(chain[0].area);
  return [...(area ? [area] : []), ...chain.map((topic) => topic.name)].join(separator);
}
