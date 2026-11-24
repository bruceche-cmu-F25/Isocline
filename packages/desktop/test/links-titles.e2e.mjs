/** After npm run build:ui, run with node packages/desktop/test/links-titles.e2e.mjs and Chrome installed. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { updateSettings } from "@isocline/core";
import { createLinksModule, PageFetchError, saveClip } from "@isocline/module-links";
import { createHttpServer, openHome } from "@isocline/server";

test("a phone keeps shared titles and personal notes distinct, and can name a sign-in-only post", async (t) => {
  const browser = await chromium.launch({ channel: "chrome" });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
  page.setDefaultTimeout(6000);
  const links = createLinksModule({
    fetcher: async (url) => {
      if (url.includes("xhslink.com")) throw new PageFetchError("login", "Sign-in required");
      return { url };
    },
    icons: async () => null,
    covers: async () => null,
  });
  const dataDir = mkdtempSync(join(tmpdir(), "alfred-mobile-titles-"));
  const home = openHome({ dataDir, modules: [links], engine: { submit: async () => assert.fail("Unexpected engine call") } });
  const server = createHttpServer(home, { port: 0, uiDir: fileURLToPath(new URL("../../ui/dist", import.meta.url)) });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    home.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  updateSettings(home.world, { locale: "en", firstRunAt: new Date().toISOString() });
  const note = "下周讨论时再看";
  saveClip(home.world, { url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", title: "Short title", note });
  saveClip(home.world, { url: "https://xhslink.com/o/SampleShortCode" });
  await links.sync.run(home.world, {}, new AbortController().signal);
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  await page.goto(`http://127.0.0.1:${server.address().port}/#p=link.list`);

  const title = "[Agent记忆] 一个很长的视频标题：如何回查记录，修正笔记并整理知识页";
  const form = page.locator(".lk-save form");
  await form.getByRole("textbox").fill(`[${title}-bilibili] https://www.bilibili.com/video/BV1KoW16NEBf/`);
  await form.getByRole("button", { name: "Save", exact: true }).click();
  const shelf = page.locator(".lk-shelf");
  await shelf.locator(".lk-title").filter({ hasText: title }).waitFor();
  assert.doesNotMatch(await shelf.innerText(), /BV1KoW16NEBf|No title found|-bilibili\]/i);
  assert.equal(await shelf.getByText(title, { exact: true }).count(), 1);
  const boxes = await shelf.locator(".lk-card").evaluateAll(cards => cards.map(card => {
    const rect = card.getBoundingClientRect();
    const state = card.querySelector(".lk-state").getBoundingClientRect();
    return { y: rect.y, bottom: rect.bottom, state: state.bottom };
  }));
  assert.equal(boxes.length, 2);
  for (const edge of ["y", "bottom", "state"]) assert.ok(Math.abs(boxes[0][edge] - boxes[1][edge]) < 2, `Cards align at ${edge}`);
  await shelf.locator(".lk-main").filter({ hasText: "Short title" }).click();
  await shelf.getByText(note, { exact: true }).waitFor();

  const post = page.locator(".lk-card").filter({ hasText: /xiaohongshu/i });
  assert.doesNotMatch(await post.innerText(), /SampleShortCode|xhslink\.com|behind a sign-in/i);
  await post.locator(".lk-main").click();
  await post.getByRole("button", { name: /add title/i }).click();
  const titleField = post.getByRole("textbox");
  await titleField.fill("我的小红书笔记");
  await titleField.press("Enter");
  await page.locator(".lk-title").filter({ hasText: "我的小红书笔记" }).waitFor();
  await page.reload();
  await page.locator(".lk-title").filter({ hasText: "我的小红书笔记" }).waitFor();
  assert.equal(await page.locator("main").evaluate(main => main.scrollWidth <= main.clientWidth), true);
});
