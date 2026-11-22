import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_MIGRATIONS, listEvents, openWorld, withCoreContext, type World } from "@alfred/core";
import { invokeOp, runTools } from "@alfred/module-kit";
import {
  classify, createLinksModule, findUrl, getIcon, iconsToFetch, linksModule, listClips, listPlaces, listTopics, nameFromUrl, normalizeUrl, PageFetchError, pendingClips,
  pinPlace, recordPage, removeLink, saveClip, updateClip, type LinksSnapshot, type PageFetcher,
} from "../src/index.ts";

const world = (): World => openWorld(":memory:", [...CORE_MIGRATIONS, ...linksModule.migrations]);
const ok = <T extends object>(result: T | { error: string }): T => { assert.ok(!("error" in result), JSON.stringify(result)); return result as T; };
const signal = new AbortController().signal;

test("an address is kept in one form: no share tracking, no fragment, one way to write a YouTube video", () => {
  assert.equal(normalizeUrl("Example.com/a?utm_source=x&id=7#top"), "https://example.com/a?id=7");
  assert.equal(normalizeUrl("https://example.com/"), "https://example.com");
  assert.equal(normalizeUrl("https://youtu.be/dQw4w9WgXcQ?si=abc&t=42"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42");
  assert.equal(normalizeUrl("https://m.youtube.com/shorts/dQw4w9WgXcQ"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  // A parameter that is not known tracking is kept: some sites need theirs to open the page at all.
  assert.equal(normalizeUrl("https://www.xiaohongshu.com/explore/65a1?xsec_token=AB&share_source=copy"), "https://www.xiaohongshu.com/explore/65a1?xsec_token=AB");
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "localhost", "http://user:pw@example.com", "not an address"]) assert.throws(() => normalizeUrl(bad), /address/, bad);

  assert.deepEqual(findUrl("【手冲参数】 https://b23.tv/abc123，复制打开"), { url: "https://b23.tv/abc123", rest: "【手冲参数】，复制打开" });
  assert.deepEqual(findUrl("github.com/sqlite/sqlite"), { url: "https://github.com/sqlite/sqlite", rest: "" });
  assert.equal(findUrl("just some words"), null);

  const kinds = (url: string) => { const { platform, type } = classify(url); return `${platform}/${type}`; };
  assert.deepEqual(["https://www.youtube.com/watch?v=x", "https://www.bilibili.com/video/BV1", "https://www.bilibili.com/read/cv1", "https://www.xiaohongshu.com/explore/1",
    "https://github.com/a/b", "https://github.com/a/b/issues/3", "https://arxiv.org/abs/2401.1", "https://mp.weixin.qq.com/s/abc", "https://example.com/post", "https://example.com/paper.pdf"].map(kinds),
  ["youtube/video", "bilibili/video", "bilibili/article", "xiaohongshu/post", "github/repo", "github/doc", "arxiv/doc", "wechat/article", "web/article", "web/doc"]);
  assert.equal(nameFromUrl("https://leetcode.com/problems/two-sum"), "leetcode.com · two sum");
  assert.equal(nameFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "youtube.com · watch");
});

test("a world starts with a few places; they are the user's to rename, reorder, remove and add to", () => {
  const w = world();
  assert.deepEqual(listPlaces(w).map((place) => place.title), ["Google", "Gmail", "YouTube"]);
  const canvas = ok(pinPlace(w, { url: "canvas.cmu.edu", title: "Canvas" }));
  assert.equal(canvas.existing, false);
  assert.equal(ok(pinPlace(w, { url: "https://canvas.cmu.edu/" })).existing, true, "the same address is the same place");
  assert.equal(ok(pinPlace(w, { url: "https://github.com" })).place.title, "Github", "a name from the address when none is given");
  const [google, gmail] = listPlaces(w);
  invokeOp(w, [linksModule], { op: "link.rename", requestId: "r1", input: { id: gmail.id, title: "Mail" } });
  invokeOp(w, [linksModule], { op: "link.order", requestId: "r2", input: { ids: [canvas.place.id, gmail.id] } });
  invokeOp(w, [linksModule], { op: "link.remove", requestId: "r3", input: { id: google.id } });
  assert.deepEqual(listPlaces(w).map((place) => place.title), ["Canvas", "Mail", "YouTube", "Github"]);
  assert.deepEqual(listEvents(w).events.map((event) => event.kind), ["link.pinned", "link.pinned", "link.renamed", "link.places_ordered", "link.removed"]);
});

test("a saved address is a clip: told what it is from the address, saved once, filed, and waiting to be looked up", () => {
  const w = world();
  const first = ok(saveClip(w, { url: "https://youtu.be/dQw4w9WgXcQ?si=share", note: "  for the weekend ", topic: "Cooking", area: "life" }));
  assert.deepEqual([first.clip.platform, first.clip.type, first.clip.state, first.clip.fetch, first.clip.note, first.clip.titleSource],
    ["youtube", "video", "unread", "pending", "for the weekend", "url"]);
  const [cooking] = listTopics(w);
  assert.deepEqual(cooking, { id: cooking.id, name: "Cooking", area: "life" });
  // The same video, written another way: the same clip. A topic of the same name in another case is the same topic.
  const again = ok(saveClip(w, { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share", topic: "cooking" }));
  assert.deepEqual([again.existing, again.clip.id, again.clip.note], [true, first.clip.id, "for the weekend"]);
  assert.equal(listTopics(w).length, 1);
  // A second save may add what was missing, and never replaces what is there.
  const bare = ok(saveClip(w, { url: "https://example.com/essay" }));
  const filled = ok(saveClip(w, { url: "https://example.com/essay", note: "read on the train", topicId: cooking.id }));
  assert.deepEqual([filled.clip.note, filled.clip.topicId, filled.clip.id], ["read on the train", cooking.id, bare.clip.id]);
  assert.equal(ok(saveClip(w, { url: "https://example.com/essay", note: "another reason" })).clip.note, "read on the train");

  assert.deepEqual(saveClip(w, { url: "ftp://example.com/x" }), { error: "Only http and https addresses can be saved" });
  assert.deepEqual(saveClip(w, { url: "https://example.com/y", topic: "New", area: "nowhere" }), { error: "area must be one of: work, life, learn, travel, health, money, people" });
  assert.equal(listClips(w).length, 2, "a refused save leaves nothing behind");

  // Filing, marking and unfiling.
  const moved = ok(updateClip(w, bare.clip.id, { topic: "Essays", state: "todo", note: "" }));
  assert.deepEqual([listTopics(w).map((topic) => topic.name), moved.state, moved.note], [["Cooking", "Essays"], "todo", undefined]);
  assert.equal(ok(updateClip(w, bare.clip.id, { topicId: "" })).topicId, undefined);
  invokeOp(w, [linksModule], { op: "link.topic", requestId: "t1", input: { id: cooking.id, name: "Food" } });
  assert.deepEqual(invokeOp(w, [linksModule], { op: "link.topic", requestId: "t2", input: { id: cooking.id, name: "essays" } }).result, { error: 'There is already a topic named "essays".' });
  invokeOp(w, [linksModule], { op: "link.topic", requestId: "t3", input: { id: cooking.id, remove: true } });
  assert.equal(listClips(w).find((clip) => clip.id === first.clip.id)!.topicId, undefined, "removing a topic unfiles what was in it");
  ok(removeLink(w, first.clip.id));
  assert.equal(listClips(w).length, 1);
});

test("looking a page up fills in what the page says of itself, keeps a given title, and follows a share link to its page", async () => {
  const w = world();
  const pages: Record<string, ReturnType<PageFetcher>> = {
    "https://example.com/essay": Promise.resolve({ url: "https://example.com/essay", title: "On Density", site: "Example Review", author: "A. Writer", description: "Why density is not clutter." }),
    "https://b23.tv/abc123": Promise.resolve({ url: "https://www.bilibili.com/video/BV1xx411c7mD?share_source=copy_web", title: "V60 冲煮" }),
    "https://example.com/named": Promise.resolve({ url: "https://example.com/named", title: "The Page's Own Title" }),
    "https://example.com/wall": Promise.resolve({ url: "https://example.com/wall" }),
    "https://example.com/gone": Promise.reject(new PageFetchError("status", "The site answered 404")),
    "https://example.com/slow": Promise.reject(new PageFetchError("timeout", "The page took too long")),
  };
  for (const promise of Object.values(pages)) promise.catch(() => {});
  const module = createLinksModule({ fetcher: (url) => pages[url] ?? Promise.reject(new Error(`unexpected ${url}`)), icons: async () => null });
  for (const url of Object.keys(pages)) ok(saveClip(w, { url, ...(url.endsWith("/named") ? { title: "My name for it" } : {}) }));
  assert.equal(pendingClips(w).length, 6);
  await module.sync!.run(w, {}, signal);

  const by = (end: string) => listClips(w).find((clip) => clip.url.includes(end))!;
  assert.deepEqual([by("/essay").title, by("/essay").titleSource, by("/essay").site, by("/essay").author, by("/essay").description, by("/essay").fetch],
    ["On Density", "page", "Example Review", "A. Writer", "Why density is not clutter.", "done"]);
  assert.deepEqual([by("BV1xx").url, by("BV1xx").platform, by("BV1xx").type, by("BV1xx").title], ["https://www.bilibili.com/video/BV1xx411c7mD", "bilibili", "video", "V60 冲煮"]);
  assert.deepEqual([by("/named").title, by("/named").titleSource], ["My name for it", "given"]);
  assert.deepEqual([by("/wall").title, by("/wall").fetch], ["example.com · wall", "done"], "a page that gives no usable title keeps the name from its address");
  assert.deepEqual([by("/gone").fetch, by("/gone").fetchError], ["failed", "status"]);
  // A timeout is tried again on later passes, three times in all.
  assert.equal(by("/slow").fetch, "pending");
  await module.sync!.run(w, {}, signal);
  await module.sync!.run(w, {}, signal);
  assert.deepEqual([by("/slow").fetch, pendingClips(w).length], ["failed", 0]);
  // Asking again starts over.
  invokeOp(w, [module], { op: "link.refetch", requestId: "f1", input: { id: by("/gone").id } });
  assert.equal(by("/gone").fetch, "pending");
  // A share link whose page is already saved stays as it is instead of becoming a second copy of it.
  const short = ok(saveClip(w, { url: "https://b23.tv/other" }));
  recordPage(w, short.clip.id, { url: "https://www.bilibili.com/video/BV1xx411c7mD", title: "V60 冲煮" });
  assert.equal(listClips(w).find((clip) => clip.id === short.clip.id)!.url, "https://b23.tv/other");
});

test("Alfred saves, files, pins and lists through its tools; deleting asks first; the snapshot says what Alfred did", () => {
  const w = world();
  const tools = runTools(w, [linksModule]);
  const call = (name: string, params: Record<string, unknown>) => withCoreContext({ actor: "alfred" }, () => String(tools.find((tool) => tool.name === name)!.execute(params, signal)));
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["link_list", "link_pin", "link_remove", "link_save", "link_update"]);
  assert.match(call("link_save", { url: "arxiv.org/abs/2401.00001", note: "for the RAG notes", topic: "RAG", area: "learn" }), /^Saved: \S+ {2}arxiv\.org · 2401\.00001 \| doc on arxiv \| topic: RAG \| unread \| note: for the RAG notes \| https:\/\/arxiv\.org\/abs\/2401\.00001$/);
  assert.match(call("link_save", { url: "https://arxiv.org/abs/2401.00001" }), /^Already saved/);
  assert.match(call("link_pin", { url: "canvas.cmu.edu", title: "Canvas" }), /^Pinned: Canvas/);
  ok(saveClip(w, { url: "https://example.com/coffee", note: "water temperature" }));

  const listed = call("link_list", {});
  assert.match(listed, /Places: Google \(place-1\), Gmail .*Canvas/);
  assert.match(listed, /Topics: RAG \[learn\]\./);
  assert.match(call("link_list", { search: "water" }), /Clips \(1\):\n\S+ {2}example\.com · coffee/);
  assert.match(call("link_list", { topic: "rag", state: "unread" }), /Clips \(1\)/);
  assert.match(call("link_list", { topic: "Nope" }), /No topic named "Nope"\. Topics: RAG\./);

  const [coffee, paper] = listClips(w);
  assert.match(call("link_update", { id: coffee.id, topic: "Coffee", area: "life", state: "todo" }), /topic: Coffee \| todo/);
  assert.match(call("link_update", { id: "nope", state: "seen" }), /No saved link with id "nope"/);
  const remove = tools.find((tool) => tool.name === "link_remove")!;
  assert.equal(remove.permission!({ id: paper.id }), "Delete the link “arxiv.org · 2401.00001” for good? This can't be undone.");

  const snapshot = linksModule.snapshot!(w) as LinksSnapshot;
  assert.deepEqual(snapshot.clips.map((clip) => [clip.title, clip.byAlfred ?? false]), [["example.com · coffee", true], ["arxiv.org · 2401.00001", true]]);
  assert.deepEqual(snapshot.topics.map((topic) => topic.name), ["RAG", "Coffee"]);
});

test("a site's own icon is kept once per host and shown from there; a site without one is not asked again for a week", async () => {
  const w = world();
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3, 4]);
  const asked: string[] = [];
  const module = createLinksModule({
    fetcher: async (url) => (url.includes("example.com") ? { url, title: "An essay", icons: ["https://example.com/touch.png"] } : { url }),
    icons: async (pageUrl, candidates) => {
      asked.push(`${new URL(pageUrl).hostname} ${candidates.join(",")}`);
      return /google\.com|example\.com/.test(pageUrl) ? { type: "image/png", bytes: PNG } : null;
    },
  });
  ok(saveClip(w, { url: "https://example.com/essay" }));
  ok(saveClip(w, { url: "https://example.com/another" }));
  await module.sync!.run(w, {}, signal);
  // One question per host: the page's own candidate for the clips' site, nothing to go on for the places.
  assert.deepEqual(asked.sort(), ["example.com https://example.com/touch.png", "mail.google.com ", "www.google.com ", "www.youtube.com "]);
  const snapshot = module.snapshot!(w) as LinksSnapshot;
  assert.deepEqual(snapshot.places.map((place) => place.icon), ["www.google.com", "mail.google.com", undefined]);
  assert.deepEqual(snapshot.clips.map((clip) => clip.icon), ["example.com", "example.com"]);
  assert.deepEqual(module.file!(w, "example.com"), { type: "image/png", bytes: PNG });
  assert.equal(module.file!(w, "www.youtube.com"), null);
  assert.equal(getIcon(w, "nowhere.example"), null);
  // Nothing is asked twice now; a site that had none is asked again after a week.
  assert.deepEqual(iconsToFetch(w), []);
  assert.deepEqual(iconsToFetch(w, 8, Date.now() + 8 * 86_400_000).map((entry) => entry.host), ["www.youtube.com"]);
  assert.equal(listEvents(w).events.filter((event) => event.kind === "link.icons").length, 1, "devices are told once that icons arrived");
});

test("previously saved videos acquire local covers without replacing their metadata, and removing the clip removes its image", async () => {
  const w = world();
  const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const { clip } = ok(saveClip(w, { url, title: "My saved talk" }));
  recordPage(w, clip.id, { url, site: "YouTube", author: "My channel" });
  ok(updateClip(w, clip.id, { state: "seen", note: "For Tuesday" }));
  let downloads = 0;
  const image = { type: "image/jpeg", bytes: new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1]) };
  const thumbnail = "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg";
  const module = createLinksModule({
    fetcher: async (href) => href === url ? { url, cover: thumbnail, title: "Updated title", durationSeconds: 814 } : { url: href },
    covers: async (href) => { assert.equal(href, thumbnail); downloads++; return image; },
    icons: async () => null,
  });
  await module.sync!.run(w, {}, signal);
  await module.sync!.run(w, {}, signal);
  const [saved] = listClips(w);
  assert.equal(downloads, 1);
  assert.deepEqual([saved.title, saved.author, saved.state, saved.note], ["My saved talk", "My channel", "seen", "For Tuesday"]);
  assert.equal(saved.durationSeconds, 814);
  assert.equal(saved.cover, `cover_${clip.id}`);
  assert.deepEqual(module.file!(w, saved.cover!), image);
  ok(removeLink(w, clip.id));
  assert.equal(module.file!(w, saved.cover!), null);
});

test("a Xiaohongshu note keeps its own cover and is a video when its page says so; an article's banner is not kept", async () => {
  const w = world();
  const pictures = "https://www.xiaohongshu.com/explore/aa?xsec_token=A", film = "https://www.xiaohongshu.com/explore/bb?xsec_token=B", article = "https://example.com/essay";
  for (const url of [pictures, film, article]) ok(saveClip(w, { url }));
  const image = { type: "image/jpeg", bytes: new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1]) };
  const asked: string[] = [];
  const module = createLinksModule({
    fetcher: async (href) => ({ url: href, title: `page ${href.slice(-1)}`, cover: `${href}#cover`, ...(href === film ? { video: true as const } : {}) }),
    covers: async (href) => { asked.push(href); return image; },
    icons: async () => null,
  });
  await module.sync!.run(w, {}, signal);
  const by = (url: string) => listClips(w).find((clip) => clip.url === url)!;
  assert.deepEqual([by(pictures).type, by(film).type, by(article).type], ["post", "video", "article"]);
  assert.ok(by(pictures).cover && by(film).cover);
  assert.equal(by(article).cover, undefined);
  assert.deepEqual(asked.sort(), [`${pictures}#cover`, `${film}#cover`]);
});
