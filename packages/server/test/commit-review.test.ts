import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reviewCommit } from "../src/commit-review.ts";
import { createWorktree, snapshot, workspaceChanges } from "../src/workspace.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "isocline-commit-test-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", ".hooks");
  mkdirSync(join(root, ".hooks"));
  return { root, git, put: (file: string, text: string | Buffer) => writeFileSync(join(root, file), text) };
}

test("review shows whole selected files versus HEAD, pins contents, and preserves excluded files and staging", async () => {
  const { root, git, put } = fixture();
  mkdirSync(join(root, "nested"));
  const name = "空 格.txt";
  const folder = join(root, "nested");
  const path = "nested/" + name;
  const selected = [name, "new.bin"], allowed = [...selected, "editor.txt"];
  put(path, "original\n"); put("nested/editor.txt", "start\n"); put("unrelated", "base\n");
  git("add", "."); git("commit", "-qm", "start");
  put(path, "existing edit\n"); git("add", path);
  const base = await snapshot(folder);
  put(path, "existing edit\nagent edit\n"); put("unrelated", "separate staged\n"); git("add", "unrelated");
  put("nested/editor.txt", "external edit\n"); put("nested/new.bin", Buffer.from([0, 1, 2]));
  await assert.rejects(createWorktree(folder, join(root, "unused"), "isocline/nested"), { code: "subproject" });
  assert.equal(existsSync(join(root, "unused")), false);
  const preview = await reviewCommit(folder, selected, allowed);
  assert.match(preview.patch, /\+existing edit/);
  assert.match(preview.patch, /Binary files/);
  assert.doesNotMatch(preview.patch, /editor\.txt|unrelated/);
  const original = git("rev-parse", "HEAD");
  put(path, "same length!\nagent edit\n");
  await assert.rejects(reviewCommit(folder, selected, allowed, { message: "save", token: preview.token, base }), { code: "changed" });
  assert.equal(git("rev-parse", "HEAD"), original);
  assert.equal(git("show", ":" + path), "existing edit");
  put(path, "existing edit\nagent edit\n");
  const result = await reviewCommit(folder, selected, allowed, { message: "save", token: preview.token, base });
  assert.equal(git("rev-parse", "HEAD"), result.commit);
  assert.equal(git("show", "HEAD:" + path), "existing edit\nagent edit");
  assert.equal(git("show", "HEAD:nested/editor.txt"), "start");
  assert.equal(git("show", ":unrelated"), "separate staged");
  assert.deepEqual((await workspaceChanges(folder, result.base, [])).files.map((f) => f.path), ["editor.txt"]);
});

test("repository hooks run, and a changed tree or rejected ref leaves staging and the branch intact", async () => {
  const { root, git, put } = fixture();
  put("a", "first\n"); git("add", "a"); git("commit", "-qm", "start");
  const head = git("rev-parse", "HEAD"), paths = ["new"];
  put("new", "reviewed\n");
  const preview = await reviewCommit(root, paths, paths);
  const submit = () => reviewCommit(root, paths, paths, { message: "save", token: preview.token, base: head });
  const hook = (name: string, body: string) => writeFileSync(join(root, ".hooks", name), "#!/bin/sh\n" + body, { mode: 0o755 });
  hook("pre-commit", 'echo formatted > new\ngit add new\n');
  await assert.rejects(submit(), { code: "changed" });
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.equal(git("ls-files", "new"), "");
  assert.equal(existsSync(join(root, ".git", "index.lock")), false);
  put("new", "reviewed\n");
  hook("pre-commit", 'echo ran > .git/alfred-test-hook\n');
  hook("reference-transaction", 'test "$1" != prepared\n');
  await assert.rejects(submit());
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.equal(git("ls-files", "new"), "");
  assert.equal(readFileSync(join(root, ".git", "alfred-test-hook"), "utf8").trim(), "ran");
});

test("an unborn checkout and oversized changes cannot produce misleading reviews", async () => {
  const { root, git, put } = fixture();
  put("a", "hi\n");
  await assert.rejects(reviewCommit(root, ["a"], ["a"]), { code: "no_commit" });
  git("add", "a"); git("commit", "-qm", "start");
  put("a", "a".repeat(8 * 1024 * 1024 + 32));
  await assert.rejects(reviewCommit(root, ["a"], ["a"]), { code: "large_diff" });
});


test("legacy and unavailable baselines expose only project files, and a changed file cannot widen a partial commit", async () => {
  const { root, git, put } = fixture();
  const folder = join(root, "project");
  mkdirSync(folder);
  put("project/known", "one\n"); put("sibling", "other\n");
  git("add", "."); git("commit", "-qm", "start");
  mkdirSync(join(folder, "directory"));
  symlinkSync(root, join(folder, "linked"));
  const paths = ["known", "../sibling", "./known", ".", root, "directory", "linked/sibling"];
  const receipts = paths.map((path) => ({ path, created: false, added: 1, removed: 0 }));
  for (const base of [null, "missing-baseline"]) {
    assert.deepEqual((await workspaceChanges(folder, base, receipts)).files.map((file) => file.path), ["known"]);
  }
  for (const path of paths.slice(1)) await assert.rejects(reviewCommit(folder, [path], paths), { code: "changed" });
  assert.equal(git("diff", "--cached", "--name-only"), "");
});

test("a published commit survives noisy and interrupted post-commit hooks and retains unrelated staging", async () => {
  const { root, git, put } = fixture();
  put("a", "one\n"); put("b", "original\n"); git("add", "."); git("commit", "-qm", "start");
  put("b", "keep staged\n"); git("add", "b");
  const paths = ["a"];
  for (const [value, action] of [["two", "dd if=/dev/zero bs=1048576 count=9 2>/dev/null"], ["three", 'kill -TERM "$PPID"']]) {
    writeFileSync(join(root, ".hooks/post-commit"), "#!/bin/sh\n" + action + "\n", { mode: 0o755 });
    put("a", value + "\n");
    const base = await snapshot(root);
    const { token } = await reviewCommit(root, paths, paths);
    const result = await reviewCommit(root, paths, paths, { token, message: value, base });
    assert.equal(result.commit, git("rev-parse", "HEAD"));
    assert.equal(git("show", "HEAD:a"), value);
    assert.equal(git("diff", "--cached", "--name-only"), "b");
    assert.equal(git("show", ":b"), "keep staged");
    assert.equal(git("diff", "--name-only"), "");
  }
});

test("a failed commit leaves the existing set of baseline refs unchanged", async () => {
  const { root, git, put } = fixture();
  put("a", "original\n"); git("add", "."); git("commit", "-qm", "start");
  put("a", "user edit\n");
  const base = await snapshot(root);
  put("a", "user edit\nmore\n");
  const paths = ["a"], refs = () => git("for-each-ref", "refs/isocline/snapshots");
  const before = refs();
  const { token } = await reviewCommit(root, paths, paths);
  writeFileSync(join(root, ".hooks/pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await assert.rejects(reviewCommit(root, paths, paths, { token, message: "update", base }));
  assert.equal(refs(), before);
});
