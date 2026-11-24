/** Run after npm run build:ui with Chrome installed: node packages/desktop/test/links-sample.e2e.mjs */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { updateSettings } from "@zirma/core";
import { createLinksModule, saveClip } from "@zirma/module-links";
import { createHttpServer, openHome } from "@zirma/server";

async function drag(page, source, target) {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  assert.ok(from && to, "Both tiles are visible");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 16 });
  await page.mouse.up();
}

test("Links and old demo bookmarks open the personal library and keep shelf and folder edits", async (t) => {
  const browser = await chromium.launch({ channel: "chrome" });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1180, height: 790 }, locale: "en-US" });
  page.setDefaultTimeout(5000);
  const links = createLinksModule({ fetcher: async url => ({ url }), icons: async () => null, covers: async () => null });
  const dataDir = mkdtempSync(join(tmpdir(), "alfred-links-sample-test-"));
  const home = openHome({ dataDir, modules: [links], engine: { submit: async () => assert.fail("Unexpected engine call") } });
  const uiDir = fileURLToPath(new URL("../../ui/dist", import.meta.url));
  const server = createHttpServer(home, { port: 0, uiDir });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    home.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  updateSettings(home.world, { locale: "en", firstRunAt: new Date().toISOString() });
  for (const id of ["a", "b", "c", "d", "e"]) {
    saveClip(home.world, { url: `https://www.youtube.com/watch?v=${id.repeat(11)}`, title: `Personal video ${id}` });
  }
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base + "/#p=core.today");
  await page.locator('nav [data-page="link.list"]').click();
  await page.locator(".lk-shelf .lk-card").first().waitFor();
  assert.equal(await page.getByRole("link", { name: "5-video demo" }).count(), 0);
  await page.goto("about:blank");
  await page.goto(base + "/#p=link.sample");

  const shelf = page.locator(".lk-shelf");
  const cards = shelf.locator(".lk-card");
  const all = page.getByRole("button", { name: "See all", exact: true });
  await all.waitFor();
  assert.equal(await cards.count(), 3);
  await all.click();
  assert.deepEqual((await cards.locator(".lk-title").allTextContents()).sort(),
    ["Personal video a", "Personal video b", "Personal video c", "Personal video d", "Personal video e"]);
  const last = cards.last();
  const title = await last.locator(".lk-title").innerText();
  await last.locator(".lk-card-delete").click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await shelf.getByText(title, { exact: true }).waitFor({ state: "detached" });
  await page.reload();
  await all.click();
  assert.equal(await cards.count(), 4);
  assert.equal(await shelf.getByText(title, { exact: true }).count(), 0);

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const organizer = page.locator(".lk-place-band > .lk-organizer");
  const folder = page.locator(".lk-folder-panel");
  const folderTile = organizer.getByRole("button").filter({ has: page.locator(".lk-folder-preview") });
  const tile = (parent, name) => parent.getByRole("button", { name, exact: true });
  await drag(page, tile(organizer, "Gmail"), tile(organizer, "Google"));
  await tile(folder, "Google").waitFor();
  await drag(page, tile(organizer, "YouTube"), folderTile);
  await tile(folder, "YouTube").waitFor();
  await drag(page, tile(folder, "Gmail"), organizer.locator("[data-root-drop]"));
  await tile(organizer, "Gmail").waitFor();
  await page.reload();
  await organizer.getByRole("link", { name: "Gmail" }).waitFor();
  await folderTile.click();
  await folder.getByRole("link", { name: "YouTube" }).waitFor();
  await folder.getByRole("link", { name: "Google" }).waitFor();
  assert.equal(await organizer.getByRole("link").count(), 1);
});
