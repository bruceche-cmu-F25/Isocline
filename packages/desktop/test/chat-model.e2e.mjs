/** Run after npm run build:ui with Chrome installed: node packages/desktop/test/chat-model.e2e.mjs
 * (UI_DIST=<folder> tests a build made elsewhere; SHOTS=<folder> keeps screenshots). The Chats page shows the model,
 * thinking and speed under the composer (docs/design/chat.md §4.1): a new chat picks them before its first message,
 * which carries them; an open one changes them in place. Zirma's panel beside a page stays without them. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const now = new Date().toISOString();
const conversation = (id, title, extra = {}) => ({
  id, title, createdAt: now, updatedAt: now, archivedAt: null, model: null, thinking: null, speed: null, busy: 0, attention: 0,
  lastGoal: title, projectId: null, mode: null, base: null, ...extra,
});
const models = [
  { id: "flash", provider: "deepseek", name: "DeepSeek Flash", reasoning: true, engineDefault: true },
  { id: "gpt-5.4", provider: "openai", name: "GPT-5.4", reasoning: true },
];

for (const locale of ["en", "zh"]) for (const [width, height] of [[1280, 800], [390, 780]]) {
  test(`Chats: model under the composer (${locale}, ${width}px)`, async (t) => {
    const browser = await chromium.launch({ channel: "chrome" });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height } });
    page.setDefaultTimeout(5000);
    const zh = locale === "zh";
    const open = conversation("c1", zh ? "搬家清单" : "Moving checklist", { model: "openai/gpt-5.4" });
    const conversations = [open];
    const state = {
      protocol: 1, cursor: 0, areas: [], receipts: {}, conversations, projects: [], proposals: [],
      settings: { locale, pages: { order: [] }, model: "deepseek/flash" }, automations: [], runs: [], notices: [],
      views: { todo: [{ id: "list", title: "Todos" }] }, modules: { todo: { today: "2026-11-27", todos: [] } },
    };
    const submitted = [], updated = [];
    const dist = process.env.UI_DIST ? pathToFileURL(`${process.env.UI_DIST.replace(/\/$/, "")}/`) : new URL("../../ui/dist/", import.meta.url);
    await page.route("**/*", async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      if (pathname === "/api/state") return route.fulfill({ json: state });
      if (pathname === "/api/remote") return route.fulfill({ json: { local: true } });
      if (pathname === "/api/device/web-lock") return route.fulfill({ json: { enabled: false, locked: false, expiresAt: null } });
      if (pathname === "/api/events") return route.fulfill({ status: 204 });
      if (pathname === "/api/models") return route.fulfill({ json: { models } });
      if (pathname === "/api/runs" && request.method() === "POST") {
        const body = request.postDataJSON();
        submitted.push(body);
        const made = conversation("c2", body.goal, { model: body.model ?? null, thinking: body.thinking ?? null, speed: body.speed ?? null });
        return route.fulfill({ status: 202, json: { replayed: false, run: { id: "r2", requestId: body.requestId, conversationId: made.id, goal: body.goal, profile: "chat", state: "queued",
          createdAt: now, updatedAt: now, attempt: 0, leaseOwner: null, leaseUntil: null, cancelRequested: false, outcome: null, request: null, context: null, automationId: null } } });
      }
      const one = pathname.match(/^\/api\/conversations\/([^/]+)$/);
      if (one && request.method() === "GET") {
        const found = one[1] === "c1" ? open : conversation(one[1], "hi", { model: submitted.at(-1)?.model ?? null, thinking: submitted.at(-1)?.thinking ?? null });
        return route.fulfill({ json: { conversation: found, runs: [], receipts: {}, activity: {}, nextCursor: null } });
      }
      if (one) { updated.push(request.postDataJSON()); return route.fulfill({ json: { conversation: open } }); }
      if (pathname.startsWith("/api/")) return route.fulfill({ json: {} });
      return route.fulfill({ path: fileURLToPath(new URL(pathname.slice(1) || "index.html", dist)) });
    });
    const shot = async (name) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/chat-model-${name}-${locale}-${width}.png` }); };
    const row = page.locator(".chats .ch-open .session-settings");
    const picker = row.locator(".model-picker");
    const fits = () => page.evaluate(() => {
      const boxes = [...document.querySelectorAll(".chats .session-settings-row > *, .chats .composer-bar > *")].map((el) => el.getBoundingClientRect()).filter((box) => box.width && box.height);
      let hits = 0;
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) hits++;
      }
      const outside = boxes.filter((box) => box.left < -1 || box.right > innerWidth + 1).length;
      // The row lines up with the composer above it.
      const composer = document.querySelector(".chats .composer")?.getBoundingClientRect();
      const settings = document.querySelector(".chats .session-settings")?.getBoundingClientRect();
      const aligned = !!composer && !!settings && Math.abs(composer.left - settings.left) <= 1 && Math.abs(composer.right - settings.right) <= 1;
      return { hits, outside, scroll: document.documentElement.scrollWidth > innerWidth + 1, aligned };
    });

    // On a phone the list comes first: tap into the chat.
    const into = async (hash, title) => {
      await page.goto(`https://zirma.test/#${hash}`);
      const list = page.locator(".chats > .ch-list, .chats .ch-list");
      await Promise.race([row.waitFor(), list.first().waitFor()]);
      if (!(await row.count())) {
        const node = title ? list.locator(".st-node", { hasText: title }) : list.locator(".st-node").first();
        await node.first().click();
      }
      await row.waitFor();
    };

    // A new chat: the row is there before the first message, on the default.
    await into("p=core.chat");
    await page.waitForFunction(() => /DeepSeek Flash/.test(document.querySelector(".chats .model-picker")?.getAttribute("aria-label") ?? ""));
    assert.deepEqual(await fits(), { hits: 0, outside: 0, scroll: false, aligned: true }, "nothing overlaps or leaves the page");
    await shot("new");

    // Picked before sending, the first message carries the model and the level.
    await picker.click();
    await page.getByRole("option", { name: /GPT-5\.4/ }).click();
    await row.locator(".session-tuning").click();
    await row.getByRole("combobox", { name: zh ? /思考强度/ : /^Thinking/ }).click();
    await page.getByRole("option", { name: zh ? "多想" : "Think hard", exact: true }).click();
    assert.deepEqual(await fits(), { hits: 0, outside: 0, scroll: false, aligned: true }, "with the options open, too");
    await shot("picked");
    await page.locator(".chats .composer textarea").fill(zh ? "你好" : "hi");
    await page.locator(".chats .composer .send").click();
    await page.waitForFunction(() => location.hash.includes("c2"));
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].model, "openai/gpt-5.4");
    assert.equal(submitted[0].thinking, "high");
    assert.equal(submitted[0].conversationId, undefined, "it starts the conversation");

    // An open chat: its own model shown, a change goes to that conversation.
    await into("p=core.chat&c=c1", open.title);
    await page.waitForFunction(() => /GPT-5\.4/.test(document.querySelector(".chats .model-picker")?.getAttribute("aria-label") ?? ""));
    await picker.click();
    await page.getByRole("option", { name: /DeepSeek Flash · deepseek/ }).click();
    await page.waitForFunction(() => true);
    assert.equal(updated.at(-1)?.model, "deepseek/flash");
    assert.equal(await page.locator(".chats .session-settings .mode").count(), 0, "permission modes are for sessions only");

    // Zirma's panel beside a page keeps to the words.
    if (width >= 768) {
      await page.goto("https://zirma.test/#p=todo.list");
      await page.locator('.side-nav [data-page="core.chat"]').waitFor();
      await page.keyboard.press("Meta+Period");
      await page.locator(".workspace > .alfred .composer").waitFor();
      assert.equal(await page.locator(".workspace > .alfred .session-settings").count(), 0);
    }
  });
}
