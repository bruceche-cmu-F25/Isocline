/** Run after npm run build:ui with Chrome installed: node packages/desktop/test/phone-dock.e2e.mjs */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

test("the wireframe animates around the centre of the phone's Alfred button", async (t) => {
  const browser = await chromium.launch({ channel: "chrome" });
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    reducedMotion: "no-preference",
  });
  const state = {
    protocol: 1, cursor: 0, modules: {}, views: {}, areas: [], receipts: {}, conversations: [],
    projects: [], proposals: [], settings: { locale: "en" }, automations: [], runs: [], notices: [],
  };
  const dist = new URL("../../ui/dist/", import.meta.url);
  await page.route("**/*", (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/state") return route.fulfill({ json: state });
    if (pathname === "/api/events") return route.fulfill({ status: 204 });
    if (pathname.startsWith("/api/")) return route.fulfill({ json: {} });
    return route.fulfill({ path: fileURLToPath(new URL(pathname.slice(1) || "index.html", dist)) });
  });
  await page.goto("https://alfred.test/");
  const figure = page.locator(".dock-alfred svg");
  await figure.locator("line").first().waitFor({ state: "attached" });
  const { drift, sizes } = await figure.evaluate(async (svg) => {
    const button = svg.closest("button");
    const widths = new Set();
    let drift = 0;
    for (let i = 0; i < 200; i++) {
      if (i === 100) svg.dataset.speaking = "hop";
      if (i === 150) { svg.dataset.speaking = "speak"; svg.dataset.nod = "1"; }
      await new Promise(requestAnimationFrame);
      const drawing = svg.firstElementChild.getBoundingClientRect();
      if (!drawing.width) continue;
      const target = button.getBoundingClientRect();
      widths.add(drawing.width);
      drift = Math.max(drift, Math.abs(target.left + target.width / 2 - drawing.left - drawing.width / 2),
        Math.abs(target.top + target.height / 2 - drawing.top - drawing.height / 2));
    }
    return { drift, sizes: widths.size };
  });
  assert.ok(sizes > 10, "the wireframe actually animated");
  assert.ok(drift < 0.05, `wireframe centre moved ${drift} CSS pixels`);
});
