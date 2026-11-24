import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_MIGRATIONS, openWorld, withCoreContext, type World } from "@isocline/core";
import { runTools } from "@isocline/module-kit";
import {
  ensureTopic, importEntries, importKind, importLinks, linksModule, listClips, listFolders, listPlaces, listTopics, mergeTopic, parseBookmarks, pinPlace, proposeImport,
  removeTopic, saveClip, topicPath, topicTree, undoImport, updatePlace, updateTopic, groupPlaces, LINK_OPS, tidyTitle,
} from "../src/index.ts";

test("every operation has a name the home node routes (module.action, one dot)", () => {
  for (const op of LINK_OPS) assert.match(op, /^[a-z][a-z0-9]*\.[a-z][a-z_]*$/, op);
  assert.deepEqual([...LINK_OPS].sort(), linksModule.ops!.map((op) => op.name).sort());
});

const world = (): World => openWorld(":memory:", [...CORE_MIGRATIONS, ...linksModule.migrations]);
const ok = <T extends object>(result: T | { error: string }): T => { assert.ok(!("error" in result), JSON.stringify(result)); return result as T; };
const path = (w: World, id: string | undefined) => topicPath(topicTree(listTopics(w)), id, undefined, "/");
const signal = new AbortController().signal;

test("categories form a tree: two levels under an area, names unique among siblings, moves carry what is below", () => {
  const w = world();
  const learning = ok(ensureTopic(w, { name: "Learning", area: "learn" }));
  const roadmaps = ok(ensureTopic(w, { name: "Roadmaps", parentId: learning.id }));
  assert.equal(roadmaps.area, "learn", "a topic under another takes its area");
  assert.equal(path(w, roadmaps.id), "Learning/Roadmaps");
  assert.deepEqual(ensureTopic(w, { name: "Too deep", parentId: roadmaps.id }), { error: "Categories go at most 2 levels deep under an area." });
  assert.equal(ok(ensureTopic(w, { name: "roadmaps", parentId: learning.id })).id, roadmaps.id, "the same name under the same topic is that topic");
  const other = ok(ensureTopic(w, { name: "Roadmaps", area: "work" }));
  assert.notEqual(other.id, roadmaps.id, "the same name elsewhere is another topic");
  assert.equal(ok(ensureTopic(w, { name: "roadmaps" })).id, other.id, "a bare name finds a top-level topic first");
  assert.equal(listTopics(w).length, 3);

  // Moving: under itself, or too deep, is refused; moving an area carries what is below.
  assert.deepEqual(updateTopic(w, learning.id, { parentId: roadmaps.id }), { error: "A topic cannot go under itself." });
  assert.deepEqual(updateTopic(w, learning.id, { parentId: other.id }), { error: "Categories go at most 2 levels deep under an area." });
  ok(updateTopic(w, learning.id, { area: "work" }));
  assert.equal(listTopics(w).find((topic) => topic.id === roadmaps.id)!.area, "work");
  assert.deepEqual(updateTopic(w, other.id, { parentId: learning.id }), { error: 'There is already a category named "Roadmaps" there.' });
  assert.deepEqual(updateTopic(w, roadmaps.id, { parentId: "" }), { error: 'There is already a category named "Roadmaps" there.' }, "the top of Work has one");
  assert.equal(path(w, ok(updateTopic(w, roadmaps.id, { parentId: "", name: "Paths" })).id), "Paths");
});

test("removing a category moves what it held up a level; merging puts everything below into the other", () => {
  const w = world();
  const jobs = ok(ensureTopic(w, { name: "Jobs", area: "work" }));
  const boards = ok(ensureTopic(w, { name: "Boards", parentId: jobs.id }));
  const posts = ok(ensureTopic(w, { name: "Posts", parentId: jobs.id }));
  const topBoards = ok(ensureTopic(w, { name: "boards", area: "work" }));
  const a = ok(saveClip(w, { url: "https://example.com/a", topicId: jobs.id })).clip;
  const b = ok(saveClip(w, { url: "https://example.com/b", topicId: boards.id })).clip;
  const c = ok(saveClip(w, { url: "https://example.com/c", topicId: posts.id })).clip;

  assert.deepEqual(ok(removeTopic(w, jobs.id)), { name: "Jobs", moved: 1 });
  const byId = new Map(listClips(w).map((clip) => [clip.id, clip.topicId]));
  assert.equal(byId.get(a.id), undefined, "at the top of an area, it is unfiled");
  assert.equal(byId.get(b.id), topBoards.id, "a child that meets one of its name up there joins it");
  assert.equal(byId.get(c.id), posts.id);
  assert.equal(listTopics(w).find((topic) => topic.id === posts.id)!.parentId, undefined, "the other child is now at the top");

  const sub = ok(ensureTopic(w, { name: "Sub", parentId: posts.id }));
  const d = ok(saveClip(w, { url: "https://example.com/d", topicId: sub.id })).clip;
  assert.deepEqual(mergeTopic(w, posts.id, sub.id), { error: "A topic cannot be merged into one under it." });
  assert.deepEqual(ok(mergeTopic(w, posts.id, topBoards.id)), { name: "Posts", into: "boards", moved: 2 });
  assert.deepEqual(listClips(w).filter((clip) => [c.id, d.id].includes(clip.id)).map((clip) => clip.topicId), [topBoards.id, topBoards.id]);
  assert.deepEqual(listTopics(w).map((topic) => topic.name), ["boards"]);
});

