import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  addProject, CORE_MIGRATIONS, createRunDrain, getConversation, getRun, isSession, listEvents, listProjects, openWorld, ProjectError,
  removeProject, runInSession, sessionEvent, sessionIds, startSession, submitRun, trustProject, updateConversation,
  type EngineRequest, type EnginePort, type RunProfile, type World,
} from "../src/index.ts";

const world = (): World => openWorld(":memory:", CORE_MIGRATIONS);
const folder = () => mkdtempSync(join(tmpdir(), "alfred-project-"));
const PROFILES: Record<string, RunProfile> = {
  assistant: { instructions: "", tools: [] },
  developer: { instructions: "Work in the project.", tools: [], workspace: true, modes: { plan: "Read only.", ask: "Ask before each change.", edits: "Change freely." } },
};

test("a project is a real folder, added once, untrusted until the user says so", () => {
  const w = world();
  const dir = folder();
  mkdirSync(join(dir, "app"));
  symlinkSync(join(dir, "app"), join(dir, "link"));
  const added = addProject(w, { path: join(dir, "link") });
  assert.equal(added.path, realpathSync(join(dir, "app")), "symlinks are resolved");
  assert.equal(added.name, "app");
  assert.equal(added.trustedAt, null);
  assert.equal(addProject(w, { path: join(dir, "app") }).id, added.id, "the same folder twice is one project");
  assert.throws(() => addProject(w, { path: "relative/path" }), ProjectError);
  assert.throws(() => addProject(w, { path: join(dir, "missing") }), /does not exist/);

  assert.throws(() => startSession(w, { projectId: added.id, title: "How is it built?" }), (error: ProjectError) => error.code === "untrusted");
  assert.ok(trustProject(w, added.id).trustedAt);
  const session = startSession(w, { projectId: added.id, title: "How is it built?" });
  assert.equal(session.projectId, added.id);
  assert.equal(session.title, "How is it built?");
  assert.deepEqual(listEvents(w).events.map((event) => event.kind).filter((kind) => kind.startsWith("project.")), ["project.added", "project.trusted"]);

  removeProject(w, added.id);
  assert.equal(listProjects(w).length, 0);
  assert.equal(getConversation(w, session.id).projectId, added.id, "its sessions stay");
});

test("a session's runs get the project's folder; a wrong profile or a removed project fails the run", async () => {
  const w = world();
  const project = trustProject(w, addProject(w, { path: folder(), name: "Shop" }).id);
  const session = startSession(w, { projectId: project.id, title: "Where is checkout?" });
  const seen: EngineRequest[] = [];
  const engine: EnginePort = { async submit(request) { seen.push(request); return { reply: "In src/checkout.ts" }; } };
  const drain = createRunDrain(w, engine, { owner: "test-owner", profiles: PROFILES });

  const ok = submitRun(w, { requestId: "r1", goal: "Where is checkout?", profile: "developer", conversationId: session.id }).run;
  await drain.kick();
  assert.equal(getRun(w, ok.id).run.state, "completed");
  assert.deepEqual(seen[0].workspace, { root: project.path, name: "Shop", mode: "edits", commands: [] });
  assert.equal(seen[0].instructions, "Work in the project.\n\nChange freely.", "the run is told what its mode allows");
  // The user's other trusted projects go along (free to look in); an untrusted one does not.
  const site = trustProject(w, addProject(w, { path: folder(), name: "Site" }).id);
  addProject(w, { path: folder(), name: "Unread" });
  submitRun(w, { requestId: "r1o", goal: "Like the site?", profile: "developer", conversationId: session.id });
  await drain.kick();
  assert.deepEqual(seen[1].workspace?.others, [{ name: "Site", root: site.path }]);
  seen.splice(1, 1);
  updateConversation(w, session.id, { mode: "plan" });
  submitRun(w, { requestId: "r1b", goal: "And the cart?", profile: "developer", conversationId: session.id });
  await drain.kick();
  assert.equal(seen[1].instructions, "Work in the project.\n\nRead only.");
  seen.length = 1;

  // The everyday profile in a session, or a session profile outside one, never reaches the engine.
  const wrong = submitRun(w, { requestId: "r2", goal: "Hi", profile: "assistant", conversationId: session.id }).run;
  const daily = submitRun(w, { requestId: "r3", goal: "Hi", profile: "developer" }).run;
  await drain.kick();
  assert.equal(getRun(w, wrong.id).run.outcome?.error, "wrong_profile");
  assert.equal(getRun(w, daily.id).run.outcome?.error, "wrong_profile");

  removeProject(w, project.id);
  const gone = submitRun(w, { requestId: "r4", goal: "And now?", profile: "developer", conversationId: session.id }).run;
  await drain.kick();
  assert.equal(getRun(w, gone.id).run.outcome?.error, "project_unavailable");
  assert.equal(seen.length, 1);
});

