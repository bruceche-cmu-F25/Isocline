/** Run after npm run build:ui with Chrome installed: node packages/desktop/test/automations-side.e2e.mjs
 * (UI_DIST=<folder> tests a build made elsewhere; SHOTS=<folder> keeps screenshots). The Automations page's list of
 * rules lives in the app sidebar while it has room, and the page is the one picked (workspace-architecture.md §6, a
 * page's own sidebar; docs/design/automations.md §6). Without a sidebar the list is in the page. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const now = Date.now();
const iso = (minutes) => new Date(now + minutes * 60_000).toISOString();

for (const locale of ["en", "zh"]) {
  test(`Automations: the rules sit in the sidebar, the page is the one picked (${locale})`, async (t) => {
    const zh = locale === "zh";
    const browser = await chromium.launch({ channel: "chrome" });
    t.after(() => browser.close());
    const reply = zh ? "今天三件事：十点组会，下午交报告，晚上回一封信。" : "Three things today: stand-up at ten, the report this afternoon, one reply tonight.";
    const automation = (id, name, goal, k, extra = {}) => ({
      id, name, template: null, layout: "text", keep: "all", notify: "always", k, goal, instruction: goal,
      schedule: { at: "07:30", days: [1, 2, 3, 4, 5, 6, 7] }, enabled: true, conversationId: `c-${id}`, lastSlot: iso(-600), lastRunId: `r-${id}`,
      createdAt: iso(-9000), updatedAt: iso(-9000), nextAt: iso(700), lastRun: { id: `r-${id}`, state: "completed", at: iso(-600), reply }, ...extra,
    });
    const run = (id, of, state, minutes) => ({
      id, requestId: `auto:${of}:${minutes}`, conversationId: `c-${of}`, goal: "g", profile: "automation", state, createdAt: iso(minutes), updatedAt: iso(minutes + 1),
      attempt: 1, leaseOwner: null, leaseUntil: null, cancelRequested: false, request: null, context: null, automationId: of,
      outcome: state === "completed" ? { status: "completed", reply, receipts: [] } : { status: "failed", error: "engine_failed", receipts: [] },
    });
    const runs = [run("r-a1", "a1", "completed", -600), run("r-a1b", "a1", "completed", -2040), run("r-a1c", "a1", "failed", -3480)];
    const state = {
      protocol: 1, cursor: 0, areas: [], receipts: {}, conversations: [], projects: [], proposals: [], settings: { locale, pages: { order: [] } }, runs, notices: [],
      automations: [
        automation("a1", zh ? "早报" : "Morning brief", zh ? "写今天的早报。查今天的日历、今天到期或已逾期的待办，以及需要回复的邮件。" : "Write today's morning brief. Check today's calendar, todos due today or overdue, and mail needing my reply.", "orange"),
        automation("a2", zh ? "从邮件里挑待办" : "Todos from mail", zh ? "看一遍最近两天收到的邮件，凡是要我做一件事的，建议成一条待办。" : "Go through the last two days of mail and suggest a todo for each thing I have to do.", "blue",
          { lastRun: { id: "r-a2", state: "failed", at: iso(-60), reply: null }, nextAt: iso(800) }),
        automation("a3", zh ? "每周一理一遍待办和这周要交的东西" : "Weekly review of todos and everything due this week", zh ? "把逾期和这周到期的待办理一遍，提议怎么处理。" : "Go over overdue todos and those due this week; propose what to do.", "green",
          { enabled: false, nextAt: null, lastRun: null, lastRunId: null }),
      ],
      views: { calendar: [{ id: "week", title: "Calendar" }], todo: [{ id: "list", title: "Todos" }] },
      modules: {
        calendar: { today: "2026-11-27", from: "2026-11-01", to: "2026-12-31", events: [], pending: [], sources: [] },
        todo: { today: "2026-11-27", todos: [] },
      },
    };
    const dist = process.env.UI_DIST ? pathToFileURL(`${process.env.UI_DIST.replace(/\/$/, "")}/`) : new URL("../../ui/dist/", import.meta.url);
    const open = async (options) => {
      const page = await browser.newPage(options);
      page.setDefaultTimeout(5000);
      await page.route("**/*", async (route) => {
        const { pathname } = new URL(route.request().url());
        if (pathname === "/api/state") return route.fulfill({ json: state });
        if (pathname === "/api/remote") return route.fulfill({ json: { local: true } });
        if (pathname === "/api/device/web-lock") return route.fulfill({ json: { enabled: false, locked: false, expiresAt: null } });
        if (pathname === "/api/events") return route.fulfill({ status: 204 });
        const history = /^\/api\/automations\/(\w+)\/runs$/.exec(pathname);
        if (history) return route.fulfill({ json: { runs: runs.filter((one) => one.automationId === history[1]), nextCursor: null } });
        const one = /^\/api\/runs\/([\w-]+)$/.exec(pathname);
        if (one) return route.fulfill({ json: { run: runs.find((candidate) => candidate.id === one[1]) ?? null, events: [] } });
        if (pathname.startsWith("/api/")) return route.fulfill({ json: {} });
        return route.fulfill({ path: fileURLToPath(new URL(pathname.slice(1) || "index.html", dist)) });
      });
      await page.goto("https://zirma.test/#p=core.automations");
      return page;
    };
    const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/automations-side-${name}-${locale}.png` }); };
    /** Text boxes on top of each other, and anything reaching past the window's right edge. */
    const untidy = (page, selector) => page.evaluate((selector) => {
      const boxes = [...document.querySelectorAll(selector)].map((el) => el.getBoundingClientRect()).filter((box) => box.width && box.height);
      let overlaps = 0;
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps++;
      }
      const wide = [...document.querySelectorAll(".automations *, .side-host *")].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).length;
      return { overlaps, wide };
    }, selector);
    const TEXT = ".au-list .st-name, .au-list .st-count, .auto-head h2, .auto-meta span, .auto-actions button, .auto-part h3, .auto-part p, .history-editions time, .history-result h3";

    let page = await open({ viewport: { width: 1280, height: 800 } });
    const side = page.locator(".side-host nav.au-list");
    // The list is there before the state is; wait for its rules.
    await side.locator(".au-row").first().waitFor();
    // New first, then the three rules; none of them in the page.
    assert.equal(await side.locator(".st-node").count(), 4);
    assert.equal(await page.locator(".automations .au-list").count(), 0, "the list is not also in the page");
    // The first rule is open: its name, when, what it does, and its runs.
    assert.equal(await side.locator('.st-node[aria-current="true"]').count(), 1);
    assert.equal((await page.locator(".auto-head h2").innerText()).trim(), zh ? "早报" : "Morning brief");
    assert.equal(await page.locator(".history-editions li").count(), 3);
    assert.equal(await side.locator(".au-row[data-off]").count(), 1, "the one switched off is dimmed");
    assert.equal(await side.locator(".au-dot[data-failed]").count(), 1, "the one that failed last is marked");
    assert.deepEqual(await untidy(page, TEXT), { overlaps: 0, wide: 0 });
    await shot(page, "wide");

    // Another rule; then the form for a new one.
    await side.locator(".au-row").nth(1).click();
    await page.waitForFunction((name) => document.querySelector(".auto-head h2")?.textContent === name, zh ? "从邮件里挑待办" : "Todos from mail");
    assert.equal(await page.locator('.auto-meta .auto-last[data-state="failed"]').count(), 1);
    await shot(page, "failed");
    await side.locator(".st-node").first().click();
    await page.locator(".auto-form").waitFor();
    assert.equal(await page.locator(".auto-head").count(), 0);
    await shot(page, "new");
    await side.locator(".au-row").first().click();
    await page.locator(".auto-head").waitFor();

    // A narrow window that still has the sidebar.
    await page.setViewportSize({ width: 900, height: 800 });
    await side.waitFor();
    assert.deepEqual(await untidy(page, TEXT), { overlaps: 0, wide: 0 });
    await shot(page, "w900");

    // Sidebar folded away: the list comes back into the page, beside the open rule.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.keyboard.press("Meta+Backslash");
    await page.locator(".automations > .au-list").waitFor();
    await page.locator(".auto-head").waitFor();
    assert.deepEqual(await untidy(page, TEXT), { overlaps: 0, wide: 0 });
    await shot(page, "folded");
    await page.close();

    // A phone: the list first, then the one picked, with a way back.
    page = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.locator(".automations > .au-list").waitFor();
    assert.equal(await page.locator(".auto-one").count(), 0);
    assert.deepEqual(await untidy(page, TEXT), { overlaps: 0, wide: 0 });
    await shot(page, "phone-list");
    await page.locator(".au-row").first().tap();
    await page.locator(".auto-head").waitFor();
    assert.equal(await page.locator(".automations > .au-list").count(), 0);
    assert.deepEqual(await untidy(page, TEXT), { overlaps: 0, wide: 0 });
    await shot(page, "phone-one");
    await page.locator(".auto-back").tap();
    await page.locator(".automations > .au-list").waitFor();
  });
}
