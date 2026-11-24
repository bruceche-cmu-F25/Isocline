import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_MIGRATIONS, openWorld } from "@zirma/core";
import { invokeOp } from "@zirma/module-kit";
import { classify, linksModule, listClips, MIGRATIONS, nameFromUrl, parseLinkPaste, recordPage, recordPageFailure, saveClip, updateClip, type LinksSnapshot } from "../src/index.ts";

const bili = "https://www.bilibili.com/video/BV1KoW16NEBf";
const xhs = "http://xhslink.com/o/8LS7KAWdiJU";
const title = "[Agent记忆] Anthropic公开Claude记忆架构：用Dreaming回查记录，修正笔记并整理知识页";
const ok = <T extends object>(result: T | { error: string }): T => { assert.ok(!("error" in result)); return result as T; };

test("a pasted share distinguishes its platform-supplied title from personal notes", () => {
  assert.deepEqual(parseLinkPaste(`[${title}-bilibili] ${bili}`), { url: bili, title });
  assert.deepEqual(parseLinkPaste(`我的 [项目] 资料 【${title}-哔哩哔哩】 ${bili} 周五再看`), { url: bili, title, note: "我的 [项目] 资料 周五再看" });
  assert.deepEqual(parseLinkPaste(`【一次散步-哔哩哔哩】 ${bili}。`), { url: bili, title: "一次散步" });
  assert.deepEqual(parseLinkPaste(`37 【散步 - 看海 - 作者 | 小红书 - 你的生活兴趣社区】 😆 XaC032u9 😆 ${xhs}，复制本条信息，打开【小红书】App查看精彩内容！ 明天去`),
    { url: xhs, title: "散步 - 看海", note: "明天去" });
  assert.deepEqual(parseLinkPaste(`【散步 - 小红书】 ${xhs}`), { url: xhs, title: "散步" });
  for (const url of [bili, xhs]) {
    assert.deepEqual(parseLinkPaste(url), { url });
    assert.deepEqual(parseLinkPaste(`【我自己的备注】 ${url}`), { url, note: "【我自己的备注】" });
  }
  const caption = "我在阅读这篇笔记的时候，想到一个关于艺术实践的项目。".repeat(10);
  assert.deepEqual(parseLinkPaste(caption + " " + xhs), { url: xhs, note: caption });
  assert.equal(parseLinkPaste(`去复习 [${title}-bilibili] https://example.org/a`)?.title, undefined);
  assert.equal(nameFromUrl(bili), "bilibili.com");
  assert.equal(nameFromUrl(xhs), "xhslink.com");
  assert.equal(classify("https://www.rednote.com/explore/abc").platform, "xiaohongshu");
});

test("the same saved clip prefers a given title, then a public page title, then a recognized share", (t) => {
  const w = openWorld(":memory:", [...CORE_MIGRATIONS, ...MIGRATIONS]);
  t.after(() => w.close());
  assert.equal((linksModule.snapshot!(w) as LinksSnapshot).sharedTitles, true);
  const { clip } = ok(saveClip(w, { url: bili, note: "下周再看", topic: "读书会" }));
  const legacy = ok(saveClip(w, { url: "https://b23.tv/legacy", note: `[${title}-bilibili] 我的理由` })).clip;
  assert.deepEqual([legacy.title, legacy.titleSource, legacy.note], [title, "share", "我的理由"]);
  const named = ok(saveClip(w, { url: "https://b23.tv/named", title: "自取", note: `[${title}-bilibili] 我的理由` })).clip;
  assert.deepEqual([named.title, named.titleSource, named.note], ["自取", "given", "我的理由"]);
  invokeOp(w, [linksModule], { op: "link.save", requestId: "share1", input: { url: bili, sharedTitle: title } });
  const read = () => listClips(w).find(c => c.id === clip.id)!;
  assert.deepEqual([read().id, read().title, read().titleSource, read().note], [clip.id, title, "share", "下周再看"]);
  recordPageFailure(w, clip.id, "status", false);
  assert.equal(read().title, title);
  recordPage(w, clip.id, { url: bili, title: "页面原标题" });
  assert.deepEqual([read().title, read().titleSource], ["页面原标题", "page"]);
  ok(saveClip(w, { url: bili, sharedTitle: "转发时的标题" }));
  assert.equal(read().title, "页面原标题");
  ok(updateClip(w, clip.id, { title: "自取的标题", state: "seen" }));
  recordPage(w, clip.id, { url: bili, title: "站点更新" });
  assert.deepEqual([read().title, read().titleSource, read().note, read().state], ["自取的标题", "given", "下周再看", "seen"]);
});

test("upgrading existing shares preserves the watch list, genuine notes, manual titles and usable covers", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "alfred-link-title-upgrade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "world.sqlite");
  const old = openWorld(path, [...CORE_MIGRATIONS, ...MIGRATIONS.filter(m => m.id !== "link:5")]);
  const insert = old.db.prepare(`INSERT INTO link_items(id, kind, url, title, title_source, platform, type, site, note, state, saved_at, fetch)
    VALUES (?, 'clip', ?, ?, ?, ?, ?, 'site', ?, 'seen', '2026-01-01', 'done')`);
  insert.run("bili", bili, "bilibili.com · BV1KoW16NEBf", "url", "bilibili", "video", `[${title}-bilibili] 周末读`);
  insert.run("red", xhs, "xhslink.com · 8LS7KAWdiJU", "url", "xiaohongshu", "post", null);
  insert.run("given", "https://b23.tv/named", "自己取的标题", "given", "bilibili", "video", "解释为什么收藏");
  insert.run("page", "https://b23.tv/page", "页面的标题", "page", "bilibili", "video", "[从分享找到的名字-bilibili]");
  insert.run("web", "https://example.org/article", "example.org · article", "url", "web", "article", "普通备注");
  const saveCover = old.db.prepare("INSERT INTO link_covers(clip_id, bytes, checked_at) VALUES (?, ?, 1234)");
  saveCover.run("bili", null);
  saveCover.run("given", Buffer.of(33));
  old.close();

  const current = openWorld(path, [...CORE_MIGRATIONS, ...MIGRATIONS]);
  t.after(() => current.close());
  const by = (id: string) => listClips(current).find(c => c.id === id)!;
  const repaired = by("bili");
  assert.deepEqual([repaired.title, repaired.titleSource, repaired.note, repaired.state, repaired.url, repaired.fetch, repaired.savedAt],
    [title, "share", "周末读", "seen", bili, "pending", "2026-01-01"]);
  assert.deepEqual([by("red").title, by("red").note, by("red").url, by("red").fetch], ["xhslink.com", undefined, xhs, "pending"]);
  assert.deepEqual([by("given").title, by("given").note, by("given").fetch], ["自己取的标题", "解释为什么收藏", "done"]);
  assert.deepEqual([by("page").title, by("page").note, by("page").fetch], ["页面的标题", undefined, "done"]);
  assert.deepEqual([by("web").title, by("web").note, by("web").fetch], ["example.org · article", "普通备注", "done"]);
  assert.equal(current.db.prepare("SELECT checked_at FROM link_covers WHERE clip_id='bili'").get()?.checked_at, 0);
  assert.deepEqual([...current.db.prepare("SELECT bytes FROM link_covers WHERE clip_id='given'").get()!.bytes as Uint8Array], [33]);
});
