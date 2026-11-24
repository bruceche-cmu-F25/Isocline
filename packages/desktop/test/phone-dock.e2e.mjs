/** Run after npm run build:ui with Chrome installed: node packages/desktop/test/phone-dock.e2e.mjs
 * (UI_DIST=<folder> tests a build made elsewhere, leaving the running app's own dist alone). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

async function serveBuild(page) {
  const state = {
    protocol: 1, cursor: 0, modules: {}, views: {}, areas: [], receipts: {}, conversations: [],
    projects: [], proposals: [], settings: { locale: "en" }, automations: [], runs: [], notices: [],
  };
  const dist = process.env.UI_DIST ? pathToFileURL(`${process.env.UI_DIST.replace(/\/$/, "")}/`) : new URL("../../ui/dist/", import.meta.url);
  await page.route("**/*", (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/state") return route.fulfill({ json: state });
    if (pathname === "/api/device/web-lock") return route.fulfill({ json: { enabled: false, locked: false, expiresAt: null } });
    if (pathname === "/api/events") return route.fulfill({ status: 204 });
    if (pathname.startsWith("/api/")) return route.fulfill({ json: {} });
    return route.fulfill({ path: fileURLToPath(new URL(pathname.slice(1) || "index.html", dist)) });
  });
  return state;
}

test("a paired phone can open Models and refresh its subscription usage", async (t) => {
  const browser = await chromium.launch({ channel: "chrome" });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
  await serveBuild(page);
  let identifyPhone = Promise.resolve();
  await page.route("**/api/remote", async (route) => {
    await identifyPhone;
    await route.fulfill({ json: { local: false, device: { id: "phone-1", name: "Phone", kind: "phone" } } });
  });
  const managementRequests = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/connections/") && pathname !== "/api/connections/models/usage") managementRequests.push(pathname);
  });
  let result = "ready";
  await page.route("**/api/connections/models/usage*", (route) => {
    if (result === "error") return route.fulfill({ status: 503, json: { error: "Unavailable" } });
    const fresh = new URL(route.request().url()).searchParams.get("fresh") === "1";
    const now = Date.now();
    return route.fulfill({ json: { usage: result === "empty" ? [] : [{
      provider: "openai-codex", plan: "pro", status: "ready", checkedAt: now,
      windows: [{ id: "primary", minutes: 300, used: fresh ? 45 : 42, resetsAt: now + 3 * 60 * 60_000 }],
    }] } });
  });

  await page.goto("https://alfred.test/");
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const models = page.getByRole("tab", { name: "Models" });
  await models.click();
  const pane = page.getByRole("tabpanel", { name: "Models" });
  await pane.getByText("ChatGPT (Codex)", { exact: true }).waitFor();
  await pane.getByText("42%", { exact: true }).waitFor();
  const meter = pane.getByRole("meter", { name: "5 hours" });
  assert.equal(await meter.getAttribute("aria-valuenow"), "42");
  await pane.getByText("resets in 3 hours").waitFor();
  assert.ok(await pane.evaluate((el) => el.scrollWidth <= el.clientWidth), "usage fits the phone");
  await pane.getByRole("button", { name: "Refresh" }).click();
  await pane.getByText("45%", { exact: true }).waitFor();
  assert.equal(await meter.getAttribute("aria-valuenow"), "45");

  // Restore Models before /api/remote has answered. Only usage may be requested, even during this handoff.
  const gate = Promise.withResolvers();
  identifyPhone = gate.promise;
  result = "empty";
  const identifying = page.waitForRequest("**/api/remote");
  await page.reload();
  await identifying;
  gate.resolve();
  await pane.getByText(/No subscription usage to show/).waitFor();
  assert.equal(await models.getAttribute("aria-selected"), "true");
  assert.equal(await pane.getByRole("meter").count(), 0);
  assert.equal(await pane.getByText("Use an API key", { exact: true }).count(), 0);
  result = "error";
  await pane.getByRole("button", { name: "Refresh" }).click();
  await pane.getByRole("alert").filter({ hasText: "Couldn't check usage" }).waitFor();
  result = "ready";
  await pane.getByRole("button", { name: "Refresh" }).click();
  await pane.getByText("45%", { exact: true }).waitFor();
  assert.deepEqual(managementRequests, []);
});

