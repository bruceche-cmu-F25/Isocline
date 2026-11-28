/** Run after npm run build:ui with Chrome installed: node packages/desktop/test/links-autofile.e2e.mjs
 * (ZIRMA_UI_DIR=<dir> to use another build; SHOTS=<dir> to keep screenshots). links-autofile.md §2, §4: the Auto-file
 * button asks once before it turns on, the line says what the last pass filed and can undo it, what Zirma filed and
 * made is marked, an opened link it filed can be put back, and Not filed offers to go through the rest. In both
 * languages, wide and at a phone's width, with no text on top of other text. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { listAreas, updateSettings } from "@zirma/core";
import { beginFilePass, createLinksModule, ensureTopic, fileOne, finishFilePass, recordPage, saveClip, setAutoFile } from "@zirma/module-links";
import { createHttpServer, openHome } from "@zirma/server";

/** Pairs of visible boxes that overlap, among the elements the selector finds. */
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
/** Text cut off where it should not be: an element whose text is wider than its box, without an ellipsis to say so. */
const clipped = (page, selector) => page.evaluate((selector) => [...document.querySelectorAll(selector)]
  .filter((el) => el.getBoundingClientRect().width && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow !== "ellipsis")
  .map((el) => `${el.className}: ${el.textContent}`), selector);

