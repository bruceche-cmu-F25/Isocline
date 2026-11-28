/** Run after npm run build:ui with Chrome installed: node packages/desktop/test/links-autofile-failed.e2e.mjs
 * (ZIRMA_UI_DIR=<dir> to use another build; SHOTS=<dir> to keep screenshots). links-autofile.md §2: a pass whose run
 * did not go through leaves its links waiting, and the line on top of the page says when it tries again; closing the
 * line puts it away. In both languages, wide and narrow, with no text on top of other text. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { updateSettings } from "@zirma/core";
import { beginFilePass, createLinksModule, finishFilePass, recordPage, saveClip, setAutoFile } from "@zirma/module-links";
import { createHttpServer, openHome } from "@zirma/server";

const overlaps = (page, selector) => page.evaluate((selector) => {
  const boxes = [...document.querySelectorAll(selector)].map((el) => [el, el.getBoundingClientRect()]).filter(([, box]) => box.width && box.height);
  const hits = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const [ea, a] = boxes[i], [eb, b] = boxes[j];
    if (ea.contains(eb) || eb.contains(ea)) continue;
    if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) hits.push(`${ea.className || ea.tagName} × ${eb.className || eb.tagName}`);
  }
  return hits;
}, selector);

test("Links: a pass that did not go through says when it tries again, in zh and en, wide and narrow", async (t) => {
  const browser = await chromium.launch({ channel: "chrome" });
  t.after(() => browser.close());
  const links = createLinksModule({ fetcher: async (url) => ({ url }), icons: async () => null, covers: async () => null });
  const dataDir = mkdtempSync(join(tmpdir(), "zirma-links-failed-test-"));
  const home = openHome({ dataDir, modules: [links], engine: { submit: async () => assert.fail("Unexpected engine call") } });
  const uiDir = process.env.ZIRMA_UI_DIR ?? fileURLToPath(new URL("../../ui/dist", import.meta.url));
  const server = createHttpServer(home, { port: 0, uiDir });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    home.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const w = home.world;
  const made = saveClip(w, { url: "https://example.com/waits" });
  assert.ok(!("error" in made));
  recordPage(w, made.clip.id, { title: "A link that waits to be filed" });
  setAutoFile(w, true);
  const pass = beginFilePass(w, { kind: "auto", sweep: null, itemIds: [made.clip.id] });
  finishFilePass(w, pass, Date.now(), { failed: true });

  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const said = { en: /Filing did not go through; trying again at \d\d:\d\d/, zh: /归类没成功，\d\d:\d\d 再试/ };
  for (const locale of ["en", "zh"]) {
    for (const width of [1180, 640]) {
      updateSettings(w, { locale, firstRunAt: new Date().toISOString() });
      const page = await browser.newPage({ viewport: { width, height: 780 }, locale: locale === "en" ? "en-US" : "zh-CN" });
      page.setDefaultTimeout(5000);
      await page.goto(base + "/#p=link.list");
      const line = page.locator(".la-line");
      await line.waitFor();
      assert.match(await line.innerText(), said[locale]);
      assert.equal(await line.locator(".lk-see").count(), 0, "nothing to undo");
      assert.deepEqual(await overlaps(page, ".lk-head > *, .la-line > *"), [], `nothing on top of anything (${locale}, ${width})`);
      if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `autofile-failed-${locale}-${width}.png`) });
      await page.close();
    }
  }
  const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
  await page.goto(base + "/#p=link.list");
  await page.locator(".la-line .la-close").click();
  await page.locator(".la-line").waitFor({ state: "detached" });
  await page.close();
});
