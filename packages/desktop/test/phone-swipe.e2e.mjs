/** Run after npm run build:ui with Chrome installed: node packages/desktop/test/phone-swipe.e2e.mjs
 * (UI_DIST=<folder> tests a build made elsewhere, leaving the running app's own dist alone; SHOTS=<folder> keeps
 * screenshots of each swipe half done). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const at = (minutes) => new Date(Date.UTC(2026, 10, 24, 10, 0) - minutes * 60_000).toISOString();
const message = (id, from, subject, minutes) => ({
  id, account: "me@example.com", threadId: id, from, fromEmail: `${id}@example.com`, subject, snippet: `About ${subject.toLowerCase()}`,
  receivedAt: at(minutes), unread: true, important: false, starred: false, inInbox: true, category: "primary", link: "https://mail.example.com/",
});

async function open(t, { width = 390, locale = "en" } = {}) {
  const browser = await chromium.launch({ channel: "chrome" });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
  const state = {
    protocol: 1, cursor: 0, areas: [], receipts: {}, conversations: [], projects: [], proposals: [],
    settings: { locale, pages: { order: [] } }, automations: [], runs: [], notices: [],
    views: { calendar: [{ id: "week", title: "Calendar" }], todo: [{ id: "list", title: "Todos" }], mail: [{ id: "inbox", title: "Mail" }] },
    modules: {
      calendar: { today: "2026-11-24", from: "2026-11-01", to: "2026-12-31", events: [], pending: [], sources: [] },
      todo: { today: "2026-11-24", todos: [] },
      mail: {
        messages: [message("m1", "Ada Example", "Code discussion on Thursday", 30), message("m2", "Health Office", "Your records are complete", 90),
          message("m3", "Sam Sample", "Lunch next week?", 200)],
        sources: [{ account: "me@example.com", syncedAt: at(1), error: null, reconnect: false, canRead: true, canSend: true, canModify: true }],
        sent: [],
      },
    },
  };
  const archived = [];
  const dist = process.env.UI_DIST ? pathToFileURL(`${process.env.UI_DIST.replace(/\/$/, "")}/`) : new URL("../../ui/dist/", import.meta.url);
  await page.route("**/*", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === "/api/state") return route.fulfill({ json: state });
    if (pathname === "/api/remote") return route.fulfill({ json: { local: false, device: { id: "phone-1", name: "Phone", kind: "phone" } } });
    if (pathname === "/api/device/web-lock") return route.fulfill({ json: { enabled: false, locked: false, expiresAt: null } });
    if (pathname === "/api/events") return route.fulfill({ status: 204 });
    if (pathname === "/api/ops/mail.archive") {
      const { input } = request.postDataJSON();
      archived.push(input.id);
      for (const each of state.modules.mail.messages) if (each.id === input.id) each.inInbox = false;
      state.cursor++;
      return route.fulfill({ json: { result: { queued: "job-1" } } });
    }
    if (pathname.startsWith("/api/")) return route.fulfill({ json: {} });
    return route.fulfill({ path: fileURLToPath(new URL(pathname.slice(1) || "index.html", dist)) });
  });
  const cdp = await page.context().newCDPSession(page);
  /** A finger put down at `from`, moved in steps to `to`, and lifted unless `hold`. */
  const swipe = async (from, to, { hold = false, steps = 12 } = {}) => {
    const point = ([x, y]) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(from) });
    for (let i = 1; i <= steps; i++) {
      const x = from[0] + (to[0] - from[0]) * i / steps, y = from[1] + (to[1] - from[1]) * i / steps;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point([x, y]) });
      await page.waitForTimeout(16);
    }
    if (!hold) await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const lift = () => cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const shot = async (name) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}-${locale}-${width}.png` }); };
  return { page, state, archived, swipe, lift, shot };
}

const middle = async (locator) => { const box = await locator.boundingBox(); return [box.x + box.width / 2, box.y + box.height / 2]; };

for (const [locale, width, archiveWord] of [["en", 390, "Archive"], ["zh", 320, "归档"]]) {
  test(`a mail row swiped leftwards is archived; a short or up-and-down swipe is not (${locale}, ${width}px)`, async (t) => {
    const { page, archived, swipe, lift, shot } = await open(t, { width, locale });
    await page.goto("https://alfred.test/#p=mail.inbox");
    const rows = page.locator(".mail-list-entry");
    await rows.first().waitFor();
    assert.equal(await rows.count(), 3);
    assert.equal(await rows.getByRole("button", { name: new RegExp(`^${archiveWord} · `) }).count(), 0, "swiping archives: no button for it");
    assert.equal(await rows.locator(".mail-message-action").count(), 3, "the star stays");

    // Half way: the row has moved, the green with its word shows under it, and nothing has been asked yet.
    const first = rows.nth(0);
    const [x, y] = await middle(first);
    await swipe([width - 60, y], [width - 60 - width * 0.3, y], { hold: true });
    assert.ok((await first.locator(".mail-list-face").evaluate((face) => new DOMMatrix(getComputedStyle(face).transform).m41)) < -50, "the row follows the finger leftwards");
    const under = first.locator(".mail-swipe-under");
    assert.equal((await under.textContent()).trim(), archiveWord);
    assert.ok(await under.evaluate((el) => el.scrollWidth <= el.clientWidth), "the word fits");
    await shot("row-pulled");
    await lift();
    await page.waitForTimeout(300);
    assert.deepEqual(archived, [], "not far enough: it comes back");
    assert.equal(await first.locator(".mail-list-face").evaluate((face) => new DOMMatrix(getComputedStyle(face).transform).m41), 0);
    assert.equal(await page.locator(".mail-split[data-reading]").count(), 0, "a swipe is not a tap that opens it");

    // Up and down is the list scrolling.
    await swipe([x, y], [x + 8, y + 120]);
    await page.waitForTimeout(200);
    assert.deepEqual(archived, []);

    // Far enough: archived, and it leaves the list.
    await swipe([width - 60, y], [width - 60 - width * 0.6, y], { hold: true });
    assert.ok(await first.getAttribute("data-armed"), "far enough to archive");
    await shot("row-armed");
    await lift();
    await page.waitForFunction(() => document.querySelectorAll(".mail-list-entry").length === 2);
    assert.deepEqual(archived, ["m1"]);
    await page.getByRole("status").filter({ hasText: /./ }).waitFor();

    // A tap still opens a message.
    await rows.first().locator(".mail-row").tap();
    await page.locator(".mail-split[data-reading]").waitFor();
  });
}

test("a swipe in from the screen's edge goes to the page beside this one in the dock", async (t) => {
  const { page, swipe, lift, shot } = await open(t);
  const heading = (name) => page.getByRole("heading", { name, exact: true, level: 1 });
  await page.goto("https://alfred.test/#p=core.today");
  await heading("Today").waitFor();

  // Pulled a little: the next page's mark comes out of the edge; let go there and nothing changes.
  await swipe([388, 400], [350, 404], { hold: true });
  await page.locator(".edge-pull[data-side=right]").waitFor();
  await lift();
  await page.waitForTimeout(150);
  await heading("Today").waitFor();
  assert.equal(await page.locator(".edge-pull").count(), 0);

  await swipe([388, 400], [250, 404], { hold: true });
  assert.ok(await page.locator(".edge-pull").getAttribute("data-armed"), "far enough to turn");
  await shot("edge-armed");
  await lift();
  await heading("Inbox").waitFor();
  await swipe([388, 400], [250, 404]);
  await heading("Calendar").waitFor();
  await swipe([2, 400], [150, 404]);
  await heading("Inbox").waitFor();
  await swipe([2, 400], [150, 404]);
  await heading("Today").waitFor();
  await swipe([2, 400], [150, 404]);
  await page.waitForTimeout(150);
  await heading("Today").waitFor();

  // Mail is not in the dock: it sits after Todos, as in the sidebar. A swipe at the edge of a mail row is the page's.
  await page.goto("https://alfred.test/#p=mail.inbox");
  const row = page.locator(".mail-list-entry").first();
  const [, y] = await middle(row);
  await swipe([2, y], [180, y]);
  await heading("Todos").waitFor();
});
