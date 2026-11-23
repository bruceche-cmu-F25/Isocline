/** After building the UI, run `node packages/desktop/test/project-conversation.e2e.mjs` with Chrome installed. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

async function workspace(page) {
  const dist = process.env.UI_DIST ? pathToFileURL(`${process.env.UI_DIST.replace(/\/$/, "")}/`) : new URL("../../ui/dist/", import.meta.url);
  const date = "2026-01-01T10:00:00Z";
  const projects = ["First", "Empty"].map((name) => ({ id: name.toLowerCase(), name, createdAt: date, trustedAt: date, path: `/sample/${name}` }));
  const original = { id: "old", title: "Previous work", projectId: projects[0].id, mode: "ask", model: null, thinking: null,
    base: null, archivedAt: null, createdAt: date, updatedAt: date, busy: 0, attention: 0, lastGoal: null };
  const state = { protocol: 1, cursor: 0, modules: {}, views: {}, areas: [], receipts: {}, conversations: [original], projects,
    settings: { locale: "en", firstRunAt: date }, devAccess: "allowed", proposals: [], automations: [], runs: [], notices: [] };
  const created = [], runs = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (!pathname.startsWith("/api/")) return route.fulfill({ path: fileURLToPath(new URL(pathname.slice(1) || "index.html", dist)) });
    const json = (value) => route.fulfill({ json: value });
    if (pathname === "/api/state") return json(state);
    if (pathname === "/api/events") return route.fulfill({ status: 204 });
    if (pathname === "/api/device/web-lock") return json({ enabled: false, locked: false, expiresAt: null });
    if (pathname === "/api/models") return json({ models: [] });
    if (pathname === "/api/conversations") {
      const body = request.postDataJSON();
      created.push(body);
      const conversation = { ...original, id: "new", title: body.title, projectId: body.projectId };
      state.conversations.push(conversation);
      return json(conversation);
    }
    if (pathname === "/api/runs") {
      runs.push(request.postDataJSON());
      return json({ run: { id: "run-1", conversationId: runs.at(-1).conversationId } });
    }
    const conversation = state.conversations.find((row) => pathname === `/api/conversations/${row.id}`);
    if (conversation) return json({ conversation, runs: [], activity: {}, receipts: {} });
    if (pathname.endsWith("/changes")) return json({ files: [], base: null, branch: null });
    if (pathname.endsWith("/processes")) return json({ processes: [] });
    return json({});
  });
  return { created, runs };
}

for (const phone of [false, true]) {
  test(`project + on ${phone ? "phone" : "desktop"} selects the project and waits for the first message`, async (t) => {
    const browser = await chromium.launch({ channel: "chrome" });
    t.after(() => browser.close());
    const page = await browser.newPage({ locale: "en-US", serviceWorkers: "block", ...(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {}) });
    page.setDefaultTimeout(6000);
    const { created, runs } = await workspace(page);
    await page.goto(phone ? "https://alfred.test/#p=core.today" : "https://alfred.test/#p=core.dev&s=old");
    if (!phone) await page.locator(".dev-session").getByRole("heading", { name: "Previous work" }).waitFor();

    const field = page.locator(".dev-new .composer textarea");
    async function selectProject(name, expectedDraft = "") {
      if (phone) await page.getByRole("button", { name: "Menu", exact: true }).tap();
      const action = page.getByRole("button", { name: `New conversation in ${name}`, exact: true });
      if (phone) await action.tap();
      else { await action.focus(); await action.press("Enter"); }
      await page.getByRole("button", { name: `Switch project, currently ${name}` }).waitFor();
      await page.waitForFunction(() => document.activeElement === document.querySelector(".dev-new .composer textarea"));
      if (phone) await page.locator(".sidebar[data-visible]").waitFor({ state: "hidden" });
      assert.equal(await field.inputValue(), expectedDraft);
    }
    await selectProject("Empty");
    await field.fill("Draft for Empty");
    await selectProject("First");
    await field.fill("Draft for First");
    await selectProject("Empty", "Draft for Empty");
    await selectProject("Empty", "Draft for Empty");
    assert.deepEqual([created, runs], [[], []]);
    await field.fill("Review the selected project");
    await page.locator(".dev-new .send").click();
    await page.locator(".dev-session").getByRole("heading", { name: "Review the selected project" }).waitFor();
    assert.deepEqual(created.map(({projectId}) => projectId), ["empty"]);
    assert.deepEqual(runs.map(({conversationId, goal}) => [conversationId, goal]), [["new", "Review the selected project"]]);
  });
}
