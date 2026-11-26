#!/usr/bin/env node
/** The development home node follows the trunk (docs/WORKFLOW.md): what is merged into `zirma` is what the test
 * version runs, minutes later, with nobody remembering to pull and restart.
 *
 *   npm run dev:follow                 one look now: update and restart if `origin/zirma` moved
 *   npm run dev:follow -- --install    look every two minutes from now on (a launchd agent of its own)
 *   npm run dev:follow -- --uninstall  stop looking
 *   npm run dev:follow -- --status     what it last did
 *
 * One look: fetch `origin/zirma`; if this checkout is on `zirma`, has no changes of anyone's to tracked files and
 * can fast-forward, it does; installs packages if a package file changed; builds the interface; restarts the
 * development node (`zirma.home-node.dev`) and waits for it to answer. If it does not come back, the checkout goes
 * back to the commit it ran before, that is built and started again, and the commit that failed is not tried again
 * until a newer one comes. It never touches production (the installed app, port 7480, its world or its agent).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface FollowState {
  /** The last commit the node ran after a look. */
  running?: string;
  /** A commit that did not start: not tried again until `origin/zirma` moves past it. */
  failed?: string;
  at?: string;
  last?: FollowResult;
}

export type FollowResult =
  | { state: "current"; at: string }
  | { state: "updated"; from: string; to: string }
  /** It moved, did not start, and was put back. */
  | { state: "held"; at: string; failed: string; why: string }
  /** Nothing was changed, on purpose: someone's changes in the checkout, local commits, another branch, a fetch
   * that failed, or the commit that failed last time. */
  | { state: "skipped"; why: string };

export interface FollowDeps {
  repo: string;
  /** git in the checkout; never throws. */
  git(args: string[]): { ok: boolean; out: string };
  /** npm in the checkout; never throws. */
  npm(args: string[]): { ok: boolean; out: string };
  restart(): void;
  /** Whether the node answers, within a minute of a restart. */
  healthy(): Promise<boolean>;
  load(): FollowState;
  save(state: FollowState): void;
  log(line: string): void;
}

const BRANCH = "zirma";
const short = (sha: string) => sha.slice(0, 8);

/** One look. */
export async function followOnce(d: FollowDeps): Promise<FollowResult> {
  const git = (...args: string[]) => d.git(args);
  const state = d.load();
  const done = (result: FollowResult, extra: Partial<FollowState> = {}): FollowResult => {
    d.save({ ...state, ...extra, at: new Date().toISOString(), last: result });
    if (result.state !== "current") d.log(JSON.stringify(result));
    return result;
  };

  if (!git("fetch", "--quiet", "origin", BRANCH).ok) return done({ state: "skipped", why: "could not fetch origin/zirma" });
  const branch = git("branch", "--show-current").out.trim();
  if (branch !== BRANCH) return done({ state: "skipped", why: `the checkout is on ${branch || "no branch"}, not ${BRANCH}` });
  const head = git("rev-parse", "HEAD").out.trim();
  const target = git("rev-parse", `origin/${BRANCH}`).out.trim();
  if (!head || !target) return done({ state: "skipped", why: "could not read the commits" });
  if (head === target) return done({ state: "current", at: head }, { running: head });
  if (!git("merge-base", "--is-ancestor", "HEAD", `origin/${BRANCH}`).ok) return done({ state: "skipped", why: "the checkout has commits that are not on origin/zirma" });
  // Changes to tracked files are someone's work (AGENTS.md: never revert, stash or tidy them): left alone.
  if (git("status", "--porcelain", "--untracked-files=no").out.trim()) return done({ state: "skipped", why: "the checkout has uncommitted changes" });
  if (state.failed === target) return done({ state: "skipped", why: `${short(target)} did not start last time; waiting for a newer commit` });

  const changed = git("diff", "--name-only", head, target).out.split("\n").filter(Boolean);
  const packages = changed.some((path) => path === "package-lock.json" || /(^|\/)package\.json$/.test(path));
  if (!git("merge", "--ff-only", "--quiet", target).ok) return done({ state: "skipped", why: "could not fast-forward (a file in the way?)" });

  const prepare = (): string | null => {
    // `npm install`, not `npm ci`: ci removes node_modules, and the node runs on Electron from there.
    if (packages && !d.npm(["install", "--no-audit", "--no-fund"]).ok) return "npm install failed";
    if (!d.npm(["run", "build:ui"]).ok) return "building the interface failed";
    return null;
  };
  const why = prepare() ?? (d.restart(), (await d.healthy()) ? null : "the node did not answer after the restart");
  if (!why) return done({ state: "updated", from: head, to: target }, { running: target, failed: undefined });

  // Back to the commit that ran, built and started as it was.
  git("reset", "--keep", head);
  if (packages) d.npm(["install", "--no-audit", "--no-fund"]);
  d.npm(["run", "build:ui"]);
  d.restart();
  await d.healthy();
  return done({ state: "held", at: head, failed: target, why }, { running: head, failed: target });
}

