/** Reviewed partial commits. A throwaway Git index pins the exact tree displayed to the user. */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, copyFile, lstat, mkdtemp, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { inProject, WorkspaceError, SNAPSHOT_REFS } from "./workspace.ts";

const exec = promisify(execFile);
const changed = () => new WorkspaceError("changed", "The selected changes or branch have changed. Review the diff again.");

async function git(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  try {
    const { stdout } = await exec("git", ["--literal-pathspecs", ...args], {
      cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env }, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new WorkspaceError("large_diff", "This diff exceeds the review limit; select fewer files or review it in Git.");
    throw new WorkspaceError("failed", String((error as { stderr?: string }).stderr || (error as Error).message).trim().slice(-1200));
  }
}

/** Hooks may print any amount of output. Drain both pipes to completion and retain only a diagnostic tail. */
function runCommit(root: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--literal-pathspecs", ...args], {
      cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env }, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
    });
    let tail = "";
    const read = (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-1200); };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("error", reject);
    child.once("close", (status, signal) => {
      if (status === 0) resolve();
      else reject(new WorkspaceError("failed", tail.trim() || `Git commit stopped (${signal ?? status}).`));
    });
  });
}

/** Preserve partial-commit semantics and the repository's hooks. Before Git moves the ref, verify the new
 * commit itself: another editor, a filter or a formatter hook may have changed the content after review. */
