/** The development node follows the trunk (scripts/follow-zirma.ts): a real git repository and its origin in a
 * temporary folder; installing, building, restarting and the node's health are stand-ins. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { followOnce, type FollowDeps, type FollowState } from "../../../scripts/follow-zirma.ts";

function repos() {
  const base = mkdtempSync(join(tmpdir(), "zirma-follow-"));
  const origin = join(base, "origin.git"), checkout = join(base, "checkout"), other = join(base, "other");
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["init", "--bare", "-q", "-b", "zirma", origin]);
  execFileSync("git", ["clone", "-q", origin, other], { stdio: "ignore" });
  for (const repo of [other]) { sh(repo, "config", "user.email", "t@example.com"); sh(repo, "config", "user.name", "T"); }
  const commit = (file: string, text: string) => { writeFileSync(join(other, file), text); sh(other, "add", "-A"); sh(other, "commit", "-q", "-m", file); sh(other, "push", "-q", "origin", "HEAD:zirma"); return sh(other, "rev-parse", "HEAD").trim(); };
  const first = commit("a.txt", "one\n");
  execFileSync("git", ["clone", "-q", "-b", "zirma", origin, checkout], { stdio: "ignore" });
  sh(checkout, "config", "user.email", "t@example.com"); sh(checkout, "config", "user.name", "T");
  return { checkout, commit, first, head: () => sh(checkout, "rev-parse", "HEAD").trim(), sh };
}

function deps(repo: string, behave: { healthy?: (n: number) => boolean; npmFails?: string } = {}) {
  let state: FollowState = {};
  const calls: string[] = [];
  let restarts = 0;
  const d: FollowDeps = {
    repo,
    git: (args) => { const done = spawnSync("git", args, { cwd: repo, encoding: "utf8" }); return { ok: done.status === 0, out: `${done.stdout}${done.stderr}` }; },
    npm: (args) => { calls.push(`npm ${args.join(" ")}`); return { ok: behave.npmFails ? !args.join(" ").includes(behave.npmFails) : true, out: "" }; },
    restart: () => { restarts++; calls.push("restart"); },
    healthy: async () => behave.healthy?.(restarts) ?? true,
    load: () => state,
    save: (next) => { state = next; },
    log: () => {},
  };
  return { d, calls, state: () => state };
}

test("nothing new: nothing is done", async () => {
  const { checkout, first } = repos();
  const { d, calls } = deps(checkout);
  assert.deepEqual(await followOnce(d), { state: "current", at: first });
  assert.deepEqual(calls, []);
});

test("a new commit on zirma: fast-forwarded, the interface built, the node restarted", async () => {
  const { checkout, commit, first, head } = repos();
  const next = commit("b.txt", "two\n");
  const { d, calls, state } = deps(checkout);
  assert.deepEqual(await followOnce(d), { state: "updated", from: first, to: next });
  assert.equal(head(), next);
  assert.deepEqual(calls, ["npm run build:ui", "restart"], "no install when no package file changed");
  assert.equal(state().running, next);
});

test("a package file changed: packages are installed first (npm install, never npm ci)", async () => {
  const { checkout, commit } = repos();
  commit("package-lock.json", "{}\n");
  const { d, calls } = deps(checkout);
  assert.equal((await followOnce(d)).state, "updated");
  assert.deepEqual(calls, ["npm install --no-audit --no-fund", "npm run build:ui", "restart"]);
});

test("the new commit does not start: back to the one that ran, and not tried again until a newer one", async () => {
  const { checkout, commit, first, head } = repos();
  const bad = commit("b.txt", "broken\n");
  const { d, calls, state } = deps(checkout, { healthy: (restarts) => restarts !== 1 });
  assert.deepEqual(await followOnce(d), { state: "held", at: first, failed: bad, why: "the node did not answer after the restart" });
  assert.equal(head(), first, "the checkout is back where it ran");
  assert.deepEqual(calls, ["npm run build:ui", "restart", "npm run build:ui", "restart"]);
  assert.equal(state().failed, bad);
  assert.equal((await followOnce(d)).state, "skipped", "the same broken commit is not tried again");
  const fixed = commit("c.txt", "fixed\n");
  assert.deepEqual(await followOnce(d), { state: "updated", from: first, to: fixed });
});

test("the interface does not build: nothing is restarted onto it", async () => {
  const { checkout, commit, first, head } = repos();
  commit("b.txt", "two\n");
  const { d } = deps(checkout, { npmFails: "build:ui" });
  const result = await followOnce(d);
  assert.equal(result.state, "held");
  assert.equal(head(), first);
});

test("someone's uncommitted changes, local commits, or another branch: left alone", async () => {
  const { checkout, commit, head, sh } = repos();
  commit("b.txt", "two\n");
  writeFileSync(join(checkout, "a.txt"), "someone is editing\n");
  const before = head();
  const { d, calls } = deps(checkout);
  assert.deepEqual(await followOnce(d), { state: "skipped", why: "the checkout has uncommitted changes" });
  assert.equal(head(), before);
  assert.equal(readFileSync(join(checkout, "a.txt"), "utf8"), "someone is editing\n");
  sh(checkout, "checkout", "-q", "--", "a.txt");
  // An untracked file is not a reason to wait (other tools leave files around).
  writeFileSync(join(checkout, "notes.tmp"), "x\n");
  sh(checkout, "commit", "-q", "--allow-empty", "-m", "local");
  assert.deepEqual(await followOnce(d), { state: "skipped", why: "the checkout has commits that are not on origin/zirma" });
  sh(checkout, "reset", "-q", "--hard", "HEAD~1");
  sh(checkout, "checkout", "-q", "-b", "feat/x");
  assert.deepEqual(await followOnce(d), { state: "skipped", why: "the checkout is on feat/x, not zirma" });
  assert.deepEqual(calls, []);
});
