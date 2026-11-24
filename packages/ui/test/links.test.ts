import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clip } from "@isocline/module-links/types";
import { parseLinkPaste } from "@isocline/module-links/url";
import { legacyShareClip, linkSaveFields } from "../src/linkShareCompat.ts";
import { clipSections } from "../src/clipSections.ts";
import { linkParts } from "../src/links.ts";
import { startLayout } from "../src/shell/layout.ts";

const links = (text: string) => linkParts(text).filter((part) => typeof part !== "string").map((part) => (part as { url: string }).url);

test("web addresses in text become links, and the text around them stays as written", () => {
  assert.deepEqual(linkParts("Pay the rent at https://bank.example.com/pay today"), [
    "Pay the rent at ", { url: "https://bank.example.com/pay", text: "https://bank.example.com/pay" }, " today",
  ]);
  assert.deepEqual(linkParts("no address here"), ["no address here"]);
  assert.deepEqual(linkParts(""), []);
  assert.deepEqual(linkParts("www.example.com"), [{ url: "https://www.example.com/", text: "www.example.com" }]);
  assert.deepEqual(links("two: http://a.example/x and https://b.example/y?q=1&r=2#top"), ["http://a.example/x", "https://b.example/y?q=1&r=2#top"]);
});

test("what ends the sentence is not part of the address", () => {
  assert.deepEqual(links("See https://example.com/a."), ["https://example.com/a"]);
  assert.deepEqual(links("(details: https://example.com/a)"), ["https://example.com/a"]);
  assert.deepEqual(links("https://en.wikipedia.org/wiki/Tesseract_(disambiguation)"), ["https://en.wikipedia.org/wiki/Tesseract_(disambiguation)"]);
  assert.deepEqual(links("会议链接：https://zoom.us/j/123456，记得提前五分钟。"), ["https://zoom.us/j/123456"]);
  assert.deepEqual(links("在「https://example.com/页面」里"), ["https://example.com/%E9%A1%B5%E9%9D%A2"]);
});

test("only web addresses are linked", () => {
  assert.deepEqual(links("javascript:alert(1) file:///etc/passwd mailto:a@b.co ana@www.example.com"), []);
  assert.deepEqual(links("http:// and https://"), []);
});

test("the workspace always opens with Isocline's panel closed, and keeps the sidebar as it was left", () => {
  assert.equal(startLayout(null, 1400).alfred, "closed");
  const left = startLayout(JSON.stringify({ nav: "rail", navW: 250, alfW: 500, alfred: "open", v: 2 }), 1400);
  assert.deepEqual(left, { nav: "hidden", navW: 250, alfW: 500, alfred: "closed" });
  assert.equal(startLayout("not json", 800).nav, "hidden");
  assert.equal(startLayout("not json", 1000).nav, "full");
});

test("a first video stays in just saved, a watch shelf never duplicates clips, and filters apply to every section", () => {
  const now = Date.now();
  const clip = (id: string, type: Clip["type"], state: Clip["state"] = "unread"): Clip => ({
    id, url: "https://example.com/" + id, title: id, titleSource: "page", platform: "web", type, site: "Example",
    state, savedAt: new Date(now).toISOString(), fetch: "done",
  });
  const a = clip("a", "video"), b = clip("b", "video"), post = clip("post", "post"), done = clip("done", "video", "seen");
  assert.deepEqual(clipSections([a], "all", "all", now), { recent: [a], filed: [], shelf: [] });
  assert.deepEqual(clipSections([a, b, post, done], "all", "all", now), { recent: [post], filed: [done], shelf: [a, b] });
  assert.deepEqual(clipSections([a, b, post, done], "post", "all", now), { recent: [post], filed: [], shelf: [] });
  assert.deepEqual(clipSections([a, b, post, done], "video", "seen", now), { recent: [], filed: [done], shelf: [] });
});

test("a new window can save and read platform shares on an older home without overriding editorial titles or losing notes", () => {
  const url = "https://www.bilibili.com/video/BV1KoW16NEBf/";
  const note = "下周讨论";
  const draft = `【[Agent 记忆] 工作流-bilibili】 ${url} ${note}`;
  const found = parseLinkPaste(draft)!;
  assert.deepEqual(linkSaveFields(draft, found, true), { url, sharedTitle: "[Agent 记忆] 工作流", note });
  const legacy = linkSaveFields(draft, found);
  assert.deepEqual(legacy, { url, note: `【[Agent 记忆] 工作流-bilibili】 ${note}` });
  const clip: Clip = { id: "a", url, type: "video", platform: "bilibili", site: "bilibili.com", title: "BV1KoW16NEBf",
    note: legacy.note, titleSource: "url", state: "unread", savedAt: "", fetch: "failed" };
  assert.deepEqual(legacyShareClip(clip), { ...clip, titleSource: "share", title: found.title, note });
  for (const titleSource of ["given", "page"] as const) {
    const renamed = { ...clip, title: "有意义的标题", titleSource };
    assert.deepEqual(legacyShareClip(renamed), { ...renamed, note });
  }
  assert.equal(legacyShareClip({ ...clip, note: "下周讨论" }).note, note);
  assert.equal(legacyShareClip({ ...clip, note: "【[Agent 记忆] 工作流-bilibili】" }).note, undefined);
});
