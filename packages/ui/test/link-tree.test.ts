import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clip, Place, Topic } from "@isocline/module-links/types";
import { parseBookmarks, proposeImport } from "@isocline/module-links/bookmarks";
import { counts, inNode, itemsOf, linkTree, mergeProposed, nodePath, searchItems, searchTopics, searchWords, setProposedArea } from "../src/linkTree.ts";

const topics: Topic[] = [
  { id: "learn", name: "Learning", area: "learn" },
  { id: "road", name: "Roadmaps", area: "learn", parentId: "learn" },
  { id: "jobs", name: "Jobs", area: "work" },
  { id: "old", name: "Orphan", area: "gone" },
];
const clip = (id: string, title: string, topicId?: string, extra: Partial<Clip> = {}): Clip => ({
  id, url: `https://example.com/${id}`, title, titleSource: "page", platform: "web", type: "article", site: "example.com", state: "seen",
  savedAt: `2026-11-${10 + id.length}T00:00:00Z`, fetch: "done", ...(topicId ? { topicId } : {}), ...extra,
});
const place = (id: string, title: string, topicId?: string): Place => ({ id, title, url: `https://${id}.example`, ...(topicId ? { topicId } : {}), unpinned: true });

test("each link is counted at its category, every category above it, and its area; the rest are unfiled", () => {
  const tree = linkTree(topics, ["learn", "work"]);
  assert.deepEqual(tree.roots, ["area:learn", "area:work", "area:"], "topics of a removed area sit with those of none");
  const items = itemsOf([place("sys", "System Design", "road")], [clip("a", "RAG from scratch", "learn"), clip("bb", "Résumé tips", "jobs"), clip("ccc", "Loose")]);
  const n = counts(tree, items);
  assert.deepEqual([n.get("road"), n.get("learn"), n.get("area:learn"), n.get("jobs"), n.get("area:work"), n.get("none")], [1, 2, 2, 1, 1, 1]);
  assert.deepEqual(inNode(tree, "area:learn", items).map((item) => item.id).sort(), ["a", "sys"]);
  assert.deepEqual(inNode(tree, "none", items).map((item) => item.id), ["ccc"]);
  assert.deepEqual(nodePath(tree, "road", (id) => ({ learn: "学习" })[id]), ["学习", "Learning", "Roadmaps"]);
});

test("a search finds links by any of their words or their category, titles first, and categories by their path", () => {
  const tree = linkTree(topics, ["learn", "work"]);
  const items = itemsOf([place("sys", "System Design", "road")], [clip("a", "Notes", "road", { note: "system design prep" }), clip("bb", "Résumé tips", "jobs")]);
  const path = (item: (typeof items)[number]) => nodePath(tree, item.topicId ?? "", () => undefined).join(" › ");
  assert.deepEqual(searchItems(items, searchWords("  System DESIGN "), path).map((item) => item.id), ["sys", "a"], "the title match first");
  assert.deepEqual(searchItems(items, searchWords("roadmaps"), path).map((item) => item.id).sort(), ["a", "sys"], "a category's name finds what is in it");
  assert.deepEqual(searchTopics(tree, searchWords("learn road"), (id) => nodePath(tree, id, () => undefined).join(" › ")).map((topic) => topic.id), ["road"]);
});

test("on the import card, merging a folder moves its bookmarks and what is under it; an area set on one is set on its children", () => {
  const file = `<DL><p><DT><H3>A</H3><DL><p><DT><A HREF="https://a.example/x/y">a</A><DT><H3>A1</H3><DL><p><DT><A HREF="https://a1.example/x/y">a1</A></DL><p></DL><p>
    <DT><H3>B</H3><DL><p><DT><A HREF="https://b.example/x/y">b</A></DL><p></DL><p>`;
  const proposal = proposeImport(parseBookmarks(file), [], []);
  assert.deepEqual(proposal.nodes.map((node) => node.key), ["/a", "/a/a1", "/b"]);
  const merged = mergeProposed(proposal, "/a", "/b");
  assert.deepEqual(merged.nodes.map((node) => [node.key, node.parent ?? "", node.items.length]), [["/a/a1", "/b", 1], ["/b", "", 2]]);
  const flat = mergeProposed(proposal, "/b", "/a/a1");
  assert.deepEqual(flat.nodes.map((node) => [node.key, node.items.length]), [["/a", 1], ["/a/a1", 2]], "into a sub-category, it just adds its bookmarks");
  assert.deepEqual(setProposedArea(proposal, "/a", "learn").nodes.map((node) => node.area ?? ""), ["learn", "learn", ""]);
});
