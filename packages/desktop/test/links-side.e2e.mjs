/** Run after npm run build:ui with Chrome installed: node packages/desktop/test/links-side.e2e.mjs
 * (ZIRMA_UI_DIR=<dir> to use another build; SHOTS=<dir> to keep screenshots). links.md §4.10.8: the category tree
 * lives in the app sidebar while it has room, and comes back into the page when it has none. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { listAreas, updateSettings } from "@zirma/core";
import { createLinksModule, ensureTopic, saveClip } from "@zirma/module-links";
import { createHttpServer, openHome } from "@zirma/server";

test("Links: the category tree moves into the sidebar, and back into the page without one", async (t) => {
  const browser = await chromium.launch({ channel: "chrome" });
  t.after(() => browser.close());
  const links = createLinksModule({ fetcher: async url => ({ url }), icons: async () => null, covers: async () => null });
  const dataDir = mkdtempSync(join(tmpdir(), "zirma-links-side-test-"));
  const home = openHome({ dataDir, modules: [links], engine: { submit: async () => assert.fail("Unexpected engine call") } });
  const uiDir = process.env.ZIRMA_UI_DIR ?? fileURLToPath(new URL("../../ui/dist", import.meta.url));
  const server = createHttpServer(home, { port: 0, uiDir });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    home.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const [first, second] = listAreas(home.world);
  const topic = (input) => { const made = ensureTopic(home.world, input); assert.ok(!("error" in made), made.error); return made; };
  const study = topic({ name: "Study", area: first.id });
  const roadmaps = topic({ name: "Roadmaps", parentId: study.id });
  const jobs = topic({ name: "Job hunt", area: second.id });
  for (const [id, title, topicId] of [["a", "System design roadmap", roadmaps.id], ["b", "AI engineer roadmap", roadmaps.id], ["c", "Interview notes", jobs.id], ["d", "A loose one", undefined]]) {
    saveClip(home.world, { url: `https://example.com/${id}`, title, ...(topicId ? { topicId } : {}) });
  }
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const shots = process.env.SHOTS;

  for (const locale of ["en", "zh"]) {
    updateSettings(home.world, { locale, firstRunAt: new Date().toISOString() });
    const page = await browser.newPage({ viewport: { width: 1180, height: 790 }, locale: locale === "en" ? "en-US" : "zh-CN" });
    page.setDefaultTimeout(5000);
    await page.goto(base + "/#p=link.list");

    // Wide: the tree is in the sidebar, none in the page.
    const side = page.locator(".side-host .lt-in-app");
    await side.waitFor();
    assert.equal(await page.locator(".links .lt").count(), 0, "no second tree inside the page");
    await page.locator(".side-back").waitFor();
    if (shots) await page.screenshot({ path: join(shots, `links-side-${locale}-first.png`) });
    // Laid out as Notes' tree: the new row first, then the fixed rows, then each area as a label, always open.
    assert.equal(await side.locator(".lt-node").first().getAttribute("class"), "lt-node lt-add");
    await side.locator(".lt-area").nth(0).waitFor();
    assert.equal(await side.locator(".lt-area .lt-twist").count(), 0, "an area does not fold");
    if (shots) await page.screenshot({ path: join(shots, `links-side-${locale}-wide.png`) });

    // Picking a category in the sidebar shows it in the page.
    await side.locator(".lt-node", { hasText: "Study" }).click();
    await side.locator(".lt-node", { hasText: "Roadmaps" }).click();
    await page.locator(".lk-crumbs", { hasText: "Roadmaps" }).waitFor();
    assert.equal(await page.locator(".lr-row").count(), 2);

    // Dragging a row onto a category in the sidebar files it there.
    await page.locator(".lr-row", { hasText: "AI engineer roadmap" }).dragTo(side.locator(".lt-node", { hasText: "Job hunt" }));
    await page.locator(".lr-row", { hasText: "AI engineer roadmap" }).waitFor({ state: "detached" });
    await side.locator(".lt-node", { hasText: "Job hunt" }).locator(".lt-count", { hasText: "2" }).waitFor({ state: "attached" });
    if (shots) await page.screenshot({ path: join(shots, `links-side-${locale}-moved.png`) });
    await side.locator(".lt-node", { hasText: "Job hunt" }).click();
    await page.locator(".lr-row", { hasText: "AI engineer roadmap" }).dragTo(side.locator(".lt-node", { hasText: "Roadmaps" }));
    await page.locator(".lr-row", { hasText: "AI engineer roadmap" }).waitFor({ state: "detached" });

    // No overlapping text in the sidebar tree.
    const overlaps = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll(".side-host .lt-name, .side-host .lt-count, .side-back span")].map((el) => el.getBoundingClientRect()).filter((box) => box.width && box.height);
      let hits = 0;
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) hits++;
      }
      return hits;
    });
    assert.equal(overlaps, 0);

    // Back to the pages list, then the open page's row: its tree comes back.
    await page.locator(".side-back").click();
    await page.locator(".side-views:not([data-swap])").waitFor();
    await page.locator('.side-nav [data-page="link.list"]').click();
    await page.locator(".side-views[data-swap]").waitFor();
    await side.waitFor();

    if (shots) {
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: join(shots, `links-side-${locale}-dark.png`) });
      await page.emulateMedia({ colorScheme: "light" });
    }

    // Sidebar folded away: the tree comes back into the page.
    await page.keyboard.press("Meta+Backslash");
    await page.locator(".links .lt:not(.lt-in-app)").waitFor();
    if (shots) await page.screenshot({ path: join(shots, `links-side-${locale}-folded.png`) });
    await page.keyboard.press("Meta+Backslash");
    await page.locator(".links .lt").waitFor({ state: "detached" });

    // A narrow page beside the sidebar: the tree stays in the sidebar, and the page does not tap in.
    await page.setViewportSize({ width: 880, height: 790 });
    await page.locator(".links[data-narrow]").waitFor();
    await side.waitFor();
    assert.equal(await page.locator(".lk-back").count(), 0);
    if (shots) await page.screenshot({ path: join(shots, `links-side-${locale}-mid.png`) });

    // Phone width: no sidebar, so the page taps in, as before.
    await page.setViewportSize({ width: 390, height: 800 });
    await page.locator(".links[data-narrow]").waitFor();
    assert.equal(await page.locator(".links .lt").count(), 0, "a narrow page has no tree column");
    await page.locator(".lk-back").waitFor();
    if (shots) await page.screenshot({ path: join(shots, `links-side-${locale}-phone.png`) });
    await page.close();
  }
});
