/** Production on this Mac in one command: builds Isocline.app from the last commit (never the working tree), checks
 * it, and puts it in /Applications in place of the one there.
 *
 *   npm run install:mac            the current branch's last commit
 *   npm run install:mac -- <ref>   another commit, branch or tag
 *
 * 1. The commit is checked out into a fresh folder of its own (git worktree), with its own `npm ci`: nothing
 *    uncommitted, and no package from this checkout, gets in.
 * 2. Its typecheck and tests must pass there.
 * 3. package-mac.ts builds the app there (it stamps the commit).
 * 4. The Isocline.app in /Applications is quit and replaced, and the new one is opened. Its home node agent now names
 *    another build, so the app reloads it and the node runs the new code on the same world (docs/packaging.md §4.1).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const target = "/Applications/Isocline.app";
/** The app's own process, not the home node (which runs the same executable with arguments). */
const APP_PROCESS = `^${target}/Contents/MacOS/Isocline$`;
const ref = process.argv[2] ?? "HEAD";
const step = (text: string) => console.log(`▸ ${text}`);
const run = (command: string, args: string[], cwd = root) => execFileSync(command, args, { cwd, stdio: "inherit" });
const read = (command: string, args: string[], cwd = root) => execFileSync(command, args, { cwd, encoding: "utf8" }).trim();

if (process.platform !== "darwin") throw new Error("Isocline.app is installed on a Mac.");
const commit = read("git", ["rev-parse", "--short", `${ref}^{commit}`]);
const build = mkdtempSync(join(tmpdir(), "isocline-build-"));

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

  step("Building Isocline.app");
  run("npm", ["run", "package:mac", "--", "--no-dmg"], build);
  const built = join(build, "dist", "mac", "Isocline.app");

  if (existsSync(target)) {
    step("Quitting the installed Isocline");
    const id = read("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(target, "Contents", "Info.plist")]);
    try { read("/usr/bin/osascript", ["-e", `tell application id "${id}" to quit`]); } catch { /* not running */ }
    for (let waited = 0; waited < 15_000 && running(); waited += 500) execFileSync("/bin/sleep", ["0.5"]);
    // A dialog left open keeps it from quitting. Only the app's own process is ended: the home node is launchd's.
    for (const signal of ["TERM", "KILL"]) {
      if (!running()) break;
      try { execFileSync("/usr/bin/pkill", [`-${signal}`, "-f", APP_PROCESS]); } catch { /* gone already */ }
      for (let waited = 0; waited < 5_000 && running(); waited += 500) execFileSync("/bin/sleep", ["0.5"]);
    }
    if (running()) throw new Error("Isocline did not quit. Quit it from the menu bar and run this again.");
    rmSync(target, { recursive: true, force: true });
  }
  step(`Installing ${target}`);
  run("/usr/bin/ditto", [built, target]);
  run("/usr/bin/open", [target]);
  const stamped = JSON.parse(readFileSync(join(target, "Contents", "Resources", "app", "package.json"), "utf8")).commit;
  console.log(`\nIsocline ${stamped} is installed. Its home node log: ~/Library/Logs/Isocline/isocline.home-node.log`);
} finally {
  try { run("git", ["worktree", "remove", "--force", build]); } catch { rmSync(build, { recursive: true, force: true }); }
}

/** Whether the installed app's own process is still running (its home node is launchd's, not the app's). */
function running(): boolean {
  try { return read("/usr/bin/pgrep", ["-f", APP_PROCESS]) !== ""; } catch { return false; }
}
