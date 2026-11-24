/** A development session's folder as git sees it: the snapshot it started from, what has changed since, and one
 * file's diff (docs/design/dev-mode.md 4.5). Towards the user's repository it only adds: `git stash create` makes a
 * commit object of the working tree without touching the tree, the index's contents, a branch or the stash, and one
 * ref under `refs/zirma/snapshots/` (before the renames, `refs/isocline/snapshots/` and `refs/alfred/snapshots/`, which stay) points at that commit, because git deletes a commit nothing points at.
 * A folder that is not a git repository has no snapshot; its changes are the session's own receipts.
 */
import { execFile } from "node:child_process";
import type { ProjectBranches } from "@zirma/protocol";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";

export interface ChangedFile { path: string; added: number; removed: number; created: boolean }
export interface WorkspaceChanges {
  /** The current branch, when it is a git repository. */
  branch: string | null;
  base: string | null;
  files: ChangedFile[];
}

function git(root: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile("git", ["-C", root, ...args], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout) => {
      // `git diff --no-index` exits 1 when the files differ; its output is still the diff.
      const code = (error as { code?: unknown } | null)?.code;
      resolve({ ok: !error || (code === 1 && !!stdout), out: String(stdout) });
    });
  });
}

/** Where the snapshots of working trees are kept from git's garbage collection. */
export const SNAPSHOT_REFS = "refs/zirma/snapshots/";

/** The snapshot a session's changes are measured against: the working tree as it is now, or HEAD when it is clean.
 * Null when the folder is not in a git repository (or has no commit yet). */
export async function snapshot(root: string): Promise<string | null> {
  if (!(await git(root, ["rev-parse", "--is-inside-work-tree"])).ok) return null;
  const stash = await git(root, ["stash", "create"]);
  const id = stash.ok ? stash.out.trim() : "";
  if (/^[0-9a-f]{7,64}$/.test(id)) {
    // Nothing points at this commit, so `git gc` would delete it and the session would lose what it started from.
    await git(root, ["update-ref", `${SNAPSHOT_REFS}${id}`, id]);
    return id;
  }
  const head = await git(root, ["rev-parse", "HEAD"]);
  return head.ok && /^[0-9a-f]{7,64}$/.test(head.out.trim()) ? head.out.trim() : null;
}

/** Git names files relative to the selected project. A symlink may itself be a tracked file;
 * its children belong to the target directory and never participate in a session's review. */
export function inProject(root: string, path: string): string | null {
  if (!path || isAbsolute(path) || path.includes("\0")) return null;
  const parts = path.split(sep);
  if (parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) return null;
  let dir = root;
  try {
    for (const part of parts.slice(0, -1)) {
      dir = join(dir, part);
      const entry = lstatSync(dir, { throwIfNoEntry: false });
      if (!entry) break; // a tracked file and its containing folders may have been deleted
      if (!entry.isDirectory()) return null;
    }
  } catch { return null; }
  return path;
}

function receiptFile(root: string, entry: ChangedFile): boolean {
  if (!inProject(root, entry.path)) return false;
  try {
    const file = lstatSync(join(root, entry.path), { throwIfNoEntry: false });
    return !file || file.isFile() || file.isSymbolicLink();
  } catch { return false; }
}

const lines = (text: string) => text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;

/** What changed in the project since the session's snapshot. `written`: files the session itself changed (its
 * receipts), which is all there is outside git and adds the new files git does not track yet. */
