/** Run after npm run build:ui with Chrome installed: node packages/desktop/test/chat-polish.e2e.mjs
 * (UI_DIST=<folder> tests a build made elsewhere; SHOTS=<folder> keeps screenshots). On the Chats page: a reply can be
 * copied; a code block says its language, is coloured and has its own copy button; scrolled up, a button brings the
 * reader back to the latest. Zirma's panel beside a page keeps the reply's copy button too. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const now = new Date().toISOString();
const CODE = 'const total = items.reduce((sum, item) => sum + item.price, 0); // in cents\nreturn "done";';
const conversation = (id, title) => ({
  id, title, createdAt: now, updatedAt: now, archivedAt: null, model: null, thinking: null, speed: null, busy: 0, attention: 0,
  lastGoal: title, projectId: null, mode: null, base: null,
});
const run = (id, goal, reply) => ({
  id, requestId: id, conversationId: "c1", goal, profile: "chat", state: "completed", createdAt: now, updatedAt: now, attempt: 1,
  leaseOwner: null, leaseUntil: null, cancelRequested: false, outcome: { status: "completed", reply, receipts: [] }, request: null, context: null, automationId: null,
});

for (const locale of ["en", "zh"]) for (const [width, height] of [[1280, 800], [390, 780]]) {
  test(`Chats: copy, code blocks, back to the latest (${locale}, ${width}px)`, async (t) => {
    const browser = await chromium.launch({ channel: "chrome" });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width, height } });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://zirma.test" });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const zh = locale === "zh";
    const open = conversation("c1", zh ? "购物车合计" : "Cart total");
    const filler = zh ? "这一段是为了让对话足够长，好往上翻。" : "This paragraph makes the conversation long enough to scroll.";
    const runs = [
      ...Array.from({ length: 8 }, (_, i) => run(`r${i}`, `${zh ? "问题" : "Question"} ${i + 1}`, Array(6).fill(filler).join("\n\n"))),
      run("r9", zh ? "怎么算合计？" : "How do I add up the cart?", `${zh ? "这样写：" : "Like this:"}\n\n\`\`\`ts\n${CODE}\n\`\`\`\n\n${zh ? "单位是分。" : "Amounts are in cents."}`),
    ];
    const state = {
      protocol: 1, cursor: 0, areas: [], receipts: {}, conversations: [open], projects: [], proposals: [],
      settings: { locale, pages: { order: [] } }, automations: [], runs: [], notices: [],
      views: { todo: [{ id: "list", title: "Todos" }] }, modules: { todo: { today: "2026-11-27", todos: [] } },
    };
    const dist = process.env.UI_DIST ? pathToFileURL(`${process.env.UI_DIST.replace(/\/$/, "")}/`) : new URL("../../ui/dist/", import.meta.url);
    await page.route("**/*", async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      if (pathname === "/api/state") return route.fulfill({ json: state });
      if (pathname === "/api/remote") return route.fulfill({ json: { local: true } });
      if (pathname === "/api/device/web-lock") return route.fulfill({ json: { enabled: false, locked: false, expiresAt: null } });
      if (pathname === "/api/events") return route.fulfill({ status: 204 });
      if (pathname === "/api/models") return route.fulfill({ json: { models: [] } });
      if (/^\/api\/conversations\/c1$/.test(pathname) && request.method() === "GET") return route.fulfill({ json: { conversation: open, runs, receipts: {}, activity: {}, nextCursor: null } });
      if (pathname.startsWith("/api/")) return route.fulfill({ json: {} });
      return route.fulfill({ path: fileURLToPath(new URL(pathname.slice(1) || "index.html", dist)) });
    });
    const shot = async (name) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/chat-polish-${name}-${locale}-${width}.png` }); };
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

    await page.goto("https://zirma.test/#p=core.chat&c=c1");
    const list = page.locator(".chats .ch-list");
    const turns = page.locator(".chats .turns");
    await Promise.race([turns.waitFor(), list.first().waitFor()]);
    if (!(await turns.count())) await list.locator(".st-node", { hasText: open.title }).first().click();
    await turns.waitFor();
    const last = page.locator(".chats .turn").last();
    await last.locator(".md-code-block").waitFor();

    // The code block: its language, colours, and a copy button that copies the code alone.
    assert.equal((await last.locator(".md-code-lang").innerText()).trim(), "ts");
    assert.ok(await last.locator(".md-code .tok-keyword", { hasText: "const" }).count(), "keywords are coloured");
    assert.ok(await last.locator(".md-code .tok-comment").count(), "and comments");
    assert.ok(await last.locator(".md-code .tok-string").count(), "and strings");
    assert.equal(await last.locator(".md-code").innerText(), CODE, "the words are all there, in order");
    await last.locator(".md-code-head .copy-btn").click();
    assert.equal(await clipboard(), CODE);
    await page.locator('.md-code-head .copy-btn[data-done="copied"]').waitFor();
    assert.equal((await last.locator(".md-code-head .copy-btn").innerText()).trim(), zh ? "已复制" : "Copied");
    await shot("code");

    // The reply: copied whole, as it was written.
    await last.locator(".reply-copy").click();
    assert.equal(await clipboard(), runs.at(-1).outcome.reply);
    await last.locator('.reply-copy[data-done="copied"]').waitFor();

    // Nothing overlaps or leaves the page.
    const fits = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll(".chats .md-code-head > *, .chats .turn:last-child .run-meta > *")].map((el) => el.getBoundingClientRect()).filter((box) => box.width && box.height);
      let hits = 0;
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) hits++;
      }
      return { hits, outside: boxes.filter((box) => box.left < -1 || box.right > innerWidth + 1).length, scroll: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    assert.deepEqual(fits, { hits: 0, outside: 0, scroll: false });

    // At the end there is no button; scrolled up there is, and it goes back to the end.
    const button = page.locator(".chats .to-latest");
    assert.equal(await button.count(), 0);
    await turns.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
    await button.waitFor();
    assert.equal(await button.getAttribute("aria-label"), zh ? "回到最新" : "Jump to latest");
    const composer = await page.locator(".chats .composer").boundingBox();
    const box = await button.boundingBox();
    assert.ok(box.y + box.height <= composer.y, "it sits above the composer");
    await shot("away");
    await button.click();
    await page.waitForFunction(() => { const el = document.querySelector(".chats .turns"); return el && el.scrollHeight - el.scrollTop - el.clientHeight < 40; });
    await button.waitFor({ state: "detached" });

    // Zirma's panel beside a page: no model or timing, but the reply still has its copy button.
    if (width >= 768) {
      await page.goto("https://zirma.test/#p=todo.list&c=c1");
      await page.locator('.side-nav [data-page="core.chat"]').waitFor();
      await page.keyboard.press("Meta+Period");
      const panel = page.locator(".workspace > .alfred");
      await panel.locator(".turn").last().locator(".reply-copy").waitFor();
      assert.equal(await panel.locator(".run-meta .meta-part:visible").count(), 0);
    }
  });
}
