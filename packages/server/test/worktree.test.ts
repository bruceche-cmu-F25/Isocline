/** D5 (docs/design/dev-mode.md): a session in a worktree of its own, committing its changes, pushing them with a pull
 * request, and background processes. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnginePort } from "@zirma/core";
import { todoModule } from "@zirma/module-todo";
import { command } from "../src/commands.ts";
import type { Conversation, ConversationDetail, ProjectBranches, SessionBranch, SessionChanges, SessionProcess, SessionProcesses, SubmitRunResponse } from "@zirma/protocol";
import { ASSISTANT_PROFILE, createHttpServer, DEVELOPER_PROFILE, openHome, profiles, type Home } from "../src/index.ts";

async function start(home: Home): Promise<{ server: Server; base: string }> {
  const server = createHttpServer(home, { port: 0, uiDir: "/nonexistent" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = async <T>(base: string, path: string) => (await (await fetch(`${base}${path}`)).json()) as T;

function repo() {
  const folder = mkdtempSync(join(tmpdir(), "alfred-repo-"));
  const sh = (...args: string[]) => String(execFileSync("git", ["-C", folder, ...args], { stdio: "pipe" }));
  sh("init", "-q", "-b", "main");
  sh("config", "user.email", "test@example.com");
  sh("config", "user.name", "Test");
  writeFileSync(join(folder, "a.txt"), "one\n");
  sh("add", ".");
  sh("commit", "-qm", "start");
  return { folder, sh };
}

/** Waits until the run asks something, and answers it. */
async function answer(base: string, conversation: string, runId: string, reply: string): Promise<string | undefined> {
  for (let tries = 0; tries < 500; tries++) {
    const detail = await get<ConversationDetail>(base, `/api/conversations/${conversation}`);
    const asked = detail.runs.find((run) => run.id === runId)?.request;
    if (asked) {
      await post(base, `/api/runs/${runId}/respond`, { requestId: asked.id, answer: reply });
      return asked.detail;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the run never asked");
}

test("a session in a worktree: its own folder and branch, committed, archived and brought back", async () => {
  const { folder, sh } = repo();
  writeFileSync(join(folder, "a.txt"), "one\nmine\n"); // the user's own work in the project, which the worktree leaves alone
  let root = "";
  const engine: EnginePort = {
    async submit(request) {
      root = request.workspace!.root;
      writeFileSync(join(root, "new.txt"), "x\ny\n");
      request.external.changed?.({ path: "new.txt", added: 2, removed: 0, created: true });
      return { reply: "Done." };
    },
  };
  const dataDir = mkdtempSync(join(tmpdir(), "alfred-"));
  const home = openHome({ dataDir, engine, modules: [todoModule] });
  const { server, base } = await start(home);
  try {
    const project = await (await post(base, "/api/projects", { path: folder })).json() as { id: string };
    await post(base, `/api/projects/${project.id}/trust`, {});
    const created = await post(base, "/api/conversations", { requestId: "w-1", projectId: project.id, title: "Add a new file", mode: "edits", worktree: true });
    assert.equal(created.status, 201);
    const session = await created.json() as { id: string; worktree: string; branch: string; base: string };
    assert.equal(session.branch, "zirma/add-a-new-file");
    assert.ok(session.worktree.startsWith(join(dataDir, "worktrees", project.id)) || session.worktree.includes("/worktrees/"), session.worktree);
    assert.equal(readFileSync(join(session.worktree, "a.txt"), "utf8"), "one\n", "the worktree is what was committed");
    assert.equal(session.base, sh("rev-parse", "HEAD").trim());

    const { run } = await (await post(base, "/api/runs", { requestId: "w-r1", goal: "Add new.txt", conversationId: session.id })).json() as SubmitRunResponse;
    await home.idle();
    assert.equal((await get<ConversationDetail>(base, `/api/conversations/${session.id}`)).runs.find((one) => one.id === run.id)?.outcome?.reply, "Done.");
    assert.equal(root, session.worktree, "the run worked in the worktree");
    assert.ok(!existsSync(join(folder, "new.txt")), "not in the project's folder");

    let changes = await get<SessionChanges>(base, `/api/conversations/${session.id}/changes`);
    assert.equal(changes.branch, "zirma/add-a-new-file");
    assert.deepEqual(changes.files.map((file) => file.path), ["new.txt"]);

    // Committed from the panel: only the session's files, and the panel starts again from there.
    const paths = changes.suggested!;
    assert.deepEqual(paths, ["new.txt"]);
    const { token } = await (await post(base, `/api/conversations/${session.id}/commit-preview`, { paths })).json() as { token: string };
    assert.equal((await post(base, `/api/conversations/${session.id}/commit`, { requestId: "w-c1", message: "Add new.txt", paths, token })).status, 200);
    assert.equal(String(execFileSync("git", ["-C", session.worktree, "log", "-1", "--format=%s"])).trim(), "Add new.txt");
    changes = await get<SessionChanges>(base, `/api/conversations/${session.id}/changes`);
    assert.deepEqual(changes.files, []);
    const branch = await get<SessionBranch>(base, `/api/conversations/${session.id}/branch`);
    assert.deepEqual({ ...branch }, { branch: "zirma/add-a-new-file", main: "main", ahead: 1, upstream: false, remote: false });
    assert.equal((await post(base, `/api/conversations/${session.id}/commit`, { requestId: "w-c2", message: "Again" })).status, 400, "nothing left to commit");

    // No remote: nothing is pushed.
    const published = await post(base, `/api/conversations/${session.id}/publish`, { requestId: "w-p1", title: "Add new.txt" });
    assert.equal(published.status, 409);
    assert.equal(((await published.json()) as { code: string }).code, "git_no_remote");

    // Archiving with work not committed asks what to do with it.
    writeFileSync(join(session.worktree, "late.txt"), "late\n");
    const refused = await post(base, `/api/conversations/${session.id}`, { archived: true });
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: "1 file(s) in the worktree are not committed", code: "git_dirty", count: 1 });
    assert.equal((await post(base, `/api/conversations/${session.id}`, { archived: true, worktree: "discard" })).status, 200);
    assert.ok(!existsSync(session.worktree), "the worktree is gone");
    assert.match(sh("branch", "--list", "zirma/*"), /zirma\/add-a-new-file/, "its branch, with the commit, stays");
    assert.equal((await get<SessionChanges>(base, `/api/conversations/${session.id}/changes`)).gone, true);

    // Restored: the worktree comes back on its branch.
    assert.equal((await post(base, `/api/conversations/${session.id}`, { archived: false })).status, 200);
    assert.equal(readFileSync(join(session.worktree, "new.txt"), "utf8"), "x\ny\n");
    assert.equal(readFileSync(join(folder, "a.txt"), "utf8"), "one\nmine\n", "the user's own work was never touched");
  } finally {
    server.close();
    home.close();
  }
});

