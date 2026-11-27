/** Run after npm run build:ui with Chrome installed: node packages/desktop/test/mail-side.e2e.mjs
 * (UI_DIST=<folder> tests a build made elsewhere; SHOTS=<folder> keeps screenshots). Mail's places live in the app
 * sidebar while it has room (workspace-architecture.md §6, a page's own sidebar), and in the page when it has none. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const at = (minutes) => new Date(Date.UTC(2026, 10, 24, 10, 0) - minutes * 60_000).toISOString();
const message = (id, from, subject, minutes, extra = {}) => ({
  id, account: "me@example.com", threadId: id, from, fromEmail: `${id}@example.com`, subject, snippet: `About ${subject.toLowerCase()}`,
  receivedAt: at(minutes), unread: false, important: false, starred: false, inInbox: true, category: "primary", link: "https://mail.example.com/", ...extra,
});

for (const locale of ["en", "zh"]) {
  test(`Mail: the places sit in the sidebar, and back in the page without one (${locale})`, async (t) => {
    const browser = await chromium.launch({ channel: "chrome" });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(5000);
    const state = {
      protocol: 1, cursor: 0, areas: [], receipts: {}, conversations: [], projects: [], proposals: [],
      settings: { locale, pages: { order: [] } }, automations: [], runs: [], notices: [],
      views: { calendar: [{ id: "week", title: "Calendar" }], todo: [{ id: "list", title: "Todos" }], mail: [{ id: "inbox", title: "Mail" }] },
      modules: {
        calendar: { today: "2026-11-24", from: "2026-11-01", to: "2026-12-31", events: [], pending: [], sources: [] },
        todo: { today: "2026-11-24", todos: [] },
        mail: {
          messages: [
            message("m1", "Ada Example", "Code discussion on Thursday", 30, { unread: true }),
            message("m2", "Health Office", "Your records are complete", 90, { important: true }),
            message("m3", "Sam Sample", "Lunch next week?", 200, { unread: true, starred: true }),
          ],
          sources: [{ account: "me@example.com", syncedAt: at(1), error: null, reconnect: false, canRead: true, canSend: true, canModify: true }],
          sent: [],
        },
      },
    };
    const dist = process.env.UI_DIST ? pathToFileURL(`${process.env.UI_DIST.replace(/\/$/, "")}/`) : new URL("../../ui/dist/", import.meta.url);
    await page.route("**/*", async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/state") return route.fulfill({ json: state });
      if (pathname === "/api/remote") return route.fulfill({ json: { local: true } });
      if (pathname === "/api/device/web-lock") return route.fulfill({ json: { enabled: false, locked: false, expiresAt: null } });
      if (pathname === "/api/events") return route.fulfill({ status: 204 });
      if (pathname.startsWith("/api/")) return route.fulfill({ json: {} });
      return route.fulfill({ path: fileURLToPath(new URL(pathname.slice(1) || "index.html", dist)) });
    });
    const shot = async (name) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/mail-side-${name}-${locale}.png` }); };

    await page.goto("https://zirma.test/#p=mail.inbox");
    const side = page.locator(".side-host nav.st-list");
    await side.waitFor();
    // A new letter first, then the five places; none of them in the page.
    assert.equal(await side.locator(".st-node").count(), 6);
    assert.equal(await page.locator(".mail .mail-filters").count(), 0, "the places are not also in the page");
    assert.equal(await page.locator(".mail .mail-new").count(), 0, "a new letter is the sidebar's first row");
    assert.equal(await page.locator(".mail-category").count(), 1, "the category stays in the page");
    assert.equal(await side.locator('.st-node[aria-current="true"]').count(), 1);
    assert.equal(await page.locator(".mail-list .mail-row").count(), 3);
    await shot("inbox");

    // A place in the sidebar filters the page; its count is the page's.
    await side.locator(".st-node").nth(2).click();
    await page.waitForFunction(() => document.querySelectorAll(".mail-list .mail-row").length === 2);
    assert.equal(await side.locator(".st-node").nth(2).getAttribute("aria-current"), "true");
    assert.equal((await side.locator(".st-node").nth(2).locator(".st-count").innerText()).trim(), "2");

    // No overlapping text in the sidebar.
    const overlaps = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll(".side-host .st-name, .side-host .st-count, .side-back span")].map((el) => el.getBoundingClientRect()).filter((box) => box.width && box.height);
      let hits = 0;
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) hits++;
      }
      return hits;
    });
    assert.equal(overlaps, 0);

    if (process.env.SHOTS) {
      await page.emulateMedia({ colorScheme: "dark" });
      await shot("dark");
      await page.emulateMedia({ colorScheme: "light" });
    }

    // Sidebar folded away: the places come back into the page as before.
    await page.keyboard.press("Meta+Backslash");
    await page.locator(".mail .mail-filters").waitFor();
    await page.locator(".mail .mail-new").waitFor();
    await shot("folded");
    await page.keyboard.press("Meta+Backslash");
    await page.locator(".mail .mail-filters").waitFor({ state: "detached" });

    // A narrow window that still has the sidebar.
    await page.setViewportSize({ width: 900, height: 800 });
    await side.waitFor();
    await shot("narrow");
  });
}