test("a site can live in the tree without being pinned; pinning and unpinning move it on and off the top row", () => {
  const w = world();
  const learning = ok(ensureTopic(w, { name: "Learning", area: "learn" }));
  const gmail = listPlaces(w).find((place) => place.title === "Gmail")!;
  const youtube = listPlaces(w).find((place) => place.title === "YouTube")!;
  const folder = ok(groupPlaces(w, { id: youtube.id, targetId: gmail.id, title: "Google" })).folder;

  const unpinned = ok(updatePlace(w, gmail.id, { topicId: learning.id, pinned: false }));
  assert.deepEqual([unpinned.unpinned, unpinned.topicId, unpinned.folderId], [true, learning.id, undefined]);
  assert.deepEqual(listFolders(w).map((f) => f.id), [folder.id], "the folder still holds YouTube");
  ok(updatePlace(w, youtube.id, { pinned: false }));
  assert.deepEqual(listFolders(w), [], "an emptied folder goes");

  // Pinning it again by address puts it back at the end of the row, in its category still.
  const again = ok(pinPlace(w, { url: "https://mail.google.com" }));
  assert.equal(again.existing, false);
  assert.deepEqual([again.place.unpinned, again.place.topicId], [undefined, learning.id]);
  assert.deepEqual(updatePlace(w, gmail.id, { topicId: "nope" }), { error: "No such topic." });
});

const FILE = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE><H1>Bookmarks</H1>
<DL><p>
  <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
  <DL><p>
    <DT><H3>刷题与学习</H3>
    <DL><p>
      <DT><A HREF="https://leetcode.com/" ADD_DATE="1">LeetCode</A>
      <DT><A HREF="https://www.youtube.com/watch?v=abc123">DP &amp; you</A>
      <DT><H3>Roadmaps</H3>
      <DL><p>
        <DT><H3>Deep</H3>
        <DL><p><DT><A HREF="https://roadmap.sh/backend">Backend</A></DL><p>
      </DL><p>
    </DL><p>
    <DT><H3>Job hunt</H3>
    <DL><p><DT><A HREF="https://jobs.example.com/a/b/c">An opening</A></DL><p>
    <DT><H3>job  HUNT</H3>
    <DL><p><DT><A HREF="https://wellfound.com">Wellfound</A><DT><A HREF="javascript:alert(1)">bad</A></DL><p>
  </DL><p>
  <DT><A HREF="https://example.org/">Loose one</A>
  <DT><A HREF="https://leetcode.com">LeetCode again</A>
