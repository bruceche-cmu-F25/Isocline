/** Run after npm run build:ui with Chrome installed: node packages/desktop/test/phone-dock.e2e.mjs
 * (UI_DIST=<folder> tests a build made elsewhere, leaving the running app's own dist alone). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

async function serveBuild(page) {
  const state = {
    protocol: 1, cursor: 0, modules: {}, views: {}, areas: [], receipts: {}, conversations: [],
    projects: [], proposals: [], settings: { locale: "en" }, automations: [], runs: [], notices: [],
  };
  const dist = process.env.UI_DIST ? pathToFileURL(`${process.env.UI_DIST.replace(/\/$/, "")}/`) : new URL("../../ui/dist/", import.meta.url);
  await page.route("**/*", (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/state") return route.fulfill({ json: state });
    if (pathname === "/api/device/web-lock") return route.fulfill({ json: { enabled: false, locked: false, expiresAt: null } });
    if (pathname === "/api/events") return route.fulfill({ status: 204 });
    if (pathname.startsWith("/api/")) return route.fulfill({ json: {} });
    return route.fulfill({ path: fileURLToPath(new URL(pathname.slice(1) || "index.html", dist)) });
  });
  return state;
}

test("the wireframe animates around the centre of the phone's Alfred button", async (t) => {
  const browser = await chromium.launch({ channel: "chrome" });
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    reducedMotion: "no-preference",
  });
  await serveBuild(page);
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

/** Advance the existing animation clock and take a sample twice a second. */
async function sampleMotion(page, selectors, seconds) {
  const seen = selectors.map(() => new Set());
  for (let i = 0; i < seconds * 2; i++) {
    await page.clock.fastForward(500);
    const poses = await page.evaluate((selectors) => selectors.map((selector) => {
      const { state, move } = document.querySelector(selector).dataset;
      return [state, move].filter(Boolean);
    }), selectors);
    poses.forEach((pose, index) => pose.forEach((name) => seen[index].add(name)));
  }
  return seen;
}

test("Coding, dock and desktop figures vary at rest and yield to a real status or reduced motion", async (t) => {
  const browser = await chromium.launch({ channel: "chrome" });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 402, height: 874 }, isMobile: true });
  const snapshot = await serveBuild(page);
  await page.clock.install();
  // Let the fixture announce a changed snapshot through the same EventSource as the home node.
  await page.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      constructor() { super(); window.fixtureEvents = this; }
      close() {}
    };
  });
  await page.goto("https://alfred.test/#p=core.dev");
  const header = ".dev-new-head svg", dock = ".dock-alfred svg";
  await page.locator(header + "[data-state]").waitFor();
  const [headerPoses, dockPoses] = await sampleMotion(page, [header, dock], 48);
  for (const poses of [headerPoses, dockPoses]) {
    assert.ok(poses.has("ponder") && poses.has("flow"), "both double rotation and flow are shown");
  }
  assert.ok(headerPoses.has("unfold"), "the Coding figure has room to unfold");
  assert.ok(!dockPoses.has("unfold"), "the small dock figure keeps its compact gestures");
  // Poking the header during a roll brings the touch gesture forward.
  const mark = page.locator(header);
  for (let i = 0; i < 50 && !["ponder", "flow"].includes(await mark.getAttribute("data-state")); i++) {
    await page.clock.fastForward(500);
  }
  assert.ok(["ponder", "flow"].includes(await mark.getAttribute("data-state")));
  await mark.dispatchEvent("pointerdown");
  await page.clock.fastForward(600);
  assert.equal(await mark.getAttribute("data-move"), "poke");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const [greeting, resting] = await sampleMotion(page, [header, dock], 12);
  assert.deepEqual([...greeting], ["hello"]);
  assert.deepEqual([...resting], ["rest"]);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("https://alfred.test/presence.html");
  const presence = ".figure svg";
  await page.locator(presence + "[data-state]").waitFor();
  const [large] = await sampleMotion(page, [presence], 48);
  for (const pose of ["ponder", "flow", "unfold"]) assert.ok(large.has(pose), "desktop figure shows " + pose);
  async function checkStatus(expected) {
    await page.evaluate(() => window.fixtureEvents.dispatchEvent(new Event("open")));
    await page.clock.fastForward(200);
    await page.locator(presence + `[data-state="${expected}"]`).waitFor();
    const [poses] = await sampleMotion(page, [presence], 12);
    assert.deepEqual([...poses], [expected]);
  }
  snapshot.runs = [{ state: "running" }];
  await checkStatus("work");
  snapshot.notices = [{ kind: "run_interrupted", class: "needs_you" }];
  await checkStatus("notice");
});
