/** Run after npm run build:ui with Chrome installed: node packages/desktop/test/chat-page.e2e.mjs
 * (UI_DIST=<folder> tests a build made elsewhere; SHOTS=<folder> keeps screenshots). The Chats page
 * (docs/design/chat.md, C1): its own sidebar with a new-chat row, the conversations by Today / Previous 7 days / Older,
 * and Archived; the open conversation fills the page; without the sidebar the list sits in the page. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const now = Date.now();
const iso = (days, hours = 0) => new Date(now - days * 86_400_000 - hours * 3_600_000).toISOString();
const conversation = (id, title, days, extra = {}) => ({
  id, title, createdAt: iso(days + 1), updatedAt: iso(days), archivedAt: null, model: null, thinking: null, busy: 0, attention: 0,
  lastGoal: title, projectId: null, mode: null, base: null, ...extra,
});
const run = (id, conversationId, goal, reply, days) => ({
  id, requestId: id, conversationId, goal, profile: "chat", state: "succeeded", createdAt: iso(days), updatedAt: iso(days), attempt: 1,
  leaseOwner: null, leaseUntil: null, cancelRequested: false, outcome: { status: "completed", reply, receipts: [] }, request: null, context: null, automationId: null,
});

for (const locale of ["en", "zh"]) {
  test(`Chats: its own sidebar, the conversation in the page (${locale})`, async (t) => {
    const browser = await chromium.launch({ channel: "chrome" });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(5000);
    const zh = locale === "zh";
    const conversations = [
      conversation("c1", zh ? "周五评审要讲什么" : "What to cover on Friday", 0),
      conversation("c2", zh ? "搬家清单" : "Moving checklist", 2, { attention: 2 }),
      conversation("c3", zh ? "跑步计划" : "Running plan", 12),
      conversation("c4", zh ? "一个开发会话" : "A coding session", 0, { projectId: "p1", mode: "ask" }),
      conversation("c5", zh ? "自动化的记录" : "An automation's log", 0, { automationOnly: true }),
    ];
    const details = {
      c1: { conversation: conversations[0], runs: [run("r1", "c1", zh ? "帮我把周五评审要讲的三件事列出来。" : "List the three things to cover on Friday.", zh ? "一，搜索改版的取舍；二，手机上的键盘遮挡；三，下个版本的范围。" : "One, the search redesign's trade-offs; two, the keyboard covering fields on the phone; three, the next release's scope.", 0)], receipts: {}, activity: {}, nextCursor: null },
      c2: { conversation: conversations[1], runs: [], receipts: {}, activity: {}, nextCursor: null },
    };
    const state = {
      protocol: 1, cursor: 0, areas: [], receipts: {}, conversations, projects: [], proposals: [],
      settings: { locale, pages: { order: [] } }, automations: [], runs: [], notices: [],
      views: { calendar: [{ id: "week", title: "Calendar" }], todo: [{ id: "list", title: "Todos" }] },
      modules: { calendar: { today: "2026-11-27", from: "2026-11-01", to: "2026-12-31", events: [], pending: [], sources: [] }, todo: { today: "2026-11-27", todos: [] } },
    };
    const renamed = [];
    const dist = process.env.UI_DIST ? pathToFileURL(`${process.env.UI_DIST.replace(/\/$/, "")}/`) : new URL("../../ui/dist/", import.meta.url);
    await page.route("**/*", async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      if (pathname === "/api/state") return route.fulfill({ json: state });
      if (pathname === "/api/remote") return route.fulfill({ json: { local: true } });
      if (pathname === "/api/device/web-lock") return route.fulfill({ json: { enabled: false, locked: false, expiresAt: null } });
      if (pathname === "/api/events") return route.fulfill({ status: 204 });
      const one = pathname.match(/^\/api\/conversations\/([^/]+)$/);
      if (one && request.method() === "GET") return route.fulfill({ json: details[one[1]] ?? { conversation: conversations[0], runs: [], receipts: {}, activity: {}, nextCursor: null } });
      if (one && request.method() !== "GET") { renamed.push(request.postDataJSON()); return route.fulfill({ json: { conversation: conversations[0] } }); }
      if (pathname.startsWith("/api/")) return route.fulfill({ json: {} });
      return route.fulfill({ path: fileURLToPath(new URL(pathname.slice(1) || "index.html", dist)) });
    });
    const shot = async (name) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/chat-${name}-${locale}.png` }); };

    await page.goto("https://zirma.test/#p=core.chat");
    const side = page.locator(".side-host nav.ch-list");
    await side.waitFor();
    // New chat first; three everyday conversations in three bands; no coding session, no automation's log.
    assert.equal(await side.locator(".st-label").count(), 3);
    assert.deepEqual(await side.locator(".ch-row .st-name").allTextContents(), conversations.slice(0, 3).map((c) => c.title));
    assert.equal((await side.locator(".ch-row").nth(1).locator(".ch-waiting").innerText()).trim(), "2");
    assert.equal(await page.locator(".chats > .ch-list").count(), 0, "the list is not also in the page");
    assert.equal(await page.locator(".workspace > .alfred").count(), 0, "no panel beside the Chats page");

    // Picking one opens it in the page.
    await side.locator(".ch-row").first().click();
    await page.locator(".chats .ch-open .turns .turn").first().waitFor();
    assert.equal(await side.locator('.ch-row[aria-current="true"] .st-name').innerText(), conversations[0].title);
    await shot("open");

    // Rename from the ⋯ menu, inline.
    await side.locator(".ch-row").nth(2).hover();
    await side.locator(".ch-row").nth(2).locator(".ch-more").click();
    await side.locator(".ch-menu button").first().click();
    await side.locator(".ch-rename").fill(zh ? "每周跑三次" : "Three runs a week");
    await side.locator(".ch-rename").press("Enter");
    await page.waitForFunction(() => true);
    assert.equal(renamed.at(-1)?.title, zh ? "每周跑三次" : "Three runs a week");

    // No overlapping text in the sidebar.
    const overlaps = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll(".side-host .st-name, .side-host .st-count, .side-host .st-label, .side-back span")].map((el) => el.getBoundingClientRect()).filter((box) => box.width && box.height);
      let hits = 0;
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) hits++;
      }
      return hits;
    });
    assert.equal(overlaps, 0);
    if (process.env.SHOTS) { await page.emulateMedia({ colorScheme: "dark" }); await shot("dark"); await page.emulateMedia({ colorScheme: "light" }); }

    // New chat: an empty conversation, the row marked.
    await side.locator(".st-node").first().click();
    await page.locator(".chats .ch-open .empty").waitFor();

    // Sidebar folded: the list comes into the page, beside the conversation.
    await page.keyboard.press("Meta+Backslash");
    await page.locator(".chats > .ch-list").waitFor();
    await page.locator(".chats .ch-open").waitFor();
    await shot("folded");
    await page.keyboard.press("Meta+Backslash");
    await page.locator(".chats > .ch-list").waitFor({ state: "detached" });

    // Phone: the list first, then tap in, and back.
    await page.setViewportSize({ width: 390, height: 800 });
    await page.reload();
    await page.locator(".chats[data-narrow] > .ch-list").waitFor();
    assert.equal(await page.locator(".chats .ch-open").count(), 0);
    await shot("phone-list");
    await page.locator(".chats > .ch-list .ch-row").first().click();
    await page.locator(".chats .ch-open .turns .turn").first().waitFor();
    await shot("phone-open");
    await page.locator(".chats .ch-head .icon-btn").click();
    await page.locator(".chats > .ch-list").waitFor();
  });
}