export async function workspaceChanges(root: string, base: string | null, written: ChangedFile[]): Promise<WorkspaceChanges> {
  const branchOut = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchOut.ok ? branchOut.out.trim() || null : null;
  if (!base) return { branch, base, files: merged(written.filter((entry) => receiptFile(root, entry))) };
  const numstat = await git(root, ["diff", "--numstat", "-z", "--no-renames", "--relative", base, "--", "."]);
  if (!numstat.ok) return { branch, base, files: merged(written.filter((entry) => receiptFile(root, entry))) };
  const files = new Map<string, ChangedFile>();
  for (const row of numstat.out.split("\0")) {
    const [added, removed, ...rest] = row.split("\t");
    const path = rest.join("\t");
    if (!path) continue;
    files.set(path, { path, added: Number(added) || 0, removed: Number(removed) || 0, created: false });
  }
  // New files are untracked, so git's diff leaves them out: take the ones this session wrote, counted as they are now.
  for (const file of written) {
    const path = inProject(root, file.path);
    if (!path || files.has(path) || !file.created || !receiptFile(root, file)) continue;
    const full = join(root, path);
    if (!existsSync(full)) continue;
    const tracked = await git(root, ["ls-files", "--error-unmatch", "--", path]);
    if (tracked.ok) continue;
    let count = 0;
    try { count = lines(lstatSync(full).isSymbolicLink() ? readlinkSync(full) : readFileSync(full, "utf8")); } catch { /* unreadable */ }
    files.set(path, { path, added: count, removed: 0, created: true });
  }
  return { branch, base, files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

/** One file's diff against the snapshot (a new file against nothing). Null when there is no snapshot or the path leaves the project. */
export async function workspaceDiff(root: string, base: string | null, path: string): Promise<string | null> {
  const clean = inProject(root, path);
  if (!base || !clean) return null;
  const tracked = await git(root, ["ls-files", "--error-unmatch", "--", clean]);
  const inBase = await git(root, ["cat-file", "-e", `${base}:${(await prefix(root)) + clean.split(sep).join("/")}`]);
  if (tracked.ok || inBase.ok) {
    const diff = await git(root, ["diff", "--relative", base, "--", clean]);
    return diff.ok ? diff.out : null;
  }
  if (!existsSync(join(root, clean))) return null;
  const fresh = await git(root, ["diff", "--no-index", "--", "/dev/null", clean]);
  return fresh.ok ? fresh.out : null;
}

/** The project folder's path inside its repository ("" at the top), for naming a file in a commit. */
async function prefix(root: string): Promise<string> {
  const out = await git(root, ["rev-parse", "--show-prefix"]);
  return out.ok ? out.out.trim() : "";
}

/** One entry per path, the latest kept (a file written twice counts as it was last). */
function merged(written: ChangedFile[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const file of written) {
    const before = byPath.get(file.path);
    byPath.set(file.path, before ? { path: file.path, added: before.added + file.added, removed: before.removed + file.removed, created: before.created || file.created } : file);
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

// ── Worktrees, commits and pull requests (docs/design/dev-mode.md 4.2, 4.5; D5) ──────────────────────────────────

export class WorkspaceError extends Error {
  override name = "WorkspaceError";
  readonly code: "not_git" | "subproject" | "no_commit" | "dirty" | "large_diff" | "changed" | "nothing" | "failed" | "default_branch" | "branch_missing" | "branch_in_use" | "detached" | "no_remote" | "no_gh";
  /** For `dirty`: how many files are not committed. */
  readonly count?: number;
  constructor(code: WorkspaceError["code"], message: string, count?: number) { super(message); this.code = code; this.count = count; }
}

/** Where git and gh are looked for besides the home node's PATH, which the system may have started bare. */
const TOOL_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
const toolEnv = () => ({ ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", PATH: [process.env.PATH ?? "", ...TOOL_PATH].filter(Boolean).join(":") });

/** A command whose error is worth saying to the user (a hook that failed, a push that was refused). */
function tool(file: "git" | "gh", cwd: string, args: string[], timeout = 120_000): Promise<{ ok: boolean; out: string; err: string; missing?: boolean }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024, env: toolEnv() }, (error, stdout, stderr) => {
      const missing = (error as { code?: unknown } | null)?.code === "ENOENT";
      resolve({ ok: !error, out: String(stdout), err: String(stderr).trim() || (error ? error.message : ""), ...(missing ? { missing } : {}) });
    });
  });
}
/** The last few lines of what git said, for an error the user reads. */
const said = (text: string) => text.split("\n").filter(Boolean).slice(-6).join("\n").slice(0, 1200);

/** A branch name from a session's title: its latin words, else `session`; under `zirma/`. */
export function branchName(title: string): string {
  const words = title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const slug = words.join("-").slice(0, 40).replace(/-+$/, "");
  return `zirma/${slug || "session"}`;
}

async function requireRepositoryRoot(project: string): Promise<void> {
  const top = await git(project, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) throw new WorkspaceError("not_git", "This folder is not a Git working tree");
  if (realpathSync(top.out.replace(/\n$/, "")) !== realpathSync(project)) throw new WorkspaceError("subproject", "Select the root of the Git repository");
}

export async function projectBranches(project: string): Promise<ProjectBranches> {
  await requireRepositoryRoot(project);
  const [symbolic, refs] = await Promise.all([
    git(project, ["symbolic-ref", "--quiet", "HEAD"]),
    git(project, ["for-each-ref", "--format=%(refname:lstrip=2)%09%(if)%(worktreepath)%(then)1%(end)", "refs/heads/"]),
  ]);
  if (!refs.ok) throw new WorkspaceError("failed", "Could not list local Git branches");
  const current = symbolic.ok ? symbolic.out.replace(/\n$/, "").replace(/^refs\/heads\//, "") : null;
  const branches = refs.out.split("\n").filter(Boolean).map((row) => {
    const [name, occupied] = row.split("\t");
    return { name, checkedOut: occupied === "1" };
  });
  return { current, branches };
}

/** Checking an exact name in the local catalog also excludes tags, revisions and remote-only names. */
function requireFreeBranch(refs: ProjectBranches, branch: string) {
  const ref = refs.branches.find((candidate) => candidate.name === branch);
  if (!ref) throw new WorkspaceError("branch_missing", "That local branch no longer exists");
  if (ref.checkedOut) throw new WorkspaceError("branch_in_use", "That branch is already checked out in another folder");
}

/** Work on an existing local branch. Only the project folder may be reused. Every other checkout made here
 * belongs to this session and is safe for the normal archive lifecycle to remove. */
export async function checkoutSessionBranch(project: string, dir: string, branch: string) {
  const refs = await projectBranches(project);
  return refs.current === branch ? null : checkoutExistingBranch(project, dir, branch, refs);
}

interface Checkout { path: string; branch: string; base: string; createdFrom?: string }

async function checkoutExistingBranch(project: string, dir: string, branch: string, refs?: ProjectBranches): Promise<Checkout> {
  requireFreeBranch(refs ?? await projectBranches(project), branch);
  if (existsSync(dir)) throw new WorkspaceError("failed", "The checkout folder already exists");
  mkdirSync(dirname(dir), { recursive: true });
  const made = await tool("git", project, ["worktree", "add", "--no-guess-remote", "--", dir, branch]);
  if (!made.ok) {
    // A failing post-checkout hook can leave the checkout registered even when Git reports failure.
    if (existsSync(join(dir, ".git"))) {
      try { await removeWorktree(project, dir, false); }
      catch { throw new WorkspaceError("failed", `Checkout failed. The folder was kept at ${dir}. ${said(made.err)}`); }
    }
    // An external Git client may have claimed or deleted the branch since the list was read.
    requireFreeBranch(await projectBranches(project), branch);
    throw new WorkspaceError("failed", said(made.err) || "The branch could not be checked out");
  }
  const [actual, head] = await Promise.all([git(dir, ["symbolic-ref", "--quiet", "HEAD"]), git(dir, ["rev-parse", "HEAD"])]);
  if (!actual.ok || actual.out.replace(/\n$/, "") !== `refs/heads/${branch}` || !head.ok) {
    await removeWorktree(project, dir, false);
    throw new WorkspaceError("changed", "The branch changed during checkout. Choose it again.");
  }
  return { path: realpathSync(dir), branch, base: head.out.trim() };
}

/** Makes a worktree for a new session: a folder of its own at `dir`, on a new branch from the project's HEAD. */
export async function createWorktree(project: string, dir: string, want: string) {
  await requireRepositoryRoot(project);
  const head = await git(project, ["rev-parse", "HEAD"]);
  if (!head.ok) throw new WorkspaceError("no_commit", "The repository has no commit yet");
  const base = head.out.trim();
  for (let n = 1; ; n++) {
    const branch = n === 1 ? want : `${want}-${n}`;
    // Claim the ref first. This establishes ownership for rollback and also handles a concurrent branch creation.
    const created = await tool("git", project, ["branch", "--", branch, base]);
    if (!created.ok) {
      if ((await git(project, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok) continue;
      throw new WorkspaceError("failed", said(created.err) || "The branch could not be created");
    }
    try {
      const made = await checkoutExistingBranch(project, dir, branch);
      return { ...made, createdFrom: base };
    } catch (error) {
      await releaseNewBranch(project, branch, base);
      throw error;
    }
  }
}

/** Undo only Zirma's newly allocated ref when it still points at the original commit. Git's normal
 * branch deletion additionally protects checked-out branches and commits that have not been merged. */
export async function releaseNewBranch(project: string, branch: string, createdFrom: string) {
  const tip = await git(project, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (tip.ok && tip.out.trim() === createdFrom) await tool("git", project, ["branch", "-d", "--", branch]);
}

/** How many files in a folder are not committed (changed, new or deleted). */
export async function uncommitted(root: string): Promise<number> {
  const status = await git(root, ["status", "--porcelain"]);
  return status.ok ? status.out.split("\n").filter(Boolean).length : 0;
}

/** Removes a session's worktree. Its branch stays (its commits are the user's). `force`: also when it has
 * uncommitted changes, which are then lost. */
export async function removeWorktree(project: string, dir: string, force: boolean): Promise<void> {
  if (!existsSync(dir)) { await git(project, ["worktree", "prune"]); return; }
  if (!force) {
    const count = await uncommitted(dir);
    if (count > 0) throw new WorkspaceError("dirty", `${count} file(s) in the worktree are not committed`, count);
  }
  const removed = await tool("git", project, ["worktree", "remove", ...(force ? ["--force"] : []), dir]);
  if (!removed.ok) throw new WorkspaceError("failed", said(removed.err) || "The worktree could not be removed");
}

/** Brings back a removed worktree on its branch (a session restored from the archive). */
export async function restoreWorktree(project: string, dir: string, branch: string): Promise<void> {
  if (existsSync(dir)) return;
  await git(project, ["worktree", "prune"]);
  await checkoutExistingBranch(project, dir, branch);
}

/** Where a session's branch stands towards its remote and pull request, for the changes panel. */
export interface BranchState {
  branch: string | null;
  /** The repository's main branch (origin's HEAD, else main or master); no pull request is opened from it. */
  main: string | null;
  /** Commits not pushed yet: ahead of the branch's upstream, or of the main branch when it has none. */
  ahead: number;
  upstream: boolean;
  remote: boolean;
}

export async function branchState(root: string): Promise<BranchState> {
  const branchOut = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = branchOut.ok ? branchOut.out.trim() || null : null;
  const remote = (await git(root, ["remote", "get-url", "origin"])).ok;
  let main: string | null = null;
  const originHead = await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead.ok && originHead.out.trim()) main = originHead.out.trim().replace(/^origin\//, "");
  else for (const name of ["main", "master"]) if ((await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])).ok) { main = name; break; }
  const upstream = branch ? (await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).ok : false;
  const against = upstream ? "@{u}" : main && main !== branch ? (remote && (await git(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${main}`])).ok ? `origin/${main}` : main) : null;
  const count = against ? await git(root, ["rev-list", "--count", `${against}..HEAD`]) : null;
  return { branch, main, ahead: count?.ok ? Number(count.out.trim()) || 0 : 0, upstream, remote };
}

/** The open pull request for a branch, if gh can say. */
export async function pullRequest(root: string, branch: string): Promise<{ url: string; number: number; state: string } | null> {
  const view = await tool("gh", root, ["pr", "view", branch, "--json", "url,number,state"], 20_000);
  if (!view.ok) return null;
  try {
    const pr = JSON.parse(view.out) as { url?: unknown; number?: unknown; state?: unknown };
    return typeof pr.url === "string" && typeof pr.number === "number" ? { url: pr.url, number: pr.number, state: String(pr.state ?? "") } : null;
  } catch { return null; }
}

/** Pushes the session's branch to origin, then opens a pull request for it unless one is open already.
 * Outward and not undone: the device asks the user each time before it sends this. */
export async function publish(root: string, input: { title: string; body: string }): Promise<{ branch: string; url: string | null; created: boolean }> {
  const state = await branchState(root);
  if (!state.branch) throw new WorkspaceError("detached", "No branch is checked out");
  if (state.branch === state.main) throw new WorkspaceError("default_branch", `${state.branch} is the main branch; a pull request comes from another one`);
  if (!state.remote) throw new WorkspaceError("no_remote", "The repository has no remote called origin");
  const gh = await tool("gh", root, ["auth", "status"], 20_000);
  if (gh.missing) throw new WorkspaceError("no_gh", "The GitHub command line (gh) is not installed");
  if (!gh.ok) throw new WorkspaceError("no_gh", "gh is not signed in to GitHub (run gh auth login)");
  const pushed = await tool("git", root, ["push", "-u", "origin", `HEAD:refs/heads/${state.branch}`]);
  if (!pushed.ok) throw new WorkspaceError("failed", said(pushed.err) || "The push failed");
  // The upstream, for the panel's count (push -u sets it only when the names match, which they do).
  const open = await pullRequest(root, state.branch);
  if (open && open.state === "OPEN") return { branch: state.branch, url: open.url, created: false };
  const made = await tool("gh", root, ["pr", "create", "--head", state.branch, ...(state.main ? ["--base", state.main] : []), "--title", input.title, "--body", input.body], 60_000);
  if (!made.ok) throw new WorkspaceError("failed", said(made.err) || "The pull request could not be opened");
  const url = made.out.trim().split("\n").reverse().find((line) => /^https?:\/\//.test(line)) ?? null;
  return { branch: state.branch, url, created: true };
}
