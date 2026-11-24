/** Gives the development world a copy of production's, to try changes on real-looking data (core stage.ts):
 *
 *   npm run dev:copy-world
 *
 * Production is only read, and may keep running: the world is copied with SQLite's own backup, so the copy is
 * consistent. What would let development act for real is left out or switched off:
 *   - not copied: the paired phones' push subscriptions (push.json), remote access (remote.json), the connected
 *     Google accounts (connections.json; their tokens are in production's keychain anyway), the app's window files,
 *     project worktrees and old backups;
 *   - changes still waiting to go out (sending mail, calendar writes) are marked failed in the copy, never sent.
 * The development world that was there is kept beside it as "<dir>.previous" (the one before that is dropped).
 */
import { existsSync, readFileSync, renameSync, rmSync, cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { stageDataDir } from "../packages/core/src/stage.ts";

const from = stageDataDir("production");
const to = stageDataDir("development");
const COPIED = ["engine", "files", "skills", "mcp.json", "google-oauth-client.json"];

if (!existsSync(join(from, "world.sqlite"))) throw new Error(`No production world in ${from}.`);
if (alive(join(to, "home-node.lock"))) {
  console.error("The development home node is running. Quit Zirma Dev (or stop its node) first.");
  process.exit(1);
}

if (existsSync(to)) {
  rmSync(`${to}.previous`, { recursive: true, force: true });
  renameSync(to, `${to}.previous`);
  console.log(`▸ The development world that was there is now ${to}.previous`);
}
mkdirSync(to, { recursive: true });

console.log(`▸ Copying the world from ${from}`);
const source = new DatabaseSync(join(from, "world.sqlite"), { readOnly: true });
await backup(source, join(to, "world.sqlite"));
source.close();
for (const name of COPIED) if (existsSync(join(from, name))) cpSync(join(from, name), join(to, name), { recursive: true });

const world = new DatabaseSync(join(to, "world.sqlite"));
const held = world.prepare(`UPDATE core_outbound SET state = 'failed', error = 'Copied into the development world; never sent from there.', updated_at = ? WHERE state IN ('queued', 'sending')`)
  .run(new Date().toISOString()).changes;
world.close();
console.log(`▸ Done: ${to}${held ? ` (${held} waiting change${held === 1 ? "" : "s"} marked failed, not sent)` : ""}`);
console.log("  Open it with npm run desktop. Models and Google are signed in separately in development.");

/** Whether the lock names a process that is still running. */
function alive(lock: string): boolean {
  if (!existsSync(lock)) return false;
  const pid = Number(readFileSync(lock, "utf8").trim());
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