/* ── On this Mac ── */

const LABEL = "zirma.follow-zirma.dev";
const NODE_LABEL = "zirma.home-node.dev";
const PORT = 7491;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const logDir = join(homedir(), "Library", "Logs", "Zirma");
const logFile = join(logDir, "follow-zirma.log");
const stateFile = join(logDir, "follow-zirma.json");
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const domain = () => `gui/${process.getuid!()}`;

function run(command: string, args: string[], cwd: string, timeout = 10 * 60_000): { ok: boolean; out: string } {
  const done = spawnSync(command, args, { cwd, encoding: "utf8", timeout, env: { ...process.env, ZIRMA_ENV: "development" } });
  return { ok: done.status === 0, out: `${done.stdout ?? ""}${done.stderr ?? ""}` };
}

function launchctl(...args: string[]): { ok: boolean; out: string } {
  return run("/bin/launchctl", args, repoRoot, 30_000);
}

function macDeps(): FollowDeps {
  return {
    repo: repoRoot,
    git: (args) => run("git", args, repoRoot, 120_000),
    npm: (args) => run("npm", args, repoRoot),
    restart: () => { launchctl("kickstart", "-k", `${domain()}/${NODE_LABEL}`); },
    healthy: async () => {
      for (let waited = 0; waited < 60_000; waited += 2000) {
        await new Promise((done) => setTimeout(done, 2000));
        try {
          const response = await fetch(`http://127.0.0.1:${PORT}/api/state`, { signal: AbortSignal.timeout(3000) });
          if (response.ok) return true;
        } catch { /* not up yet */ }
      }
      return false;
    },
    load: () => { try { return JSON.parse(readFileSync(stateFile, "utf8")) as FollowState; } catch { return {}; } },
    save: (state) => { mkdirSync(logDir, { recursive: true }); writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`); },
    log: (line) => { mkdirSync(logDir, { recursive: true }); writeFileSync(logFile, `${new Date().toISOString()} ${line}\n`, { flag: "a" }); },
  };
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function install(): void {
  const node = process.execPath;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(join(repoRoot, "scripts", "follow-zirma.ts"))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(`${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin`)}</string>
    <key>ZIRMA_ENV</key><string>development</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>120</integer>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`;
  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  if (launchctl("print", `${domain()}/${LABEL}`).ok) launchctl("bootout", `${domain()}/${LABEL}`);
  writeFileSync(plistPath, plist);
  const loaded = launchctl("bootstrap", domain(), plistPath);
  if (!loaded.ok) throw new Error(`launchctl could not load ${LABEL}: ${loaded.out.trim()}`);
  console.log(`The development node now follows origin/${BRANCH}: a look every two minutes (${logFile}).`);
}

function uninstall(): void {
  if (launchctl("print", `${domain()}/${LABEL}`).ok) launchctl("bootout", `${domain()}/${LABEL}`);
  rmSync(plistPath, { force: true });
  console.log("The development node no longer follows origin/zirma by itself.");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.env.ZIRMA_ENV === "production") { console.error("Production does not follow a branch: it installs from a version tag."); process.exit(1); }
  if (process.platform !== "darwin") { console.error("This keeps the development node on a Mac up to date."); process.exit(1); }
  const flag = process.argv[2];
  if (flag === "--install") install();
  else if (flag === "--uninstall") uninstall();
  else if (flag === "--status") console.log(existsSync(stateFile) ? readFileSync(stateFile, "utf8") : "No look yet.");
  else {
    const result = await followOnce(macDeps());
    console.log(JSON.stringify(result));
  }
  // So that a single look never keeps a timer alive.
  process.exit(0);
}

