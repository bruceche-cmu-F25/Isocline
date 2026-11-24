/** Drives the real Mac app against an isolated development world and checks
 * step 2's acceptance. It opens real windows on this Mac, installs a launchd
 * agent for that world (removed at the end), and makes real model calls
 * through the user's Pi setup.
 *
 *   node packages/desktop/test/desktop.e2e.ts [--keep]
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import type { StateResponse, SubmitRunResponse } from "@zirma/protocol";

const PORT = 7481;
const dataDir = mkdtempSync(join(process.env.ZIRMA_E2E_TMP ?? tmpdir(), "alfred-desktop-e2e-"));
const label = `alfred.home-node.${createHash("sha256").update(dataDir).digest("hex").slice(0, 8)}`;
const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const base = `http://127.0.0.1:${PORT}`;
const appDir = fileURLToPath(new URL("..", import.meta.url));
const electronPath = (await import("electron")).default as unknown as string;
const shots = process.env.ZIRMA_E2E_SHOTS ?? dataDir;

const step = (text: string) => console.log(`\n▸ ${text}`);
const ok = (text: string) => console.log(`  ✓ ${text}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function state(): Promise<StateResponse> {
  return await (await fetch(`${base}/api/state`)).json() as StateResponse;
}
async function waitFor<T>(what: string, check: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > until) throw new Error(`Timed out waiting for: ${what}`);
    await sleep(300);
  }
}
function world<T>(read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(dataDir, "world.sqlite"), { readOnly: true });
  try { return read(db); } finally { db.close(); }
}
const launchdLoaded = () => {
  try { execFileSync("/bin/launchctl", ["print", `gui/${process.getuid!()}/${label}`], { stdio: "ignore" }); return true; } catch { return false; }
};

async function launch(): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronPath,
    args: [appDir],
    env: { ...process.env, ZIRMA_DATA_DIR: dataDir, ZIRMA_PORT: String(PORT), ZIRMA_AWAY_MINUTES: "0.05" } as Record<string, string>,
    timeout: 60_000,
  });
}
async function windows(app: ElectronApplication): Promise<{ main: Page; figure: Page }> {
  return waitFor("both windows", async () => {
    const pages = app.windows();
    const figure = pages.find((page) => page.url().endsWith("/presence.html"));
    const main = pages.find((page) => page.url() === `${base}/`);
    return figure && main ? { main, figure } : null;
  });
}

let app: ElectronApplication | null = null;
try {
  step("First open: the app installs the home node under launchd and starts it");
  app = await launch();
  const { main, figure } = await windows(app);
  assert.ok(launchdLoaded(), "launchd agent loaded");
  assert.ok(existsSync(plist), "plist written");
  ok(`launchd agent ${label} is loaded and answers on :${PORT}`);
  // A new world opens on the first-run walkthrough (ui shell/FirstRun.tsx); this run is about what is behind it.
  await fetch(`${base}/api/settings`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: crypto.randomUUID(), patch: { firstRunAt: new Date().toISOString() } }) });
  // Zirma's panel may have been left closed: open it from the floating button.
  await main.waitForSelector(".composer textarea, .fab");
  if (await main.$(".fab")) await main.click(".fab");
  await main.waitForSelector(".composer textarea");
  await figure.waitForSelector(".figure svg line");
  await main.screenshot({ path: join(shots, "main.png") });
  await figure.screenshot({ path: join(shots, "figure.png") });
  ok("main window and the figure window are up");

  step("The figure window is always on top and lets clicks through");
  const figureFlags = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith("/presence.html"))!;
    return { onTop: window.isAlwaysOnTop(), focusable: window.isFocusable(), visible: window.isVisible() };
  });
  assert.deepEqual(figureFlags, { onTop: true, focusable: false, visible: true });
  ok("always on top, never takes focus, visible");

  step("Locking the screen and coming back greets once, in the figure");
  await sleep(500);
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
  await sleep(3500); // longer than ZIRMA_AWAY_MINUTES (3 s)
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
  const card = await figure.waitForSelector(".speech .speech-foot.shown", { timeout: 10_000 }).then(() => figure.$(".speech"));
  ok(`the figure says: ${(await card!.innerText()).replace(/\s+/g, " ")}`);
  await figure.screenshot({ path: join(shots, "figure-welcome.png") });
  // A second unlock, a heartbeat: nobody is greeted again.
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
  await sleep(1500);
  const welcomes = world((db) => db.prepare("SELECT state, claimed_by FROM core_notices WHERE kind = 'welcome'").all());
  assert.equal(welcomes.length, 1, "exactly one welcome");
  assert.equal(welcomes[0].state, "presented");
  assert.match(String(welcomes[0].claimed_by), /^mac-/);
  ok("one welcome, presented by this Mac");

  step("A result while the main window is not in front is said by the figure on this Mac");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith(":7481/"))?.hide());
  const first = await (await fetch(`${base}/api/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "e2e-notify", goal: "加一个待办：给自行车打气，做完告诉我。" }) })).json() as SubmitRunResponse;
  const notified = await waitFor("the result notice presented", async () => {
    const notice = (await state()).notices.find((candidate) => candidate.payload.runId === first.run.id);
    return notice && notice.state === "presented" ? notice : null;
  }, 120_000);
  assert.match(String(notified.claimedBy), /^mac-[0-9a-f]+$/, "claimed by the Mac app itself, not a window");
  ok(`run finished and the Mac app presented its notice (${notified.claimedBy})`);
  await figure.waitForSelector(".speech", { timeout: 10_000 });
  await figure.screenshot({ path: join(shots, "figure-result.png") });
  ok("the figure came out with the result");

  step("Quitting the app does not stop a run in progress");
  const second = await (await fetch(`${base}/api/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "e2e-quit", goal: "加一个待办：周六去取快递" }) })).json() as SubmitRunResponse;
  await waitFor("the run to start", async () => (await state()).runs.find((run) => run.id === second.run.id)?.state === "running");
  await app.close();
  app = null;
  ok("app quit while the run was running");
  const finished = await waitFor("the run to finish without the app", async () => {
    const run = (await state()).runs.find((candidate) => candidate.id === second.run.id);
    return run && ["completed", "failed"].includes(run.state) ? run : null;
  }, 120_000);
  assert.equal(finished.state, "completed");
  ok(`run completed with the app closed: ${finished.outcome?.reply ?? ""}`);
  const todos = (await state()).modules.todo as { todos: Array<{ title: string }> };
  ok(`todos now: ${todos.todos.map((todo) => todo.title).join(" / ")}`);

  step("Opening the app again finds the running node instead of starting another");
  app = await launch();
  await windows(app);
  const agents = execFileSync("/bin/sh", ["-c", `pgrep -f "cli.ts serve --port ${PORT}" | wc -l`], { encoding: "utf8" }).trim();
  assert.equal(agents, "1", "one home node process");
  ok("one home node, reused");
  await app.close();
  app = null;
  console.log(`\nAll step 2 checks passed. Screenshots: ${shots}`);
} finally {
  await app?.close().catch(() => {});
  if (!process.argv.includes("--keep")) {
    try { execFileSync("/bin/launchctl", ["bootout", `gui/${process.getuid!()}/${label}`], { stdio: "ignore" }); } catch { /* not loaded */ }
    rmSync(plist, { force: true });
    console.log(`Removed the test launchd agent ${label}.`);
  }
}
