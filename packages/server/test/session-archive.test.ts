import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, claimNextRun, finishRun, getConversation, getRun, openRequest, resumeRun, startSession, submitRun, trustProject } from "@zirma/core";
import { createHttpServer } from "../src/http.ts";
import { openHome, type Home } from "../src/home.ts";

function setup(dataDir = mkdtempSync(join(tmpdir(), "archive-world-"))) {
  return openHome({ dataDir, modules: [], engine: { submit: async () => ({ reply: "ok" }) } });
}

function session(home: Home) {
  const folder = mkdtempSync(join(tmpdir(), "archive-folder-"));
  const project = addProject(home.world, { path: folder });
  trustProject(home.world, project.id);
  return startSession(home.world, { projectId: project.id, title: "Edit", worktree: { path: folder, branch: "task" } });
}

const send = (home: Home, id: string, key: string) => submitRun(home.world, { conversationId: id, requestId: key, goal: key, profile: "developer" }).run;

async function archived(home: Home, id: string) {
  for (let i = 0; i < 100 && !getConversation(home.world, id).archivedAt; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(getConversation(home.world, id).archivedAt);
}

test("finish before archive survives restart, permits the interrupted task to resume, and preserves its new files", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "archive-restart-"));
  let home = setup(dataDir);
  try {
    const s = session(home);
    const run = send(home, s.id, "first");
    claimNextRun(home.world, "first-home");
    await assert.rejects(home.archives.request(s.id), { code: "archive_busy", count: 1 });
    await home.archives.request(s.id, "finish");
    assert.equal(getConversation(home.world, s.id).archivedAt, null);
    assert.throws(() => send(home, s.id, "new"), { code: "session_closed" });
    assert.throws(() => home.archives.beginWorkspaceOperation(s.id), { code: "session_closed" });
    home.close();
    home = setup(dataDir);
    assert.equal(getRun(home.world, run.id).run.state, "interrupted");
    assert.equal(getConversation(home.world, s.id).archivePlan, "finish");
    resumeRun(home.world, run.id);
    claimNextRun(home.world, home.owner);
    writeFileSync(join(s.worktree!, "later.txt"), "change made while finishing");
    finishRun(home.world, run.id, home.owner, { status: "completed" });
    await archived(home, s.id);
    assert.equal(readFileSync(join(s.worktree!, "later.txt"), "utf8"), "change made while finishing");
    assert.throws(() => send(home, s.id, "late"), { code: "session_closed" });
  } finally { home.close(); }
});

test("stop and archive cancels queued turns and waits for a real stop from the turn awaiting permission", async () => {
  const home = setup();
  try {
    const s = session(home);
    const run = send(home, s.id, "running");
    claimNextRun(home.world, home.owner);
    openRequest(home.world, run.id, home.owner, { kind: "permission", question: "Write?" });
    const queued = send(home, s.id, "queued");
    await assert.rejects(home.archives.request(s.id), { code: "archive_busy", count: 2 });
    await home.archives.request(s.id, "stop");
    assert.equal(getRun(home.world, queued.id).run.state, "cancelled");
    assert.equal(getRun(home.world, run.id).run.state, "cancelling");
    assert.equal(getConversation(home.world, s.id).archivedAt, null);
    assert.equal(getConversation(home.world, s.id).archivePlan, "stop");
    finishRun(home.world, run.id, home.owner, { status: "cancelled" });
    await archived(home, s.id);
  } finally { home.close(); }
});

test("an outstanding git operation pins the workspace until its result is recorded", async () => {
  const home = setup();
  try {
    const s = session(home);
    const release = home.archives.beginWorkspaceOperation(s.id);
    await assert.rejects(home.archives.request(s.id), { code: "archive_busy", count: 1 });
    await home.archives.request(s.id, "finish");
    assert.equal(getConversation(home.world, s.id).archivedAt, null);
    release();
    await archived(home, s.id);
  } finally { home.close(); }
});

test("HTTP clients see an explicit archive choice and can finish the original task on the normal route", async () => {
  const started = Promise.withResolvers<void>(), answer = Promise.withResolvers<{ reply: string }>();
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "archive-http-")), modules: [],
    engine: { submit: async () => { started.resolve(); return answer.promise; } } });
  const server = createHttpServer(home, { port: 0, uiDir: "/nonexistent" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const s = session(home), path = `/api/conversations/${s.id}`;
    assert.equal((await post("/api/runs", { requestId: "http-original", conversationId: s.id, goal: "Work" })).status, 202);
    await started.promise;
    const busy = await post(path, { archived: true });
    assert.equal(busy.status, 409);
    assert.equal((await busy.json() as { code: string }).code, "archive_busy");
    const deferred = await post(path, { archived: true, archiveRuns: "finish" });
    assert.equal(deferred.status, 200);
    assert.equal((await deferred.json() as { archivePlan: string }).archivePlan, "finish");
    const blocked = await post("/api/runs", { requestId: "http-later", conversationId: s.id, goal: "Another job" });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json() as { code: string }).code, "session_closed");
    answer.resolve({ reply: "Finished" });
    await archived(home, s.id);
    const state = await (await fetch(base + "/api/conversations/archived")).json() as { conversations: { id: string }[] };
    assert.ok(state.conversations.some((item) => item.id === s.id));
  } finally {
    answer.resolve({ reply: "Done" });
    await home.idle();
    server.closeAllConnections();
    server.close();
    home.close();
  }
});