</DL><p>`;

test("a bookmarks file is read with its folders, and proposed as a tree before anything is written", () => {
  const marks = parseBookmarks(FILE);
  assert.deepEqual(marks.map((mark) => [mark.title, mark.folders.join("/")]), [
    ["LeetCode", "Bookmarks bar/刷题与学习"], ["DP & you", "Bookmarks bar/刷题与学习"], ["Backend", "Bookmarks bar/刷题与学习/Roadmaps/Deep"],
    ["An opening", "Bookmarks bar/Job hunt"], ["Wellfound", "Bookmarks bar/job HUNT"], ["Loose one", ""], ["LeetCode again", ""],
  ], "only web addresses; entities decoded");
  assert.deepEqual(["https://leetcode.com", "https://www.youtube.com/watch?v=abc123", "https://roadmap.sh/backend", "https://jobs.example.com/a/b/c", "https://github.com/a/b"].map(importKind),
    ["place", "clip", "place", "clip", "clip"]);

  const w = world();
  const existing = ok(ensureTopic(w, { name: "Job Hunt", area: "work" }));
  const areas = [{ id: "learn", name: "学习" }, { id: "work", name: "工作" }];
  const proposal = proposeImport(marks, listTopics(w), areas);
  assert.equal(proposal.total, 6, "the same address twice counts once");
  assert.deepEqual(proposal.nodes.map((node) => [node.name, node.area ?? "", node.parent ?? "", node.topicId ?? "", node.from.join("+"), node.items.length]), [
    ["刷题与学习", "learn", "", "", "刷题与学习", 2],
    ["Deep", "learn", "/刷题与学习", "", "Deep", 1],
    ["Job Hunt", "work", "", existing.id, "Job hunt+job HUNT", 2],
  ], "browser folders dropped; deep folders folded to two levels; same names merged; the user's own topic matched; area guessed from its name");
  assert.deepEqual(proposal.loose.map((item) => item.title), ["Loose one"]);
});

test("an import is written in parts, files what is already there, and can be undone", () => {
  const w = world();
  const tools = runTools(w, [linksModule]);
  const existing = ok(ensureTopic(w, { name: "Job Hunt", area: "work" }));
  const already = ok(saveClip(w, { url: "https://wellfound.com/" })).clip;
  const proposal = proposeImport(parseBookmarks(FILE), listTopics(w), [{ id: "learn", name: "学习" }]);
  const entries = importEntries(proposal, listTopics(w));
  assert.deepEqual(entries.find((entry) => entry.url === "https://roadmap.sh/backend"), { url: "https://roadmap.sh/backend", title: "Backend", kind: "place", path: ["刷题与学习", "Deep"], area: "learn" });

  const first = ok(importLinks(w, { importId: "imp-1", entries: entries.slice(0, 3) }));
  const second = ok(importLinks(w, { importId: "imp-1", entries: entries.slice(3) }));
  assert.deepEqual([first.added + second.added, second.filed], [5, 1], "Wellfound was already saved: it is filed, not added");
  assert.equal(listClips(w).find((clip) => clip.id === already.id)!.topicId, existing.id);
  const backend = listPlaces(w).find((place) => place.url === "https://roadmap.sh/backend")!;
  assert.deepEqual([backend.unpinned, path(w, backend.topicId)], [true, "刷题与学习/Deep"]);
  const video = listClips(w).find((clip) => clip.url.includes("abc123"))!;
  assert.deepEqual([video.state, video.fetch, video.title], ["seen", "done", "DP & you"], "an imported clip is not news");
  assert.equal(listPlaces(w).filter((place) => !place.unpinned).length, 3, "the top row is as it was");

  // Isocline sees the tree, and files under a path.
  const call = (name: string, params: Record<string, unknown>) => withCoreContext({ actor: "alfred" }, () => String(tools.find((tool) => tool.name === name)!.execute(params, signal)));
  assert.match(call("link_list", { tree: true }), /\[learn\]\n {2}- 刷题与学习 \(\S+\) 3\n {4}- Deep \(\S+\) 1/);
  assert.match(call("link_list", { topic: "刷题与学习/Deep" }), /Places \(1\):\n\S+ {2}Backend \| site \| topic: 刷题与学习\/Deep/);
  assert.match(call("link_save", { url: "https://example.com/rag", topic: "RAG", under: "刷题与学习" }), /topic: 刷题与学习\/RAG/);
  assert.match(call("link_update", { id: backend.id, topic: "Job Hunt" }), /^Updated: Backend \| topic: Job Hunt$/);

  // Undo: what it added goes; categories it made go once empty (RAG was made later and holds a clip).
  assert.deepEqual(ok(undoImport(w, "imp-1")), { removed: 5 });
  assert.equal(listClips(w).find((clip) => clip.id === already.id)!.topicId, existing.id, "what it filed stays filed");
  assert.deepEqual(listTopics(w).map((topic) => topic.name).sort(), ["Job Hunt", "RAG", "刷题与学习"]);
  assert.deepEqual(undoImport(w, "imp-1"), { error: "That import can no longer be undone." });
});

test("a title loses what only repeats where it is", () => {
  assert.deepEqual(tidyTitle("GitHub - obra/superpowers: An agentic skills framework that works. · GitHub", "https://github.com/obra/superpowers"),
    { title: "obra/superpowers", description: "An agentic skills framework that works." });
  assert.deepEqual(tidyTitle("GitHub - a/b · GitHub", "https://github.com/a/b"), { title: "a/b" });
  assert.equal(tidyTitle("(3) RAG from scratch - YouTube", "https://www.youtube.com/watch?v=x").title, "RAG from scratch");
  assert.equal(tidyTitle("Full Stack Developer Roadmap | roadmap.sh", "https://roadmap.sh/full-stack").title, "Full Stack Developer Roadmap");
  assert.equal(tidyTitle("Machine Learning Specialization - Coursera", "https://www.coursera.org/specializations/ml").title, "Machine Learning Specialization");
  assert.equal(tidyTitle("如何评价 RAG？ - 知乎", "https://www.zhihu.com/question/1").title, "如何评价 RAG？");
  assert.equal(tidyTitle("Backend Developer Roadmap: What is Backend Development", "https://roadmap.sh/backend").title, "Backend Developer Roadmap: What is Backend Development", "the page's own words stay");
  assert.equal(tidyTitle("Design - Build - Ship", "https://example.com/x").title, "Design - Build - Ship", "a dash in the title is not a site's name");
});