test("selecting an existing branch uses its tip, keeps project edits and respects other checkouts", async () => {
  const { folder, sh } = repo();
  const branch = "feature/聊天";
  sh("switch", "-qc", branch);
  writeFileSync(join(folder, "a.txt"), "feature\n");
  sh("commit", "-qam", "feature");
  const tip = sh("rev-parse", "HEAD").trim();
  sh("switch", "-q", "main");
  writeFileSync(join(folder, "a.txt"), "my local edits\n");
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine: { submit: async () => ({ reply: "ok" }) }, modules: [] });
  const { server, base } = await start(home);
  try {
    const project = await (await post(base, "/api/projects", { path: folder })).json() as { id: string };
    const list = `/api/projects/${project.id}/branches`;
    assert.equal((await fetch(base + list)).status, 409);
    await post(base, `/api/projects/${project.id}/trust`, {});
    const branches = await get<ProjectBranches>(base, list);
    assert.equal(branches.current, "main");
    assert.deepEqual(branches.branches.find((candidate) => candidate.name === branch), { name: branch, checkedOut: false });
    const startOn = (target: string, requestId: string) => post(base, "/api/conversations", { projectId: project.id, title: "Review", branch: target, requestId });
    const local = await startOn("main", "current-1");
    assert.equal(local.status, 201);
    assert.equal((await local.json() as Conversation).worktree, null);

    const requests = ["feature-1", "feature-2"];
    const claims = await Promise.all(requests.map((id) => startOn(branch, id)));
    assert.deepEqual(claims.map((res) => res.status).sort(), [201, 409]);
    const winning = claims.findIndex((response) => response.status === 201);
    const session = await claims[winning].json() as Conversation;
    assert.equal((await claims[1 - winning].json() as { code: string }).code, "git_branch_in_use");
    assert.equal(session.branch, branch);
    assert.equal(session.base, tip);
    assert.equal(readFileSync(join(session.worktree!, "a.txt"), "utf8"), "feature\n");
    assert.equal(((await (await startOn(branch, requests[winning])).json()) as Conversation).id, session.id);
    const update = (archived: boolean) => post(base, `/api/conversations/${session.id}`, { archived });
    assert.equal((await update(true)).status, 200);
    assert.equal(sh("rev-parse", `refs/heads/${branch}`).trim(), tip);
    const external = join(mkdtempSync(join(tmpdir(), "alfred-other-")), "checkout");
    sh("worktree", "add", "-q", external, branch);
    assert.equal((await get<ProjectBranches>(base, list)).branches.find((candidate) => candidate.name === branch)?.checkedOut, true);
    assert.equal((await (await update(false)).json() as { code: string }).code, "git_branch_in_use");
    assert.ok(existsSync(join(external, "a.txt")));
    sh("worktree", "remove", external);
    assert.equal((await update(false)).status, 200);
    assert.equal(readFileSync(join(session.worktree!, "a.txt"), "utf8"), "feature\n");
    assert.equal((await update(true)).status, 200);
    sh("branch", "-D", branch);
    assert.equal((await (await update(false)).json() as { code: string }).code, "git_branch_missing");
    assert.equal(sh("branch", "--show-current").trim(), "main");
    assert.equal(readFileSync(join(folder, "a.txt"), "utf8"), "my local edits\n");
  } finally { server.close(); home.close(); }
});