test("the phone's fourth Dock shortcut can be changed or removed in General settings", async (t) => {
  const browser = await chromium.launch({ channel: "chrome" });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const state = await serveBuild(page);
  state.views = {
    calendar: [{ id: "week", title: "Calendar" }], todo: [{ id: "list", title: "Todos" }], link: [{ id: "list", title: "Links" }],
  };
  state.modules = {
    calendar: { today: "2026-11-21", from: "2026-11-01", to: "2026-12-31", events: [], pending: [], sources: [] },
    todo: { today: "2026-11-21", todos: [] }, link: { places: [], clips: [], topics: [] },
  };
  const dock = page.locator(".dock");
  const tabs = dock.locator(".dock-tabs");
  const pinnedPages = () => tabs.locator("[data-page]").evaluateAll((buttons) => buttons.map((button) => button.dataset.page));
  const primary = ["core.today", "core.inbox", "calendar.week"];
  const openSettings = async () => {
    await dock.getByRole("button", { name: "Menu", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  };
  const setting = page.getByRole("combobox", { name: /^Dock shortcut: / });
  const shown = () => setting.locator(".choice-value").textContent();
  const pick = async (name) => { await setting.click(); await page.getByRole("option", { name, exact: true }).click(); };
  await page.goto("https://alfred.test/");
  await dock.getByRole("button", { name: "Todos" }).waitFor();
  assert.deepEqual(await pinnedPages(), [...primary, "todo.list"]);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await dock.evaluate((nav) => {
      const pill = nav.querySelector(".dock-tabs").getBoundingClientRect();
      const alfred = nav.querySelector(".dock-alfred").getBoundingClientRect();
      return pill.left >= 0 && pill.right <= alfred.left && alfred.right <= window.innerWidth &&
        [...nav.querySelectorAll(".dock-tabs button")].every((button) => button.getBoundingClientRect().right <= pill.right);
    }), `all dock buttons fit at ${width}px`);
  }
  await dock.getByRole("button", { name: "Todos" }).click();
  await page.getByRole("heading", { name: "Todos", exact: true, level: 1 }).waitFor();
  await openSettings();
  assert.equal(await shown(), "Todos");
  await setting.click();
  await page.getByRole("option", { name: "Links", exact: true }).waitFor();
  for (const label of ["Today", "Inbox", "Calendar"]) assert.equal(await page.getByRole("option", { name: label, exact: true }).count(), 0);
  await setting.press("Escape");
  await pick("Links");
  const links = dock.getByRole("button", { name: "Links", exact: true });
  await links.click();
  await page.getByRole("heading", { name: "Links", exact: true, level: 1 }).waitFor();
  assert.equal(await links.getAttribute("aria-current"), "page");
  await page.reload();
  await links.waitFor();
  assert.deepEqual(await pinnedPages(), [...primary, "link.list"]);
  await openSettings();
  assert.equal(await shown(), "Links");
  await pick("None");
  await page.reload();
  await setting.waitFor();
  assert.equal(await shown(), "None");
  assert.deepEqual(await pinnedPages(), primary);
  assert.equal(await tabs.locator(":scope > *").count(), 1 + primary.length, "only the menu and primary pages occupy the pill");

  // On a home without Calendar, Todos already belongs to the primary buttons.
  await pick("Todos");
  delete state.views.calendar;
  delete state.modules.calendar;
  await page.reload();
  await setting.waitFor();
  assert.deepEqual(await pinnedPages(), ["core.today", "core.inbox", "todo.list"]);
});

