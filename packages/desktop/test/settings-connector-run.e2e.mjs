/** Run after npm run build:ui, with Chrome installed: node packages/desktop/test/settings-connector-run.e2e.mjs
 * Settings → Connectors: a server from the MCP Registry that runs on this Mac is not added with one click. Its card
 * says it runs a program here and shows the command, and the yes sends that very command along; a server at an
 * address is added at once. In both languages, at a phone's width, with no text on top of other text.
 * (UI_DIST=<dir> for another build; SHOTS=<dir> to keep screenshots.) */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const dist = process.env.UI_DIST ? pathToFileURL(`${process.env.UI_DIST.replace(/\/$/, "")}/`) : new URL("../../ui/dist/", import.meta.url);
const shots = process.env.SHOTS?.replace(/\/$/, "");
const date = "2026-01-01T10:00:00Z";
const overlaps = (page, selector) => page.evaluate((selector) => {
  const boxes = [...document.querySelectorAll(selector)].map((el) => [el, el.getBoundingClientRect()]).filter(([, box]) => box.width && box.height);
  const hits = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const [ea, a] = boxes[i], [eb, b] = boxes[j];
    if (ea.contains(eb) || eb.contains(ea)) continue;
    if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) hits.push(`${ea.className || ea.tagName} × ${eb.className || eb.tagName}`);
  }
  return hits;
}, selector);

for (const locale of ["en", "zh"]) {
  test(`Connectors: a registry server that runs here asks first, with its command (${locale})`, async (t) => {
    const browser = await chromium.launch({ channel: "chrome" });
    t.after(() => browser.close());
    const page = await browser.newPage({ locale: locale === "zh" ? "zh-CN" : "en-US", serviceWorkers: "block", viewport: { width: 390, height: 900 } });
    page.setDefaultTimeout(6000);
    const state = { protocol: 1, cursor: 0, modules: {}, views: {}, areas: [], receipts: {}, conversations: [], projects: [],
      settings: { locale, firstRunAt: date }, devAccess: "allowed", proposals: [], automations: [], runs: [], notices: [] };
    const results = [
      { id: "com.example/notes-helper", title: "notes-helper", description: "Helps with notes", kind: "stdio", where: "npx -y @example/notes-helper-with-a-long-name@1.0.0", inputs: [], added: false },
      { id: "io.github.someone/stuff", title: "stuff", description: "At an address", kind: "http", where: "stuff.example.com", inputs: [], added: false },
    ];
    const sent = [];
    await page.route("**/*", async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      if (!pathname.startsWith("/api/")) return route.fulfill({ path: fileURLToPath(new URL(pathname.slice(1) || "index.html", dist)) });
      const json = (body) => route.fulfill({ json: body });
      switch (pathname) {
        case "/api/state": return json(state);
        case "/api/events": return route.fulfill({ status: 204 });
        case "/api/device/web-lock": return json({ enabled: false, locked: false, expiresAt: null });
        case "/api/remote": return json({ local: true });
        case "/api/connections/mcp/search": return json({ results });
        case "/api/connections/mcp":
          if (request.method() === "POST") { sent.push(request.postDataJSON()); return json({ name: "x", title: "x", kind: "stdio", state: "connected", tools: 1, auth: "none" }); }
          return json({ servers: [], catalog: [], found: [] });
        default: return json({});
      }
    });

    await page.goto("https://zirma.test/#p=core.settings");
    await page.locator("#set-tab-connectors").click();
    const pane = page.locator("#set-pane-connectors");
    await pane.locator(".skill-search input").fill("notes");
    await pane.locator(".skill-search button[type=submit]").click();
    const row = pane.locator(".mcp-result", { hasText: "notes-helper" });
    await row.waitFor();
    await row.locator(".skill-add").click();
    const card = row.locator(".mcp-fill");
    await card.waitFor();
    assert.equal(sent.length, 0, "nothing added on the first click");
    assert.match(await card.locator(".mcp-runs").innerText(), locale === "zh" ? /在这台 Mac 上运行/ : /runs this program on this Mac/);
    assert.match(await card.locator(".mcp-fill-where").innerText(), /npx -y @example\/notes-helper-with-a-long-name@1\.0\.0/);
    assert.deepEqual(await overlaps(page, ".mcp-fill > *, .mcp-fill .set-actions > *"), []);
    const box = await card.boundingBox();
    assert.ok(box && box.x + box.width <= 390, "the card fits a phone's width");
    if (shots) await page.screenshot({ path: `${shots}/connector-run-${locale}.png` });
    await card.locator("button[type=submit]").click();
    await card.waitFor({ state: "detached" });
    assert.deepEqual(sent[0], { registry: "com.example/notes-helper", values: {}, runs: "npx -y @example/notes-helper-with-a-long-name@1.0.0" });

    await pane.locator(".mcp-result", { hasText: "stuff" }).locator(".skill-add").click();
    await page.waitForTimeout(200);
    assert.deepEqual(sent[1], { registry: "io.github.someone/stuff" }, "an address is added at once");
  });
}