test("a worktree needs a git repository; a second session on the same title gets a branch of its own", async () => {
  const plain = mkdtempSync(join(tmpdir(), "alfred-plain-"));
  const { folder } = repo();
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine: { submit: async () => ({ reply: "ok" }) }, modules: [todoModule] });
  const { server, base } = await start(home);
  try {
    const one = await (await post(base, "/api/projects", { path: plain })).json() as { id: string };
    await post(base, `/api/projects/${one.id}/trust`, {});
    const refused = await post(base, "/api/conversations", { projectId: one.id, title: "x", worktree: true });
    assert.equal(refused.status, 400);
    assert.equal(((await refused.json()) as { code: string }).code, "git_not_git");

    const two = await (await post(base, "/api/projects", { path: folder })).json() as { id: string };
    await post(base, `/api/projects/${two.id}/trust`, {});
    const first = await (await post(base, "/api/conversations", { projectId: two.id, title: "修复登录", worktree: true })).json() as { branch: string };
    const second = await (await post(base, "/api/conversations", { projectId: two.id, title: "修复登录", worktree: true })).json() as { branch: string };
    assert.deepEqual([first.branch, second.branch], ["zirma/session", "zirma/session-2"]);
  } finally {
    server.close();
    home.close();
  }
});

test("background processes: started by the user or by Zirma (asked like a command), read, and stopped", async () => {
  const { folder } = repo();
  const engine: EnginePort = {
    async submit(request) {
      const tool = request.tools.find((one) => one.name === "process_start")!;
      const said = await tool.execute({ command: "echo listening on http://0.0.0.0:4321/ && sleep 30", name: "dev server" }, new AbortController().signal);
      return { reply: said };
    },
  };
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine, modules: [todoModule] });
  const { server, base } = await start(home);
  try {
    const project = await (await post(base, "/api/projects", { path: folder })).json() as { id: string };
    await post(base, `/api/projects/${project.id}/trust`, {});
    const session = await (await post(base, "/api/conversations", { projectId: project.id, title: "Run it", mode: "ask" })).json() as { id: string };

    // Zirma's: the user sees the command whole and allows it.
    const { run } = await (await post(base, "/api/runs", { requestId: "p-r1", goal: "start the dev server", conversationId: session.id })).json() as SubmitRunResponse;
    assert.match(String(await answer(base, session.id, run.id, "allow")), /sleep 30/);
    await home.idle();
    const reply = (await get<ConversationDetail>(base, `/api/conversations/${session.id}`)).runs.find((one) => one.id === run.id)?.outcome?.reply ?? "";
    assert.match(reply, /running in the background/);
    assert.match(reply, /http:\/\/localhost:4321\//, "0.0.0.0 is opened as localhost");

    // The user's own, from the panel.
    const mine = await (await post(base, `/api/conversations/${session.id}/processes`, { command: "echo hello; sleep 30" })).json() as SessionProcess;
    assert.equal(mine.by, "user");
    let list = (await get<SessionProcesses>(base, `/api/conversations/${session.id}/processes`)).processes;
    assert.deepEqual(list.map((one) => [one.name, one.by, one.exit]), [["dev server", "alfred", null], ["echo", "user", null]]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await get<{ text: string }>(base, `/api/conversations/${session.id}/processes/${mine.id}/logs`)).text, "hello");

    // Stopped, with what it started.
    assert.equal((await post(base, `/api/conversations/${session.id}/processes/${mine.id}/stop`, {})).status, 200);
    for (let tries = 0; tries < 100 && list.find((one) => one.id === mine.id)?.exit === null; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      list = (await get<SessionProcesses>(base, `/api/conversations/${session.id}/processes`)).processes;
    }
    assert.notEqual(list.find((one) => one.id === mine.id)?.exit, null);

    // Archiving the session stops the rest.
    assert.equal((await post(base, `/api/conversations/${session.id}`, { archived: true })).status, 200);
    assert.deepEqual((await get<SessionProcesses>(base, `/api/conversations/${session.id}/processes`)).processes, []);
  } finally {
    server.close();
    home.close();
  }
});