test("the wireframe animates around the centre of the phone's Zirma button", async (t) => {
  const browser = await chromium.launch({ channel: "chrome" });
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    reducedMotion: "no-preference",
  });
  await serveBuild(page);
  await page.goto("https://alfred.test/");
  const figure = page.locator(".dock-alfred svg");
  await figure.locator("line").first().waitFor({ state: "attached" });
  const { drift, sizes } = await figure.evaluate(async (svg) => {
    const button = svg.closest("button");
    const widths = new Set();
    let drift = 0;
    for (let i = 0; i < 200; i++) {
      if (i === 100) svg.dataset.speaking = "hop";
      if (i === 150) { svg.dataset.speaking = "speak"; svg.dataset.nod = "1"; }
      await new Promise(requestAnimationFrame);
      const drawing = svg.firstElementChild.getBoundingClientRect();
      if (!drawing.width) continue;
      const target = button.getBoundingClientRect();
      widths.add(drawing.width);
      drift = Math.max(drift, Math.abs(target.left + target.width / 2 - drawing.left - drawing.width / 2),
        Math.abs(target.top + target.height / 2 - drawing.top - drawing.height / 2));
    }
    return { drift, sizes: widths.size };
  });
  assert.ok(sizes > 10, "the wireframe actually animated");
  assert.ok(drift < 0.05, `wireframe centre moved ${drift} CSS pixels`);
});

/** Advance the existing animation clock and take a sample twice a second. */
async function sampleMotion(page, selectors, seconds) {
  const seen = selectors.map(() => new Set());
  for (let i = 0; i < seconds * 2; i++) {
    await page.clock.fastForward(500);
    const poses = await page.evaluate((selectors) => selectors.map((selector) => {
      const { state, move } = document.querySelector(selector).dataset;
      return [state, move].filter(Boolean);
    }), selectors);
    poses.forEach((pose, index) => pose.forEach((name) => seen[index].add(name)));
  }
  return seen;
}

test("Coding, dock and desktop figures vary at rest and yield to a real status or reduced motion", async (t) => {
  const browser = await chromium.launch({ channel: "chrome" });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 402, height: 874 }, isMobile: true });
  const snapshot = await serveBuild(page);
  await page.clock.install();
  // Let the fixture announce a changed snapshot through the same EventSource as the home node.
  await page.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      constructor() { super(); window.fixtureEvents = this; }
      close() {}
    };
  });
  await page.goto("https://alfred.test/#p=core.dev");
  const header = ".dev-new-head svg", dock = ".dock-alfred svg";
  await page.locator(header + "[data-state]").waitFor();
  const [headerPoses, dockPoses] = await sampleMotion(page, [header, dock], 48);
  for (const poses of [headerPoses, dockPoses]) {
    assert.ok(poses.has("ponder") && poses.has("flow"), "both double rotation and flow are shown");
  }
  assert.ok(headerPoses.has("unfold"), "the Coding figure has room to unfold");
  assert.ok(!dockPoses.has("unfold"), "the small dock figure keeps its compact gestures");
  // Poking the header during a roll brings the touch gesture forward.
  const mark = page.locator(header);
  for (let i = 0; i < 50 && !["ponder", "flow"].includes(await mark.getAttribute("data-state")); i++) {
    await page.clock.fastForward(500);
  }
  assert.ok(["ponder", "flow"].includes(await mark.getAttribute("data-state")));
  await mark.dispatchEvent("pointerdown");
  await page.clock.fastForward(600);
  assert.equal(await mark.getAttribute("data-move"), "poke");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const [greeting, resting] = await sampleMotion(page, [header, dock], 12);
  assert.deepEqual([...greeting], ["hello"]);
  assert.deepEqual([...resting], ["rest"]);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("https://alfred.test/presence.html");
  const presence = ".figure svg";
  await page.locator(presence + "[data-state]").waitFor();
  const [large] = await sampleMotion(page, [presence], 48);
  for (const pose of ["ponder", "flow", "unfold"]) assert.ok(large.has(pose), "desktop figure shows " + pose);
  async function checkStatus(expected) {
    await page.evaluate(() => window.fixtureEvents.dispatchEvent(new Event("open")));
    await page.clock.fastForward(200);
    await page.locator(presence + `[data-state="${expected}"]`).waitFor();
    const [poses] = await sampleMotion(page, [presence], 12);
    assert.deepEqual([...poses], [expected]);
  }
  snapshot.runs = [{ state: "running" }];
  await checkStatus("work");
  snapshot.notices = [{ kind: "run_interrupted", class: "needs_you" }];
  await checkStatus("notice");
});