test("a new coding session uses its project's last startup choice, including after restart", (t) => {
  const path = join(folder(), "world.sqlite");
  const old = openWorld(path, CORE_MIGRATIONS.filter((migration) => migration.id !== "core:32"));
  const app = trustProject(old, addProject(old, { path: folder() }).id);
  old.db.prepare("INSERT INTO core_conversations (id, title, created_at, updated_at, project_id, mode) VALUES ('legacy', 'Review', ?, ?, ?, 'ask')")
    .run(app.createdAt, app.createdAt, app.id);
  old.close();
  const w = openWorld(path, CORE_MIGRATIONS);
  assert.equal(getConversation(w, "legacy").mode, "ask", "upgrading a project preserves permissions for open sessions");
  const site = trustProject(w, addProject(w, { path: folder() }).id);
  const first = startSession(w, { projectId: app.id, title: "Build a feature" });
  assert.equal(first.mode, "edits");
  assert.equal(startSession(w, { projectId: app.id, title: "Review", mode: "ask" }).mode, "ask");
  updateConversation(w, first.id, { mode: "plan" });
  w.close();

  const reopened = openWorld(path, CORE_MIGRATIONS);
  t.after(() => reopened.close());
  assert.equal(getConversation(reopened, first.id).mode, "plan", "a mid-session change is local to that session");
  assert.equal(startSession(reopened, { projectId: app.id, title: "Another review" }).mode, "ask");
  assert.equal(startSession(reopened, { projectId: site.id, title: "Other project" }).mode, "edits");
  assert.equal(startSession(reopened, { projectId: app.id, title: "Plan", mode: "plan" }).mode, "plan");
  assert.equal(startSession(reopened, { projectId: app.id, title: "Continue planning" }).mode, "plan");
});

test("what belongs to a development session can be told from what does not", () => {
  const w = world();
  const project = trustProject(w, addProject(w, { path: folder() }).id);
  const session = startSession(w, { projectId: project.id, title: "Fix the build" });
  const inside = submitRun(w, { requestId: "r1", goal: "look", profile: "developer", conversationId: session.id }).run;
  const everyday = submitRun(w, { requestId: "r2", goal: "what is on today", profile: "assistant" }).run;
  assert.deepEqual([...sessionIds(w)], [session.id]);
  assert.equal(isSession(w, session.id), true);
  assert.equal(isSession(w, everyday.conversationId), false);
  assert.equal(isSession(w, undefined), false);
  assert.equal(isSession(w, "nope"), false);
  assert.equal(runInSession(w, inside.id), true);
  assert.equal(runInSession(w, everyday.id), false);
  // An event is a session's when it was recorded under one of its runs, or is about the session itself.
  assert.equal(sessionEvent(w, { runId: inside.id, subject: null }), true);
  assert.equal(sessionEvent(w, { runId: everyday.id, subject: `conversation:${session.id}` }), false);
  assert.equal(sessionEvent(w, { runId: null, subject: `conversation:${session.id}` }), true);
  assert.equal(sessionEvent(w, { runId: null, subject: `conversation:${everyday.conversationId}` }), false);
  assert.equal(sessionEvent(w, { runId: null, subject: "todo:1" }), false);
});
