import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

// The screenshot regression depends on the space left by the desktop sidebar, not just viewport width.
const dist = process.env.UI_DIST ? pathToFileURL(process.env.UI_DIST.replace(/\/$/, "") + "/") : new URL("../../ui/dist/", import.meta.url);
const now = "2026-01-01T12:00:00Z";
const project = { id: "project", name: "Isocline", path: "/Users/sample/projects/" + "long-project-name/".repeat(8), gitRoot: true, trustedAt: now, createdAt: now };
const branches = { current: "main", branches: [{ name: "main", checkedOut: true }, { name: "topic/existing", checkedOut: false }] };
const models = [{ id: "one", name: "Project default model", provider: "fixture", reasoning: true, engineDefault: true },
  { id: "two", name: "Another model", provider: "fixture", reasoning: true }];

async function fixture(page) {
  const writes = [];
  const chat = { id: "session", title: "Review changes", projectId: project.id, busy: 0, attention: 0, updatedAt: now, createdAt: now };
  const earlier = { ...chat, id: "older", title: "An earlier session", base: "abc123", mode: "edits", archivedAt: null };
  const state = { protocol: 1, cursor: 0, modules: {}, views: {}, areas: [], receipts: {}, conversations: [earlier], projects: [project],
    settings: { locale: "en", firstRunAt: now }, devAccess: "allowed", proposals: [], automations: [], runs: [], notices: [] };
  await page.route("**/*", (route) => {
    const { pathname } = new URL(route.request().url());
    if (!pathname.startsWith("/api/")) return route.fulfill({ path: fileURLToPath(new URL(pathname.slice(1) || "index.html", dist)) });
    const reply = (json) => route.fulfill({ json });
    switch (pathname) {
      case "/api/state": return reply(state);
      case "/api/events": return route.fulfill({ status: 204 });
      case "/api/device/web-lock": return reply({ enabled: false, locked: false, expiresAt: null });
      case "/api/remote": return reply({ local: true });
      case "/api/models": return reply({ models });
      case "/api/projects/project/branches": return reply(branches);
      case "/api/conversations": {
        const body = route.request().postDataJSON();
        writes.push(body);
        Object.assign(chat, { model: body.model, mode: body.mode ?? "edits" });
        state.conversations.push(chat);
        return reply(chat);
      }
      case "/api/runs": writes.push(route.request().postDataJSON()); return reply({ run: { id: "run", conversationId: chat.id } });
      case "/api/conversations/session": return reply({ conversation: chat, runs: [], receipts: {}, activity: {} });
      default: return reply({});
    }
  });
  return writes;
}

for (const width of [1113, 760, 360]) {
  test(`Code launcher keeps first-turn controls visible and starts with the chosen settings at ${width}px`, async (t) => {
    const browser = await chromium.launch({ channel: "chrome" });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 820 }, locale: "en-US", serviceWorkers: "block" });
    page.setDefaultTimeout(5000);
    const writes = await fixture(page);
    await page.goto("https://alfred.test/#p=core.dev");
    const launcher = page.locator(".dev-new-in");
    const model = launcher.getByRole("combobox", { name: /^Model:/ });
    const permission = launcher.getByRole("combobox", { name: /^Permission mode:/ });
    const branch = launcher.getByRole("combobox", { name: /^Work on branch:/ });
    await model.getByText(/Project default model/).filter({ visible: true }).first().waitFor();
    assert.match(await permission.innerText(), /Always allow/i);
    await branch.getByText("main", { exact: true }).waitFor();
    const overflow = await launcher.evaluate((el) => {
      const bounds = el.getBoundingClientRect();
      return [...el.querySelectorAll("button, p, .dev-note span")].filter((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && (box.left < bounds.left - 1 || box.right > bounds.right + 1 || box.right > innerWidth + 1);
      }).map((node) => node.textContent.trim());
    });
    assert.deepEqual(overflow, [], "all setup text and buttons fit inside the launcher");
    await branch.click();
    await page.getByRole("option", { name: "topic/existing", exact: true }).click();
    await model.click();
    await page.getByRole("option", { name: /Another model/ }).click();
    await permission.click();
    await page.getByRole("option", { name: /ask/i }).click();
    await launcher.getByRole("textbox").fill("Review changes");
    await launcher.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForURL(/s=session/);
    assert.deepEqual(writes.map((body) => [body.projectId, body.model, body.branch, body.mode, body.conversationId]), [
      ["project", "fixture/two", "topic/existing", "ask", undefined],
      [undefined, undefined, undefined, undefined, "session"],
    ]);
  });
}