test("in plan mode Zirma cannot start a process", async () => {
  const { folder } = repo();
  const engine: EnginePort = {
    async submit(request) {
      return { reply: await request.tools.find((one) => one.name === "process_start")!.execute({ command: "sleep 30" }, new AbortController().signal) };
    },
  };
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine, modules: [todoModule] });
  const { server, base } = await start(home);
  try {
    const project = await (await post(base, "/api/projects", { path: folder })).json() as { id: string };
    await post(base, `/api/projects/${project.id}/trust`, {});
    const session = await (await post(base, "/api/conversations", { projectId: project.id, title: "Look", mode: "plan" })).json() as { id: string };
    const { run } = await (await post(base, "/api/runs", { requestId: "pl-1", goal: "start it", conversationId: session.id })).json() as SubmitRunResponse;
    await home.idle();
    assert.match((await get<ConversationDetail>(base, `/api/conversations/${session.id}`)).runs.find((one) => one.id === run.id)?.outcome?.reply ?? "", /did not allow/);
    assert.deepEqual((await get<SessionProcesses>(base, `/api/conversations/${session.id}/processes`)).processes, []);
  } finally {
    server.close();
    home.close();
  }
});

test("a development session is kept apart from the everyday: no module tools or their guidance", () => {
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine: { submit: async () => ({ reply: "ok" }) }, modules: [todoModule] });
  try {
    const all = profiles(home.world, [todoModule]);
    const names = all[DEVELOPER_PROFILE].tools.map((tool) => tool.name);
    assert.ok(names.includes("ask_user"));
    assert.ok(!names.some((name) => name.startsWith("todo_") || name === "propose" || name.startsWith("automation_")), names.join(", "));
    assert.ok(all[ASSISTANT_PROFILE].tools.some((tool) => tool.name === "todo_add"), "the everyday still has them");
    assert.ok(all[ASSISTANT_PROFILE].instructions.includes("Todos:") && !all[DEVELOPER_PROFILE].instructions.includes("Todos:"));
    assert.match(all[DEVELOPER_PROFILE].instructions, /about this project/);
  } finally {
    home.close();
  }
});

