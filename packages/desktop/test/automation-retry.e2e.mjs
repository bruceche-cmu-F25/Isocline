/** Run after npm run build:ui with Chrome installed: node packages/desktop/test/automation-retry.e2e.mjs
 * (UI_DIST=<folder> tests a build made elsewhere; SHOTS=<folder> keeps screenshots). An automation's firing that
 * failed before doing anything is tried again (docs/design/automations.md §3): its row says when, a failure says why,
 * and three failed firings in a row are one notice in the Inbox. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const now = Date.now();
const iso = (minutes) => new Date(now + minutes * 60_000).toISOString();
const automation = (id, name, lastRun, extra = {}) => ({
  id, name, template: null, layout: "text", keep: "all", notify: "always", k: "green", goal: `What ${name} does each time`, instruction: `What ${name} does each time`,
  schedule: { at: "07:30", days: [1, 2, 3, 4, 5, 6, 7] }, enabled: true, conversationId: `c-${id}`, lastSlot: iso(-10), lastRunId: lastRun?.id ?? null,
  createdAt: iso(-5000), updatedAt: iso(-5000), nextAt: iso(600), lastRun, ...extra,
});

for (const locale of ["en", "zh"]) {
  test(`Automations: a retry says when, a failure says why, a streak is one notice (${locale})`, async (t) => {
    const browser = await chromium.launch({ channel: "chrome" });
    t.after(() => browser.close());
    const state = {
      protocol: 1, cursor: 0, areas: [], receipts: {}, conversations: [], projects: [], proposals: [],
      settings: { locale, pages: { order: [] } }, runs: [],
      automations: [
        // Failed two minutes ago before doing anything: another try is coming.
        automation("a1", locale === "zh" ? "早报" : "Morning brief", { id: "r1", state: "failed", at: iso(-1), reply: null, error: "engine_failed", retryAt: iso(1) }),
        // Its tries are used up.
        automation("a2", locale === "zh" ? "每周理一遍待办和这周要交的东西" : "Weekly review of todos and everything due this week", { id: "r2", state: "failed", at: iso(-30), reply: null, error: "engine_failed", tries: 4 }),
        // No model to run with: not tried again, and the row says what to do.
        automation("a3", locale === "zh" ? "从邮件里挑待办" : "Todos from mail", { id: "r3", state: "failed", at: iso(-60), reply: null, error: "engine_unavailable" }),
      ],
      notices: [{
        id: "n2", eventSeq: 8, kind: "run_result", class: "tells_you", state: "pending", createdAt: iso(-90), updatedAt: iso(-90), outlet: null,
        payload: { runId: "r9", conversationId: "c-x", status: "completed", goal: locale === "zh" ? "查一下机票" : "Check the fares", delivery: "inbox", receipts: 0, reply: locale === "zh" ? "查好了。" : "Checked." },
      }, {
        id: "n1", eventSeq: 9, kind: "run_result", class: "tells_you", state: "pending", createdAt: iso(-60), updatedAt: iso(-60), outlet: null,
        payload: { runId: "r3", conversationId: "c-a3", status: "failed", goal: locale === "zh" ? "从邮件里挑待办" : "Todos from mail", automationId: "a3", delivery: "inbox", receipts: 0, error: "engine_unavailable", streak: 3 },
      }],
      views: { calendar: [{ id: "week", title: "Calendar" }], todo: [{ id: "list", title: "Todos" }] },
      modules: {
        calendar: { today: "2026-11-27", from: "2026-11-01", to: "2026-12-31", events: [], pending: [], sources: [] },
        todo: { today: "2026-11-27", todos: [] },
      },
    };
    const open = async (options) => {
      const page = await browser.newPage(options);
      page.setDefaultTimeout(5000);
      await page.route("**/*", serve);
      return page;
    };
    const dist = process.env.UI_DIST ? pathToFileURL(`${process.env.UI_DIST.replace(/\/$/, "")}/`) : new URL("../../ui/dist/", import.meta.url);
    const serve = async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/state") return route.fulfill({ json: state });
      if (pathname === "/api/remote") return route.fulfill({ json: { local: true } });
      if (pathname === "/api/device/web-lock") return route.fulfill({ json: { enabled: false, locked: false, expiresAt: null } });
      if (pathname === "/api/events") return route.fulfill({ status: 204 });
      // The open automation lists its runs.
      if (/^\/api\/automations\/\w+\/runs$/.test(pathname)) return route.fulfill({ json: { runs: [], nextCursor: null } });
      if (pathname.startsWith("/api/")) return route.fulfill({ json: {} });
      return route.fulfill({ path: fileURLToPath(new URL(pathname.slice(1) || "index.html", dist)) });
    };
    let page = await open({ viewport: { width: 1280, height: 800 } });
    const shot = async (name) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/automation-retry-${name}-${locale}.png` }); };
    /** Text boxes that sit on top of each other, in the list and in the open automation. */
    const overlaps = () => page.evaluate(() => {
      const boxes = [...document.querySelectorAll(".au-list .st-name, .au-list .st-count, .auto-head h2, .auto-meta span, .auto-why, .auto-actions button, .auto-part h3, .auto-part p")]
        .map((el) => el.getBoundingClientRect()).filter((box) => box.width && box.height);
      let hits = 0;
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) hits++;
      }
      return hits;
    });
    /** What reaches past the window's right edge. */
    const tooWide = () => page.evaluate(() => [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} "${(el.textContent ?? "").slice(0, 30)}"`).slice(0, 5));
    /** Opens the n-th automation from the list and waits for its page. */
    const pick = async (list, index) => {
      const name = (await list.locator(".au-row .st-name").nth(index).innerText()).trim();
      await list.locator(".au-row").nth(index).click();
      await page.waitForFunction((name) => document.querySelector(".auto-head h2")?.textContent === name, name);
    };
    const last = page.locator(".auto-meta .auto-last"), why = page.locator(".auto-why");

    await page.goto("https://zirma.test/#p=core.automations");
    const side = page.locator(".side-host nav.au-list");
    // The list is there before the state is; wait for its rules.
    await side.locator(".au-row").first().waitFor();
    assert.equal(await side.locator(".au-row").count(), 3);
    assert.equal(await side.locator(".au-dot[data-failed]").count(), 3);
    // The first one is open: another try is coming, and it says when and why.
    await page.locator(".auto-head").waitFor();
    assert.match(await last.innerText(), locale === "zh" ? /^没做成，今天 \d\d:\d\d 再试$/ : /^Failed · trying again today \d\d:\d\d$/i);
    assert.match(await why.innerText(), locale === "zh" ? /模型那边出错了/ : /model's side/);
    assert.equal(await overlaps(), 0);
    await shot("wide");
    await pick(side, 1);
    assert.match(await last.innerText(), locale === "zh" ? /^试了 4 次没做成/ : /^Failed after 4 tries/);
    await pick(side, 2);
    assert.match(await why.innerText(), locale === "zh" ? /还没有可用的模型/ : /No model is available/);
    assert.equal(await overlaps(), 0);
    await shot("no-model");

    // A narrow window.
    await page.setViewportSize({ width: 900, height: 800 });
    await side.waitFor();
    assert.equal(await overlaps(), 0, "no text on top of other text at 900px");
    assert.deepEqual(await tooWide(), [], "nothing wider than the window at 900px");
    await shot("w900");

    // The Inbox: one notice for the three failed firings, saying so and why.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("https://zirma.test/#p=core.inbox");
    const row = page.locator(".inbox-list li").first();
    await row.waitFor();
    assert.match(await row.innerText(), locale === "zh" ? /连着 3 期没做成。\s*还没有可用的模型/ : /Failed 3 times in a row\.\s*No model is available/);
    await shot("inbox");

    // A phone: the same two pages.
    await page.close();
    page = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.goto("https://zirma.test/#p=core.automations");
    const list = page.locator(".automations > .au-list");
    await list.waitFor();
    await list.locator(".au-row").nth(2).tap();
    await page.locator(".auto-why").waitFor();
    assert.equal(await overlaps(), 0, "no text on top of other text on a phone");
    assert.deepEqual(await tooWide(), [], "nothing wider than a phone's screen");
    await shot("phone");
    await page.goto("https://zirma.test/#p=core.inbox");
    await page.locator(".inbox-list, .inbox-pane").first().waitFor();
    assert.deepEqual(await tooWide(), [], "nothing wider than a phone's screen in the Inbox");
    await shot("inbox-phone");
  });
}
