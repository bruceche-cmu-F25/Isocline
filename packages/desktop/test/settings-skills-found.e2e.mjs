/** Run after npm run build:ui, with Chrome installed: node packages/desktop/test/settings-skills-found.e2e.mjs
 * Settings → Skills: after a search, the skills found on this Mac stay in sight (a line says when none match the box),
 * and adding a skill from skills.sh empties the box so the Mac's group is whole again. Screenshots go to SHOTS when set. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const dist = process.env.UI_DIST ? pathToFileURL(`${process.env.UI_DIST.replace(/\/$/, "")}/`) : new URL("../../ui/dist/", import.meta.url);
const shots = process.env.SHOTS?.replace(/\/$/, "");
const date = "2026-01-01T10:00:00Z";

for (const locale of ["en", "zh"]) {
  test(`Skills keeps the Mac's skills in sight around a skills.sh search (${locale})`, async (t) => {
    const browser = await chromium.launch({ channel: "chrome" });
    t.after(() => browser.close());
    const page = await browser.newPage({ locale: locale === "zh" ? "zh-CN" : "en-US", serviceWorkers: "block", viewport: { width: 420, height: 900 } });
    page.setDefaultTimeout(6000);
    const state = { protocol: 1, cursor: 0, modules: {}, views: {}, areas: [], receipts: {}, conversations: [], projects: [],
      settings: { locale, firstRunAt: date }, devAccess: "allowed", proposals: [], automations: [], runs: [], notices: [] };
    const found = ["grill-me", "tdd", "diagnose"].map((name) => ({ name, description: `The ${name} sample`, place: "~/.claude/skills", path: `/sample/skills/${name}` }));
    const catalog = { skills: [], found, problems: [] };
    const result = { package: "sample/agent-skills/sample-search", name: "sample-search", source: "sample/agent-skills", installs: 5800, url: "https://skills.sh/sample/agent-skills/sample-search", added: false };
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
        case "/api/skills": return json(catalog);
        case "/api/skills/search": return json({ results: [result] });
        case "/api/skills/add": {
          const info = { id: result.name, name: result.name, description: "A sample skill", enabled: true, source: { package: result.package, url: result.url } };
          catalog.skills.push(info);
          return json(info);
        }
        default: return json({});
      }
    });

    await page.goto("https://zirma.test/#p=core.settings");
    await page.locator("#set-tab-skills").click();
    const pane = page.locator("#set-pane-skills");
    const box = pane.locator(".skill-search input");
    const mac = pane.locator(".skill-found .skill-item");
    await mac.first().waitFor();
    assert.equal(await mac.count(), 3);

    await box.fill(result.name);
    await pane.locator(".skill-search button[type=submit]").click();
    await pane.locator(".skill-results .skill-item").waitFor();
    // Nothing on this Mac matches the words searched for: the group stays, says so, and offers all of them back.
    const none = pane.locator(".skill-none").filter({ hasText: locale === "zh" ? "没有匹配的" : "None match" });
    await none.waitFor();
    assert.equal(await mac.count(), 0);
    if (shots) await page.screenshot({ path: `${shots}/skills-none-${locale}.png`, fullPage: true });
    await pane.locator(".skill-more").click();
    assert.equal(await box.inputValue(), "");
    assert.equal(await mac.count(), 3);

    // Adding from skills.sh empties the box: the Mac's group is whole, the results stay.
    await box.fill(result.name);
    await pane.locator(".skill-results .skill-add").click();
    await pane.locator(".skill-results .skill-done").waitFor();
    assert.equal(await box.inputValue(), "");
    assert.equal(await mac.count(), 3);
    assert.equal(await pane.locator(".skill-results .skill-item").count(), 1);
    if (shots) await page.screenshot({ path: `${shots}/skills-added-${locale}.png`, fullPage: true });

    // No text overlaps another in the pane at this width.
    const overlaps = await pane.evaluate((root) => {
      const boxes = [...root.querySelectorAll("b, span, p, h3, h4, button, a")].filter((el) => el.children.length === 0 && el.textContent.trim())
        .map((el) => ({ text: el.textContent.trim(), r: el.getBoundingClientRect() })).filter(({ r }) => r.width && r.height);
      const out = [];
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r, b = boxes[j].r;
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(`${boxes[i].text} / ${boxes[j].text}`);
      }
      return out;
    });
    assert.deepEqual(overlaps, []);
  });
}