test("a conversation's speed is kept and reaches the engine; an unknown one is refused", async () => {
  const seen: Array<string | undefined> = [];
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine: { submit: async (request) => { seen.push(request.speed); return { reply: "ok" }; } }, modules: [todoModule] });
  const { server, base } = await start(home);
  try {
    const { run } = await (await post(base, "/api/runs", { requestId: "sp-1", goal: "hello" })).json() as SubmitRunResponse;
    await home.idle();
    assert.equal((await post(base, `/api/conversations/${run.conversationId}`, { speed: "warp" })).status, 400);
    const changed = await (await post(base, `/api/conversations/${run.conversationId}`, { speed: "fast" })).json() as { speed: string | null };
    assert.equal(changed.speed, "fast");
    await post(base, "/api/runs", { requestId: "sp-2", goal: "again", conversationId: run.conversationId });
    await home.idle();
    assert.deepEqual(seen, [undefined, "fast"]);
  } finally {
    server.close();
    home.close();
  }
});

test("checkout failures release only Zirma's allocations and simultaneous retries share one session", async () => {
  const { folder, sh } = repo();
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), modules: [], engine: { submit: async () => ({ reply: "ok" }) } });
  try {
    const { result } = await command(home, "project.add", { path: folder });
    const { id: projectId } = result as { id: string };
    await command(home, "project.trust", { id: projectId });
    const branch = "topics/发布+v1.2";
    sh("branch", branch);
    const create = (options: object) => command(home, "conversation.start", { projectId, title: "Try this", ...options });
    const hook = join(folder, ".git", "hooks", "post-checkout");
    sh("config", "core.hooksPath", join(folder, ".git", "hooks"));
    const branches = () => sh("for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads").trim().split("\n");
    const count = () => sh("worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length;
    writeFileSync(hook, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    for (const options of [{ branch }, { worktree: true }]) {
      await assert.rejects(create(options));
      assert.equal(count(), 1);
      assert.deepEqual(branches(), ["main", branch]);
    }

    writeFileSync(hook, "#!/bin/sh\nexit 0\n");
    home.world.db.exec("CREATE TEMP TRIGGER refuse_session BEFORE INSERT ON core_conversations BEGIN SELECT RAISE(ABORT, 'write refused'); END");
    for (const options of [{ branch }, { worktree: true }]) {
      await assert.rejects(create(options), /write refused/);
      assert.equal(count(), 1);
      assert.deepEqual(branches(), ["main", branch]);
    }
    home.world.db.exec("DROP TRIGGER refuse_session");
    const request = { branch, requestId: "same-branch-claim" };
    const [first, retry] = await Promise.all([create(request), create(request)]);
    assert.deepEqual(first.result, retry.result);
    assert.deepEqual([first.replayed, retry.replayed], [false, true]);
    assert.equal(count(), 2);

    // A hook can fail after writing files. Keep that checkout with the edits and report where to find it.
    writeFileSync(hook, "#!/bin/sh\necho hook-change >> a.txt\nexit 3\n");
    await assert.rejects(create({ worktree: true }), /folder was kept at/);
    assert.equal(count(), 3);
    assert.equal(readFileSync(join(folder, "a.txt"), "utf8"), "one\n");
  } finally { home.close(); }
});
