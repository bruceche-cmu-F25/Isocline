/** Run after npm run build:ui with Chrome installed: node packages/desktop/test/notes-page.e2e.mjs
 * (ZIRMA_UI_DIR=<dir> to use another build; SHOTS=<dir> to keep screenshots). notes.md 4.5: a page in the tree is
 * dragged to its place: on another's top or bottom edge it goes before or after it, on its middle inside it. And the
 * page says each thing once: the path above names only the pages above, the pages under it sit under its title, one
 * New page button. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { updateSettings } from "@zirma/core";
import { createNotesModule } from "@zirma/module-notes";
import { createHttpServer, openHome } from "@zirma/server";

const PAGES = ["Apple", "Banana", "Cherry"];

for (const locale of ["en", "zh"]) {
  test(`Notes (${locale}): pages are dragged into another order and into another page; the page says each thing once`, async (t) => {
    const browser = await chromium.launch({ channel: "chrome" });
    t.after(() => browser.close());
    const dataDir = mkdtempSync(join(tmpdir(), "zirma-notes-page-test-"));
    const root = join(dataDir, "Notes");
    const notes = createNotesModule({ defaultRoot: root });
    const home = openHome({ dataDir, modules: [notes], engine: { submit: async () => assert.fail("Unexpected engine call") } });
    const uiDir = process.env.ZIRMA_UI_DIR ?? fileURLToPath(new URL("../../ui/dist", import.meta.url));
    const server = createHttpServer(home, { port: 0, uiDir });
    t.after(async () => {
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      home.close();
      rmSync(dataDir, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let n = 0;
    const op = async (name, input) => {
      const response = await fetch(`${base}/api/ops/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: `seed-${++n}`, input }) });
      const answer = (await response.json()).result;
      assert.ok(answer?.id, `${name}: ${JSON.stringify(answer)}`);
      return answer;
    };
    for (const title of PAGES) await op("note.create", { title });
    await op("note.create", { parent: "Apple", title: "Seed" });
    updateSettings(home.world, { locale, firstRunAt: new Date().toISOString() });
    const shots = process.env.SHOTS;

    const page = await browser.newPage({ viewport: { width: 1180, height: 790 }, locale: locale === "en" ? "en-US" : "zh-CN" });
    page.setDefaultTimeout(5000);
    await page.goto(base + "/#p=note.list");
    const side = page.locator(".side-host .nt-in-app");
    const row = (name) => side.locator(".nt-node", { has: page.locator(".nt-name", { hasText: new RegExp(`^${name}$`) }) });
    // The user's pages at the top of the tree, in the order shown.
    const top = () => side.locator(".nt-side-scroll > [role=treeitem] > .nt-node .nt-name").allTextContents().then((names) => names.filter((name) => PAGES.includes(name)));
    // The order shown, once the page list has caught up (it is refreshed from the home node after each change).
    const order = async (expected, message) => {
      const until = Date.now() + 4000;
      let shown = await top();
      while (JSON.stringify(shown) !== JSON.stringify(expected) && Date.now() < until) { await page.waitForTimeout(50); shown = await top(); }
      assert.deepEqual(shown, expected, message);
    };
    const drag = async (from, to, where) => {
      const box = await row(to).boundingBox();
      const y = box.y + (where === "before" ? 3 : where === "after" ? box.height - 3 : box.height / 2);
      const start = await row(from).boundingBox();
      await page.mouse.move(start.x + 40, start.y + start.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 60, y, { steps: 6 });
      await page.mouse.move(box.x + 62, y, { steps: 2 });
      return async () => page.mouse.up();
    };
    await row("Cherry").waitFor();
    assert.deepEqual(await top(), PAGES, "never dragged: by name");
    // Recent: grouped by day, one line a page, the page it is in before its name; icon, name and time on one line.
    await page.locator(".nt-row").first().waitFor();
    assert.deepEqual(await page.locator(".nt-day h3").allTextContents(), [locale === "en" ? "Today" : "今天"]);
    assert.equal(await page.locator(".nt-row", { hasText: "Seed" }).locator(".nt-row-name").textContent(), "Apple/Seed");
    assert.equal(await page.locator(".nt-row", { hasText: "Seed" }).locator(".nt-row-path").textContent(), "Apple/", "the page it is in, then a slash");
    const lines = await page.locator(".nt-row").evaluateAll((rows) => rows.map((one) => {
      const middle = (node) => { const box = node.getBoundingClientRect(); return box.top + box.height / 2; };
      const name = middle(one.querySelector(".nt-row-name"));
      return { height: one.getBoundingClientRect().height, off: Math.max(Math.abs(middle(one.querySelector(".nt-glyph")) - name), Math.abs(middle(one.querySelector(".nt-row-when")) - name)) };
    }));
    assert.ok(lines.every((line) => line.height <= 40 && line.off <= 1.5), `one line a page, icon and time on the name's line: ${JSON.stringify(lines)}`);

    // Cherry onto Apple's top edge: before it. A line shows where it goes.
    const letGo = await drag("Cherry", "Apple", "before");
    await side.locator('.nt-node[data-drop="before"]').waitFor();
    assert.equal(await row("Cherry").getAttribute("data-held"), "true");
    if (shots) await page.screenshot({ path: join(shots, `notes-page-${locale}-line.png`) });
    await letGo();
    await order(["Cherry", "Apple", "Banana"]);
    await page.waitForTimeout(300);
    await page.reload();
    await row("Cherry").waitFor();
    assert.deepEqual(await top(), ["Cherry", "Apple", "Banana"], "the home node keeps the order");

    // Banana onto Apple's bottom edge: after it, still at the top.
    await (await drag("Banana", "Apple", "after"))();
    await order(["Cherry", "Apple", "Banana"]);
    await (await drag("Banana", "Cherry", "after"))();
    await order(["Cherry", "Banana", "Apple"]);

    // Apple cannot go into a page under it.
    await row("Apple").locator(".nt-tw").click();
    await row("Seed").waitFor();
    await drag("Apple", "Seed", "inside");
    assert.equal(await side.locator(".nt-node[data-drop]").count(), 0, "no place to drop inside itself");
    await page.mouse.up();

    // Banana onto Cherry's middle: inside it. The file moves, Cherry opens to show it.
    const into = await drag("Banana", "Cherry", "inside");
    await side.locator('.nt-node[data-drop="inside"]').waitFor();
    if (shots) await page.screenshot({ path: join(shots, `notes-page-${locale}-inside.png`) });
    await into();
    await page.getByText(locale === "en" ? "Moved under “Cherry”" : "移到了「Cherry」下面").waitFor();
    await order(["Cherry", "Apple"]);
    assert.equal(await row("Banana").evaluate((node) => getComputedStyle(node).getPropertyValue("--d").trim()), "1", "one level in");
    assert.ok(existsSync(join(root, "Cherry", "Banana.md")), "the file moved into Cherry's folder");
    if (shots) await page.screenshot({ path: join(shots, `notes-page-${locale}-moved.png`) });

    // Recent: the tree has the New page row, so the page has no second one; no path above.
    assert.equal(await page.locator(".nt-recent-head .nt-btn").isVisible(), false, "one New page button");
    assert.equal(await page.locator(".nt-crumb").count(), 0);
    // A top-level page: no path above (its name is its title), the pages under it right under the title.
    await row("Cherry").locator(".nt-node-main").click();
    await page.locator(".nt-kid", { hasText: "Banana" }).waitFor();
    assert.equal(await page.locator(".nt-crumb").count(), 0, "a top-level page has nothing above it");
    const [chip, words] = await Promise.all([page.locator(".nt-kid").first().boundingBox(), page.locator(".nt-doc").boundingBox()]);
    assert.ok(chip.y < words.y, "the pages under it come before its words");
    // A page under it: the path names the page above, not this one.
    await page.locator(".nt-kid", { hasText: "Banana" }).click();
    await page.locator(".nt-crumb").first().waitFor();
    assert.deepEqual(await page.locator(".nt-crumb").allTextContents(), ["Cherry"]);
    // The history and ⋯ buttons end at the page's right edge, not the window's.
    const [more, column] = await Promise.all([page.getByRole("button", { name: locale === "en" ? "More" : "更多" }).boundingBox(), page.locator(".nt-doc-wrap").boundingBox()]);
    assert.ok(more.x + more.width <= column.x + column.width, "⋯ inside the page's column");
    if (shots) await page.screenshot({ path: join(shots, `notes-page-${locale}-nested.png`) });
    // The app sidebar folded: the tree comes into the page with its own +, still one New page button on Recent.
    await page.keyboard.press("Meta+Backslash");
    await page.locator(".notes > .nt-side").waitFor();
    await side.locator(".nt-node").first().waitFor({ state: "detached" });
    await page.locator(".notes > .nt-side .nt-node-main").first().click();
    await page.locator(".nt-recent-head").waitFor();
    assert.equal(await page.locator(".nt-recent-head .nt-btn").isVisible(), false, "the in-page tree has its own +");
    await page.keyboard.press("Meta+Backslash");

    // A new page opens straight away: Recent never shows in between, nor the "gone" banner, while the page list catches up.
    await row("Apple").locator(".nt-node-main").click();
    await page.locator(".nt-title").waitFor();
    await page.evaluate(() => {
      window.__flash = [];
      const watch = new MutationObserver(() => {
        if (document.querySelector(".nt-recent-head")) window.__flash.push("recent");
        if (document.querySelector(".nt-banner[role=alert]")) window.__flash.push("banner");
      });
      watch.observe(document.body, { childList: true, subtree: true });
      window.__watch = watch;
    });
    await side.locator(".nt-new-row .nt-node-main").click();
    await page.waitForFunction((untitled) => document.querySelector(".nt-title")?.value === untitled, locale === "en" ? "Untitled" : "无标题");
    await page.waitForTimeout(400);
    assert.deepEqual(await page.evaluate(() => { window.__watch.disconnect(); return [...new Set(window.__flash)]; }), [], "no flash of Recent or a banner");

    // A narrow window: the same tree in the page's drawer.
    await page.setViewportSize({ width: 420, height: 790 });
    await page.goto(base + "/#p=note.list");
    await page.locator(".nt-recent-head .nt-btn").waitFor();
    const button = await page.locator(".nt-recent-head .nt-btn").boundingBox();
    assert.ok(button && button.height <= 30, `folded into the drawer, Recent has its own New page, one row high: ${button?.height}`);
    if (shots) await page.screenshot({ path: join(shots, `notes-page-${locale}-narrow.png`) });
    await page.close();
  });
}
