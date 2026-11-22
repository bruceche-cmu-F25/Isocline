/** Run after npm run build:ui with Chrome installed: node packages/desktop/test/links-shelf.e2e.mjs */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { updateSettings } from "@alfred/core";
import { createLinksModule, saveClip } from "@alfred/module-links";
import { createHttpServer, openHome } from "@alfred/server";

test("video covers fill their 16:9 frame and filters can be cleared after their last match changes", async (t) => {
  const browser = await chromium.launch({ channel: "chrome" });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1180, height: 790 }, locale: "en-US" });
  page.setDefaultTimeout(5000);
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 480;
    canvas.height = 360;
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const links = createLinksModule({
    fetcher: async (url) => ({ url, cover: "https://example.org/poster.png" }),
    icons: async () => null,
    covers: async () => ({ type: "image/png", bytes: Buffer.from(png, "base64") }),
  });
  const dataDir = mkdtempSync(join(tmpdir(), "alfred-links-test-"));
  const home = openHome({ dataDir, modules: [links], engine: { submit: async () => assert.fail("Unexpected engine call") } });
  const uiDir = fileURLToPath(new URL("../../ui/dist", import.meta.url));
  const server = createHttpServer(home, { port: 0, uiDir });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    home.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  updateSettings(home.world, { locale: "en", firstRunAt: new Date().toISOString() });
  saveClip(home.world, { url: "https://example.org/article", title: "Sample article" });
  saveClip(home.world, { url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", title: "First video" });
  saveClip(home.world, { url: "https://www.youtube.com/watch?v=bbbbbbbbbbb", title: "Second video" });
  await links.sync.run(home.world, {}, new AbortController().signal);
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  await page.goto(`http://127.0.0.1:${server.address().port}/#p=link.list`);

  const poster = page.locator(".lk-shelf .lk-cover img").first();
  const size = await poster.evaluate(async (img) => {
    await img.decode();
    const frame = img.parentElement.getBoundingClientRect();
    const image = img.getBoundingClientRect();
    return { natural: [img.naturalWidth, img.naturalHeight], width: frame.width, height: frame.height, imageWidth: image.width, imageHeight: image.height };
  });
  assert.deepEqual(size.natural, [480, 360]);
  assert.ok(size.width > 0 && Math.abs(size.height - size.width * 9 / 16) < 1, "frame remains 16:9");
  assert.ok(Math.abs(size.imageHeight - size.height) < 1 && Math.abs(size.imageWidth - size.width) < 1, "poster fills the frame");

  const filters = page.locator(".lk-filters");
  const shelf = page.locator(".lk-shelf");
  await filters.getByRole("button", { name: /Article/ }).click();
  await page.locator(".lk-card-delete").click();
  const confirm = page.getByRole("dialog", { name: /Sample article/ });
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await page.locator(".lk-main").filter({ hasText: "Sample article" }).press("Backspace");
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByText("Nothing here.", { exact: true }).waitFor();
  await filters.getByRole("button", { name: /All/ }).click();
  await shelf.getByText("Second video").waitFor();

  await shelf.locator(".lk-main").filter({ hasText: "First video" }).click();
  const actions = page.locator(".lk-acts");
  await actions.getByRole("button", { name: "To do", exact: true }).click();
  await shelf.waitFor({ state: "hidden" });
  await filters.getByRole("button", { name: "To do", exact: true }).click();
  const firstVideo = page.locator(".lk-main").filter({ hasText: "First video" });
  if (await firstVideo.getAttribute("aria-expanded") !== "true") await firstVideo.click();
  await actions.getByRole("button", { name: "Watch later", exact: true }).click();
  await page.getByText("Nothing here.", { exact: true }).waitFor();
  await filters.getByRole("button", { name: "To do", exact: true }).click();
  await shelf.getByText("First video").waitFor();
  await shelf.getByText("Second video").waitFor();
});