async function guardHooks(root: string, temp: string) {
  const source = (await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"])).trim();
  const hooks = join(temp, "hooks");
  await mkdir(hooks);
  const original = async (name: string) => {
    try { await access(join(source, name), constants.X_OK); return true; } catch { return false; }
  };
  // Forward hooks by their original path (e.g. Husky sources adjacent files). Git subprocesses started
  // by an installed hook also see the repository's other hooks.
  for (const entry of await readdir(source, { withFileTypes: true }).catch((error) => {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
    throw error;
  })) {
    if (entry.isDirectory() || entry.name === "reference-transaction" || !await original(entry.name)) continue;
    await writeFile(join(hooks, entry.name), '#!/bin/sh\nexec "$ZIRMA_HOOKS/${0##*/}" "$@"\n', { mode: 0o700 });
  }
  const guard = join(hooks, "reference-transaction");
  await copyFile(new URL("./commit-guard.sh", import.meta.url), guard);
  await chmod(guard, 0o700);
  return { hooks, source };
}

type CommitPreview = { token: string; patch: string };
type CommitResult = { commit: string; base: string | null };
type CommitRequest = { token: string; message: string; base: string | null };
export function reviewCommit(root: string, requested: string[], allowed: readonly string[]): Promise<CommitPreview>;
export function reviewCommit(root: string, requested: string[], allowed: readonly string[], commit: CommitRequest): Promise<CommitResult>;
export async function reviewCommit(root: string, requested: string[], allowed: readonly string[], commit?: CommitRequest): Promise<CommitPreview | CommitResult> {
  const paths = [...new Set(requested)].sort();
  if (!paths.length) throw new WorkspaceError("nothing", "Select files to commit");
  const candidates = new Set(allowed);
  if (paths.some((path) => !inProject(root, path) || !candidates.has(path))) throw changed();
  const temp = await mkdtemp(join(tmpdir(), "zirma-commit-"));
  const buildIndex = (args: string[]) => git(root, ["-c", "core.hooksPath=/dev/null", ...args], { GIT_INDEX_FILE: join(temp, "candidate") });
  try {
    const head = (await git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => { throw new WorkspaceError("no_commit", "This repository has no commit yet"); })).trim();
    const ref = (await git(root, ["rev-parse", "--symbolic-full-name", "HEAD"])).trim();
    for (const path of paths) {
      const entry = await lstat(join(root, path)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!entry || entry.isFile() || entry.isSymbolicLink()) continue;
      // A tracked Git submodule is one file entry despite being checked out as a directory.
      if (!entry.isDirectory() || !(await git(root, ["ls-tree", "-z", head, "--", path])).startsWith("160000 commit ")) throw changed();
    }
    await buildIndex(["read-tree", head]);
    await buildIndex(["add", "-A", "--", ...paths]);
    const tree = (await buildIndex(["write-tree"])).trim();
    // Verify exact repository-relative names before displaying a project-relative diff. A selected
    // tracked file replaced by a directory must never turn into a recursive add of its new children.
    const prefix = (await git(root, ["rev-parse", "--show-prefix"])).replace(/\n$/, "");
    const approved = new Set(paths.map((path) => prefix + path));
    const names = await git(root, ["diff", "--no-renames", "--ignore-submodules=none", "--no-relative", "--name-only", "-z", head, tree]);
    if (names.split("\0").some((name) => name && !approved.has(name))) throw changed();
    const token = createHash("sha256").update(JSON.stringify([head, ref, paths, tree])).digest("hex");
    const patch = await git(root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--full-index", "--relative", "--no-renames", head, tree, "--", "."]);
    if (!patch) throw new WorkspaceError("nothing", "No selected changes to commit");
    if (!commit) return { token, patch };
    if (commit.token !== token) throw changed();

    // Advance only selected paths in the session baseline; excluded changes stay available after this commit.
    let base = commit.base;
    if (base && base !== head) {
      await buildIndex(["read-tree", base]);
      await buildIndex(["reset", "-q", tree, "--", ...paths]);
      const baseTree = (await buildIndex(["write-tree"])).trim();
      base = (await git(root, ["commit-tree", baseTree, "-p", base, "-m", "Zirma session baseline"])).trim();
    }

    const index = (await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
    const lock = index + ".lock";
    const hooks = await guardHooks(root, temp);
    // Git operates on a copy of the user's index while its usual lock excludes concurrent index updates.
    // A rejected hook or stale review leaves the original staging area intact, including intent-to-add entries.
    const lockFile = await open(lock, "wx").catch(() => { throw new WorkspaceError("failed", "Git's index is busy. Try again when the other Git operation finishes."); });
    await lockFile.close();
    let moved = false;
    const stale = join(temp, "stale");
    const revisionFile = join(temp, "revision");
    const privateIndex = join(temp, "commit-index");
    const env = { GIT_INDEX_FILE: privateIndex, ZIRMA_REF: ref, ZIRMA_PARENT: head, ZIRMA_TREE: tree, ZIRMA_HOOKS: hooks.source, ZIRMA_STALE: stale, ZIRMA_REVISION: revisionFile, ZIRMA_REF_INPUT: join(temp, "ref-input") };
    try {
      if ((await git(root, ["rev-parse", "--symbolic-full-name", "HEAD"])).trim() !== ref || (await git(root, ["rev-parse", "HEAD"])).trim() !== head) throw changed();
      await copyFile(index, privateIndex);
      // Only untracked paths need registering for Git's --only partial commit; this is the private index.
      const untracked = (await git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...paths], env)).split("\0").filter(Boolean);
      if (untracked.length) await git(root, ["add", "-N", "--", ...untracked], env);
      let interrupted = false;
      try {
        await runCommit(root, ["-c", "core.hooksPath=" + hooks.hooks, "commit", "--only", "-m", commit.message, "--", ...paths], env);
      } catch (error) {
        // A timeout/termination after ref publication (e.g. in post-commit) cannot undo it.
        const prepared = await readFile(revisionFile, "utf8").catch(() => null);
        if (!prepared || (await git(root, ["rev-parse", "--verify", ref])).trim() !== prepared) throw error;
        interrupted = true;
      }
      const revision = (await readFile(revisionFile, "utf8")).trim();
      if (interrupted) {
        // Git might not have finished writing its private index. Reconcile just the reviewed entries with
        // the actual commit, preserving the original staging of every other path.
        await copyFile(index, lock);
        await git(root, ["-c", "core.hooksPath=/dev/null", "reset", "-q", revision, "--", ...paths], { GIT_INDEX_FILE: lock });
      } else await copyFile(privateIndex, lock);
      await rename(lock, index);
      moved = true;
      if (base && commit.base !== head) {
        try { await git(root, ["update-ref", SNAPSHOT_REFS + base, base]); }
        catch { base = revision; } // the published commit is itself a durable comparison base
      } else base = revision;
      return { commit: revision, base };
    } catch (error) {
      if (await readFile(stale).then(() => true, () => false)) throw changed();
      throw error;
    } finally {
      if (!moved) await rm(lock, { force: true });
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
}