test("Links: Auto-file, its line, its marks and Not filed's offer, in zh and en, wide and narrow", async (t) => {
  const browser = await chromium.launch({ channel: "chrome" });
  t.after(() => browser.close());
  const links = createLinksModule({ fetcher: async url => ({ url }), icons: async () => null, covers: async () => null });
  const dataDir = mkdtempSync(join(tmpdir(), "zirma-links-autofile-test-"));
  const home = openHome({ dataDir, modules: [links], engine: { submit: async () => assert.fail("Unexpected engine call") } });
  const uiDir = process.env.ZIRMA_UI_DIR ?? fileURLToPath(new URL("../../ui/dist", import.meta.url));
  const server = createHttpServer(home, { port: 0, uiDir });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    home.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const w = home.world;
  const [first, second] = listAreas(w);
  const reading = ensureTopic(w, { name: "Reading", area: first.id });
  const save = (path, title, extra = {}) => { const made = saveClip(w, { url: `https://example.com/${path}`, ...extra }); assert.ok(!("error" in made), made.error); recordPage(w, made.clip.id, { title }); return made.clip.id; };
  save("mine", "A book I filed myself", { topicId: reading.id });
  // A pass that filed two (one into a category it made) and skipped one, as the home node would run it.
  const ids = [save("a", "Designing data-intensive applications, a long title that has to fit"), save("b", "Weekly tools roundup"), save("c", "Something odd")];
  setAutoFile(w, true);
  const pass = beginFilePass(w, { kind: "sweep", sweep: null, itemIds: ids });
  assert.match(fileOne(w, { id: ids[0], category: "Reading" }), /Filed/);
  assert.match(fileOne(w, { id: ids[1], category: "Tools", area: second.id }), /new category/);
  finishFilePass(w, pass);
  setAutoFile(w, false);
  save("loose1", "Not filed yet, one"); save("loose2", "Not filed yet, two");

  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const shots = process.env.SHOTS;
  const words = {
    en: { button: "Auto-file", on: "Turn on", filed: "filed 2, new categories: 1", filedTo: "filed it under Reading", putBack: "Wrong, put it back", offer: "nobody has filed yet", go: "file them", cancel: "Cancel", notFiled: "Not filed" },
    zh: { button: "自动分类", on: "打开", filed: "归了 2 条，新建 1 个分类", filedTo: "归到了 Reading", putBack: "不对，放回没分类", offer: "条还没人归过", go: "归一下", cancel: "取消", notFiled: "没分类" },
  };

  for (const locale of ["en", "zh"]) {
    for (const [width, height] of [[1180, 790], [390, 780]]) {
      const say = words[locale];
      const shot = async (name) => { if (!shots) return; await page.waitForTimeout(400); await page.screenshot({ path: join(shots, `autofile-${locale}-${width}-${name}.png`) }); };
      updateSettings(w, { locale, firstRunAt: new Date().toISOString() });
      const page = await browser.newPage({ viewport: { width, height }, locale: locale === "en" ? "en-US" : "zh-CN", hasTouch: width < 500, isMobile: width < 500 });
      page.setDefaultTimeout(5000);
      await page.goto(base + "/#p=link.list");
      await page.evaluate(() => { try { localStorage.removeItem("zirma.links.autofileAsked"); } catch { /* fresh */ } });

      const phone = width < 500;
      const button = page.locator(".la-button");
      // Wide: the line says what the last pass did, the button is in the head. Rows carry no mark of
      // who filed them (an opened link says it). A phone shows the links first: no line, no button in the head (⋯ has it).
      const line = page.locator(".la-line");
      await page.locator(".lr-row", { hasText: "Weekly tools roundup" }).waitFor();
      if (!phone) {
        await line.waitFor();
        assert.match(await line.innerText(), new RegExp(say.filed));
        assert.equal(await button.getAttribute("aria-pressed"), "false");
        assert.equal((await button.innerText()).trim(), say.button);
      } else {
        assert.equal(await line.isVisible(), false);
        assert.equal(await button.isVisible(), false);
      }
      assert.deepEqual(await overlaps(page, ".lk-head > *, .la-line > *"), [], `nothing on top of anything in the head and the line (${locale}, ${width})`);
      assert.deepEqual(await clipped(page, ".la-button, .lk-crumbs"), []);
      await shot("line");

      // First press: the card says what it does and what it sends; turning it on fills the button.
      const press = async () => {
        if (!phone) return button.click();
        await page.locator(".lk-more-wrap .lk-icon-btn").click();
        await page.locator(".lt-menu .la-menu-item").click();
      };
      await press();
      const card = page.locator(".la-card");
      await card.waitFor();
      assert.deepEqual(await overlaps(page, ".la-card h3, .la-card p, .la-card .lk-btn"), []);
      await shot("card");
      await card.locator(".lk-btn.solid", { hasText: say.on }).click();
      await card.waitFor({ state: "detached" });
      await page.locator('.la-button[aria-pressed="true"]').waitFor({ state: "attached" });
      if (phone) {
        await page.locator(".lk-more-wrap .lk-icon-btn").click();
        await shot("menu");
        assert.match(await page.locator(".lt-menu .la-menu-item").innerText(), locale === "zh" ? /已开/ : / on$/);
        await page.keyboard.press("Escape");
      } else await shot("on");
      // Off again for the next round.
      await press();
      await page.locator(".la-card .lk-btn:not(.solid)").click();
      await page.locator('.la-button[aria-pressed="false"]').waitFor({ state: "attached" });

      // An opened link Zirma filed says where, and can be put back.
      await page.locator(".lr-row", { hasText: "Designing data-intensive" }).locator(".lr-open").click();
      const filed = page.locator(".la-filed");
      await filed.waitFor();
      assert.match(await filed.innerText(), new RegExp(say.filedTo));
      assert.deepEqual(await overlaps(page, ".la-filed > *"), []);
      await shot("opened");
      await page.keyboard.press("Escape");

      // Not filed offers to go through what nobody filed; the card asks first.
      if (width > 500) await page.locator(".side-host .lt-node, .links .lt-node", { hasText: say.notFiled }).first().click();
      else {
        await page.goto(base + "/#p=link.list");
        await page.evaluate(() => localStorage.setItem("zirma.links.node", JSON.stringify("none")));
        await page.reload();
      }
      const offer = page.locator(".la-offer");
      await offer.waitFor();
      assert.match(await offer.innerText(), new RegExp(say.offer));
      assert.deepEqual(await overlaps(page, ".la-offer > *"), []);
      await offer.locator(".lk-btn", { hasText: say.go }).click();
      await page.locator(".la-card").waitFor();
      await shot("sweep");
      await page.locator(".la-card .lk-btn", { hasText: say.cancel }).click();
      await page.evaluate(() => localStorage.setItem("zirma.links.node", JSON.stringify("all")));
      await page.close();
    }
  }

  // Undo takes the pass back: the line goes, and the category it made with it.
  const page = await browser.newPage({ viewport: { width: 1180, height: 790 } });
  await page.goto(base + "/#p=link.list");
  await page.locator(".la-line .lk-see").click();
  await page.locator(".la-line").waitFor({ state: "detached" });
  await page.locator(".lk-toast").waitFor();
  await page.locator(".lt-node", { hasText: "Tools" }).waitFor({ state: "detached" });
  await page.close();
});
