/** Production on this Mac in one command: builds Zirma.app from the last commit (never the working tree), checks
 * it, and puts it in /Applications in place of the one there.
 *
 *   npm run install:mac            the current branch's last commit
 *   npm run install:mac -- <ref>   another commit, branch or tag
 *
 * 1. The commit is checked out into a fresh folder of its own (git worktree), with its own `npm ci`: nothing
 *    uncommitted, and no package from this checkout, gets in.
 * 2. Its typecheck and tests must pass there.
 * 3. package-mac.ts builds the app there (it stamps the commit).
 * 4. Production's world is backed up to <data>/backups/ (the last ten are kept), so going back to an older tag can
 *    take the data back too: an older build may not read what a newer one migrated (docs/WORKFLOW.md §5).
 * 5. The Zirma.app in /Applications is quit and replaced, and the new one is opened. Its home node agent now names
 *    another build, so the app reloads it and the node runs the new code on the same world (docs/packaging.md §4.1).
 *    An app from before the rename (Isocline.app) is quit too and moved to the Trash; the new app retires its home
 *    node and moves its world to the new folder when it opens (docs/design/rename-zirma.md §3.2).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dataDirNamed, stageDataDir } from "../packages/core/src/stage.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const target = "/Applications/Zirma.app";
/** The app under its name before the rename: quit and moved to the Trash when Zirma.app goes in. */
const OLD_TARGET = "/Applications/Isocline.app";
/** An app's own process, not its home node (which runs the same executable with arguments). */
const appProcess = (app: string) => `^${app}/Contents/MacOS/${app.replace(/^.*\/(.+)\.app$/, "$1")}$`;
const ref = process.argv[2] ?? "HEAD";
/** How many of the installer's world backups are kept. */
const KEEP_BACKUPS = 10;
const step = (text: string) => console.log(`▸ ${text}`);
const run = (command: string, args: string[], cwd = root) => execFileSync(command, args, { cwd, stdio: "inherit" });
const read = (command: string, args: string[], cwd = root) => execFileSync(command, args, { cwd, encoding: "utf8" }).trim();

if (process.platform !== "darwin") throw new Error("Zirma.app is installed on a Mac.");
const commit = read("git", ["rev-parse", "--short", `${ref}^{commit}`]);
const build = mkdtempSync(join(tmpdir(), "zirma-build-"));

try {
  step(`Checking out ${commit} (${read("git", ["log", "-1", "--format=%s", commit])})`);
  run("git", ["worktree", "add", "--detach", build, commit]);

  step("Installing its dependencies");
  run("npm", ["ci", "--prefer-offline", "--no-audit", "--no-fund"], build);
  // Electron fetches its own binary on first use, not at install (from its cache when it has it); the app is built from it.
  run("node", [join("node_modules", "electron", "install.js")], build);

  step("Checking it: typecheck and tests");
  run("npm", ["run", "typecheck"], build);
  run("npm", ["test"], build);

  step("Building Zirma.app");
  run("npm", ["run", "package:mac", "--", "--no-dmg"], build);
  const built = join(build, "dist", "mac", "Zirma.app");

  const current = [target, OLD_TARGET].find((app) => existsSync(app));
  const installed = current ? JSON.parse(readFileSync(join(current, "Contents", "Resources", "app", "package.json"), "utf8")).commit as string | undefined : undefined;
  const saved = await backupWorld(installed ?? "none");
  if (saved) step(`Backed up the world (as ${installed ?? "no build"} left it) to ${saved}`);

  if (existsSync(target)) {
    quit(target);
    rmSync(target, { recursive: true, force: true });
  }
  if (existsSync(OLD_TARGET)) {
    quit(OLD_TARGET);
    const trash = join(homedir(), ".Trash", `Isocline ${new Date().toISOString().replace(/[:.]/g, "-")}.app`);
    step(`Moving ${OLD_TARGET} to the Trash`);
    renameSync(OLD_TARGET, trash);
  }
  step(`Installing ${target}`);
  run("/usr/bin/ditto", [built, target]);
  run("/usr/bin/open", [target]);
  const stamped = JSON.parse(readFileSync(join(target, "Contents", "Resources", "app", "package.json"), "utf8")).commit;
  console.log(`\nZirma ${stamped} is installed. Its home node log: ~/Library/Logs/Zirma/zirma.home-node.log`);
} finally {
  try { run("git", ["worktree", "remove", "--force", build]); } catch { rmSync(build, { recursive: true, force: true }); }
}

/** Quits an installed app and waits for it: politely, then by signal, since a dialog left open keeps it from
 * quitting. Only the app's own process is ended: the home node is launchd's. */
function quit(app: string): void {
  const name = app.replace(/^.*\/(.+)\.app$/, "$1");
  step(`Quitting the installed ${name}`);
  const id = read("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(app, "Contents", "Info.plist")]);
  try { read("/usr/bin/osascript", ["-e", `tell application id "${id}" to quit`]); } catch { /* not running */ }
  for (let waited = 0; waited < 15_000 && running(app); waited += 500) execFileSync("/bin/sleep", ["0.5"]);
  for (const signal of ["TERM", "KILL"]) {
    if (!running(app)) break;
    try { execFileSync("/usr/bin/pkill", [`-${signal}`, "-f", appProcess(app)]); } catch { /* gone already */ }
    for (let waited = 0; waited < 5_000 && running(app); waited += 500) execFileSync("/bin/sleep", ["0.5"]);
  }
  if (running(app)) throw new Error(`${name} did not quit. Quit it from the menu bar and run this again.`);
}

/** Whether an installed app's own process is still running (its home node is launchd's, not the app's). */
function running(app: string): boolean {
  try { return read("/usr/bin/pgrep", ["-f", appProcess(app)]) !== ""; } catch { return false; }
}

/** A copy of production's world, made with SQLite's own backup so the running node may keep writing. Named by time
 * and by the build that wrote it; only the last KEEP_BACKUPS of these are kept. Null when there is no world yet. */
async function backupWorld(build: string): Promise<string | null> {
  // Before the first Zirma install the world is still in its folder from before the rename; the backup goes there and
  // moves with it.
  const data = [stageDataDir("production"), dataDirNamed("Isocline"), dataDirNamed("Alfred")].find((folder) => existsSync(join(folder, "world.sqlite")));
  if (!data) return null;
  const world = join(data, "world.sqlite");
  const folder = join(data, "backups");
  mkdirSync(folder, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\..*$/, "");
  const path = join(folder, `world-${stamp}-${build}.sqlite`);
  const source = new DatabaseSync(world, { readOnly: true });
  try { await backup(source, path); } finally { source.close(); }
  const ours = readdirSync(folder).filter((name) => /^world-\d{8}-\d{6}-[\w.-]+\.sqlite$/.test(name)).sort();
  for (const name of ours.slice(0, -KEEP_BACKUPS)) rmSync(join(folder, name));
  return path;
}