test("quick capture retries uncertain writes once and reports a refused undo", async (t) => {
  const browser = await chromium.launch({ channel: "chrome" });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const state = await serveBuild(page);
  state.modules.calendar = { events: [], sources: [{ account: "fixture", canWrite: true, calendars: [{ id: "one", writable: true }] }] };
  const writes = [], deletes = [];
  await page.route("**/api/ops/*", (route) => {
    const op = new URL(route.request().url()).pathname.split("/").at(-1);
    const { requestId } = route.request().postDataJSON();
    if (op.endsWith(".delete")) {
      deletes.push(op);
      const refused = op === "calendar.delete" && deletes.filter((name) => name === op).length === 1;
      return route.fulfill({ json: { result: refused ? { error: "no_write" } : { queued: "delete" } } });
    }
    // The home recorded the event but the intermediary dropped the response. A retry must use the same key.
    writes.push([op, requestId]);
    if (op === "calendar.create" && writes.length === 2) return route.fulfill({ status: 503, json: { error: "Response lost" } });
    return route.fulfill({ json: { result: { id: op }, replayed: writes.filter(([, key]) => key === requestId).length > 1 } });
  });
  await page.goto("https://alfred.test/");
  await page.locator(".dock-alfred").click();
  const field = page.locator(".ask-form [role=combobox]");
  await field.fill("Groceries tomorrow, meeting tomorrow at 3pm");
  await field.press("Enter");
  await page.getByRole("alert").filter({ hasText: "Response lost" }).waitFor();
  await field.press("Enter");
  await page.getByText("2 added", { exact: true }).waitFor();
  assert.deepEqual(writes.map(([op]) => op), ["todo.add", "calendar.create", "calendar.create"]);
  assert.equal(writes[1][1], writes[2][1]);
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  await undo.click();
  await page.getByRole("alert").filter({ hasText: "This calendar can’t be changed" }).waitFor();
  assert.equal(await page.getByText("Undone", { exact: true }).count(), 0);
  await undo.click();
  await page.getByText("Undone", { exact: true }).waitFor();
  assert.deepEqual(deletes.sort(), ["calendar.delete", "calendar.delete", "todo.delete"]);
});

test("a file stays with a dated question in the phone ask bar", async (t) => {
  const browser = await chromium.launch({ channel: "chrome" });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await serveBuild(page);
  const uploading = Promise.withResolvers();
  await page.route("**/api/files?*", async (route) => {
    await uploading.promise;
    await route.fulfill({ json: { id: "file-1", name: "notes.txt", kind: "text", size: 5 } });
  });
  const asked = Promise.withResolvers();
  await page.route("**/api/runs", (route) => {
    asked.resolve(route.request().postDataJSON());
    return route.fulfill({ json: { run: { conversationId: "new-conversation" } } });
  });
  const quickWrites = [];
  page.on("request", (request) => { if (request.url().includes("/api/ops/")) quickWrites.push(request.url()); });
  await page.goto("https://alfred.test/");
  await page.locator(".dock-alfred").click();
  const form = page.locator(".ask-form");
  const field = form.getByRole("combobox");
  await field.fill("Review tomorrow");
  await form.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") });
  await page.locator(".attach-chip[data-state=uploading]").waitFor();
  await field.press("Enter");
  assert.equal(await field.getAttribute("aria-expanded"), "false");
  assert.deepEqual(quickWrites, []);
  uploading.resolve();
  await page.locator(".attach-chip[data-state=ready]").waitFor();
  await field.press("Enter");
  const request = await asked.promise;
  assert.equal(request.goal, "Review tomorrow");
  assert.deepEqual(request.attachments, ["file-1"]);
  assert.deepEqual(quickWrites, []);
  await page.locator(".attach-chip").waitFor({ state: "detached" });
});
