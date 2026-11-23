/** Run after npm run build:ui, with Chrome installed: node packages/desktop/test/code-skills.e2e.mjs */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

test("Code offers local skills, imports only the selected one, and uses it in new and existing sessions", async (t) => {
  const browser = await chromium.launch({ channel: "chrome" });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "en-US", serviceWorkers: "block" });
  page.setDefaultTimeout(6000);
  const dist = process.env.UI_DIST ? pathToFileURL(`${process.env.UI_DIST.replace(/\/$/, "")}/`) : new URL("../../ui/dist/", import.meta.url);
  const date = "2026-01-01T10:00:00Z";
  const project = { id: "project-1", name: "Test project", path: "/sample", trustedAt: date, createdAt: date };
  const conversation = { id: "session-1", title: "Skill test", projectId: project.id, mode: "ask", model: null, thinking: null,
    base: null, archivedAt: null, createdAt: date, updatedAt: date, busy: 0, attention: 0, lastGoal: null };
  const state = { protocol: 1, cursor: 0, modules: {}, views: {}, areas: [], receipts: {}, conversations: [], projects: [project],
    settings: { locale: "en", firstRunAt: date }, devAccess: "allowed", proposals: [], automations: [], runs: [], notices: [] };
  const local = { name: "apple-design", description: "Design Apple-style components", place: ".pi/agent/skills", path: "/sample/skills/apple-design" };
  const installed = { name: local.name, description: local.description, id: local.name, enabled: true };
  const catalog = { skills: [{ id: "disabled", name: "disabled", enabled: false, description: "Not available" }], found: [local], problems: [] };
  const writes = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (!pathname.startsWith("/api/")) return route.fulfill({ path: fileURLToPath(new URL(pathname.slice(1) || "index.html", dist)) });
    if (request.method() === "POST" && pathname !== "/api/outlets") writes.push({ pathname, body: request.postDataJSON() });
    const json = (body) => route.fulfill({ json: body });
    switch (pathname) {
      case "/api/state": return json(state);
      case "/api/events": return route.fulfill({ status: 204 });
      case "/api/device/web-lock": return json({ enabled: false, locked: false, expiresAt: null });
      case "/api/remote": return json({ local: true });
      case "/api/skills": return json(catalog);
      case "/api/skills/add": {
        assert.equal(request.postDataJSON().path, local.path);
        catalog.skills.push(installed);
        catalog.found = [];
        return json(installed);
      }
      case "/api/conversations": state.conversations = [conversation]; return json(conversation);
      case "/api/runs": return json({ run: { id: "run-1", conversationId: conversation.id } });
      case "/api/conversations/session-1": return json({ conversation, runs: [], activity: {}, receipts: {} });
      case "/api/conversations/session-1/changes": return json({ files: [], base: null, branch: null });
      case "/api/conversations/session-1/processes": return json({ processes: [] });
      case "/api/models": return json({ models: [] });
      default: return json({});
    }
  });

  await page.goto("https://alfred.test/#p=core.dev");
  const field = page.locator(".dev-stage .composer textarea");
  const menu = page.getByRole("listbox", { name: "Skills" });
  const apple = menu.getByRole("option", { name: /apple-design/i });
  await field.fill("/");
  await apple.waitFor();
  assert.equal(await menu.getByRole("option", { name: /disabled/i }).count(), 0);
  await field.fill("/missing-skill");
  await page.getByRole("status").filter({ hasText: "Nothing found" }).waitFor();
  assert.equal(await menu.getByRole("option").count(), 0);
  await field.fill("/tmp/project/file.ts");
  await menu.waitFor({ state: "hidden" });
  await field.fill("/apple");
  await apple.waitFor();
  assert.match(await apple.textContent(), /add/i);
  assert.deepEqual(writes, [], "filtering does not install a skill or start a conversation");
  await field.press("Enter");
  await page.waitForFunction(() => document.querySelector(".dev-stage .composer textarea")?.value === "/skill:apple-design ");
  await menu.waitFor({ state: "hidden" });
  assert.deepEqual(writes.map(write => write.pathname), ["/api/skills/add"]);

  await field.press("End");
  await field.pressSequentially("Sketch a control");
  await field.press("Enter");
  await page.locator(".dev-session .composer textarea").waitFor();
  assert.equal(writes.find(write => write.pathname === "/api/runs")?.body.goal, "/skill:apple-design Sketch a control");
  await field.fill("/apple");
  await apple.waitFor();
  assert.doesNotMatch(await apple.textContent(), /add & use/i);
  await field.press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await field.inputValue(), "/apple");
  await field.fill("/");
  await apple.click();
  assert.equal(await field.inputValue(), "/skill:apple-design ");
  assert.equal(writes.filter(write => write.pathname === "/api/skills/add").length, 1);
  assert.equal(writes.filter(write => write.pathname === "/api/runs").length, 1);
});
