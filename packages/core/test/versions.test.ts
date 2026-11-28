import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  addFile, againRun, CORE_MIGRATIONS, createRunDrain, getConversation, getRun, listConversations, listRunFiles, openWorld,
  recordDomainEvent, resumeRun, RunError, runAfter, submitRun, useVersion, type EngineRequest, type World,
} from "../src/index.ts";

const profiles = { chat: { instructions: "", tools: [] } };
const world = (): World => openWorld(":memory:", CORE_MIGRATIONS);

/** Runs everything queued; the engine answers "re: <goal>" and remembers what it was given. */
async function drain(w: World, heard: EngineRequest[] = []) {
  await createRunDrain(w, { submit: async (request) => { heard.push(request); return { reply: `re: ${request.goal}` }; } }, { owner: "home", profiles }).kick();
  return heard;
}
const ask = (w: World, requestId: string, goal: string, conversationId?: string) =>
  submitRun(w, { requestId, goal, profile: "chat", conversationId }).run;
const code = (error: unknown) => error instanceof RunError ? error.code : String(error);

test("the last turn can be regenerated or edited: a new version, the old one set aside, the conversation goes on from the new one", async () => {
  const w = world();
  const first = ask(w, "a", "Plan a trip");
  await drain(w);
  const second = ask(w, "b", "Make it cheaper", first.conversationId);
  await drain(w);

  const again = againRun(w, second.id, { requestId: "b2" });
  assert.equal(again.replayed, false);
  assert.equal(again.run.goal, "Make it cheaper");
  assert.equal(again.run.versionOf, second.id);
  assert.equal(again.run.state, "queued");
  assert.equal(getRun(w, second.id).run.setAside, true);
  assert.equal(runAfter(w, again.run), first.id, "it goes on from the turn before");
  assert.equal(againRun(w, second.id, { requestId: "b2" }).replayed, true, "the same request is the same run");
  assert.throws(() => againRun(w, second.id, { requestId: "b2", goal: "else" }), (error) => code(error) === "conflict");

  const heard = await drain(w);
  assert.deepEqual(heard[0].history.map((turn) => turn.text), ["Plan a trip", "re: Plan a trip"], "the set-aside version is not in the history");
  assert.equal(heard[0].after, first.id);

  // Edit: the new version of the same turn carries the new words; the group stays the first run's.
  const edited = againRun(w, again.run.id, { requestId: "b3", goal: "  Make it cheaper, by train  " }).run;
  assert.equal(edited.goal, "Make it cheaper, by train");
  assert.equal(edited.versionOf, second.id);
  await drain(w);

  // The next message goes on from the version in use; the list shows its words.
  const next = ask(w, "c", "Book it", first.conversationId);
  const after = await drain(w);
  assert.equal(after[0].after, edited.id);
  assert.deepEqual(after[0].history.map((turn) => turn.text).slice(-2), ["Make it cheaper, by train", "re: Make it cheaper, by train"]);
  assert.equal(listConversations(w).find((c) => c.id === first.conversationId)?.lastGoal, "Book it");
  assert.equal(runAfter(w, getRun(w, next.id).run), edited.id);
});

test("switching versions: only the last turn's, the others set aside, and the next turn goes on from it", async () => {
  const w = world();
  const first = ask(w, "a", "Name for a cat");
  await drain(w);
  const second = againRun(w, first.id, { requestId: "a2" }).run;
  await drain(w);
  assert.equal(runAfter(w, second), null, "a conversation's first turn goes on from nothing");

  const used = useVersion(w, first.id);
  assert.equal(used.setAside, false);
  assert.equal(getRun(w, second.id).run.setAside, true);
  assert.equal(useVersion(w, first.id).id, first.id, "using the one in use changes nothing");
  assert.throws(() => againRun(w, second.id, { requestId: "x" }), (error) => code(error) === "not_last", "a set-aside version is not the last turn");

  const next = ask(w, "b", "Another", first.conversationId);
  await drain(w);
  assert.equal(runAfter(w, getRun(w, next.id).run), first.id);
  assert.throws(() => useVersion(w, second.id), (error) => code(error) === "not_last", "only the last turn switches");
  assert.throws(() => useVersion(w, next.id), (error) => code(error) === "state", "a turn with one version has nothing to switch to");
});

test("not offered: an earlier turn, one that changed things, while something runs, an automation's turn", async () => {
  const w = world();
  const first = ask(w, "a", "Hello");
  await drain(w);
  const second = ask(w, "b", "Add a todo", first.conversationId);
  await drain(w);
  assert.throws(() => againRun(w, first.id, { requestId: "x1" }), (error) => code(error) === "not_last");

  // A receipt of a change made by the turn.
  w.tx(() => recordDomainEvent(w, { kind: "todo.added", subject: "todo:t1", runId: second.id, payload: {}, now: Date.now() }));
  assert.throws(() => againRun(w, second.id, { requestId: "x2" }), (error) => code(error) === "did_something");

  // Something queued in the conversation.
  const third = ask(w, "c", "Thanks", first.conversationId);
  assert.throws(() => againRun(w, third.id, { requestId: "x3" }), (error) => code(error) === "busy");
  await drain(w);
  assert.ok(againRun(w, third.id, { requestId: "x4" }).run);

  // An automation's own run.
  const auto = submitRun(w, { requestId: "auto", goal: "Brief", profile: "chat", automationId: "rule1" }).run;
  await drain(w);
  assert.throws(() => againRun(w, auto.id, { requestId: "x5" }), (error) => code(error) === "session");

  assert.throws(() => againRun(w, "nope", { requestId: "x6" }), (error) => code(error) === "missing");
  assert.throws(() => againRun(w, third.id, { requestId: "x7", goal: "   " }), (error) => code(error) === "invalid");
});

test("a failed or interrupted turn can be done again; the set-aside one no longer waits on the user", async () => {
  const w = world();
  const run = ask(w, "a", "Hello");
  await createRunDrain(w, { submit: async () => { throw new Error("model down"); } }, { owner: "home", profiles }).kick();
  assert.equal(getRun(w, run.id).run.state, "failed");
  assert.ok(againRun(w, run.id, { requestId: "a2" }).run, "a failed turn: retry");

  const w2 = world();
  const cut = ask(w2, "b", "Long job");
  w2.db.prepare("UPDATE core_runs SET state = 'interrupted' WHERE id = ?").run(cut.id);
  assert.equal(listConversations(w2)[0].attention, 1);
  againRun(w2, cut.id, { requestId: "b2" });
  assert.equal(listConversations(w2)[0].attention, 0, "the set-aside interrupted turn does not wait on the user");
  assert.throws(() => resumeRun(w2, cut.id), (error) => code(error) === "state", "and cannot be continued");
});

test("a new version goes with the first version's files; its unread reply moves with it", async () => {
  const w = world();
  const file = addFile(w, { name: "plan.txt", type: "text/plain", kind: "text", size: 4, sha256: "a".repeat(64) });
  const run = submitRun(w, { requestId: "a", goal: "Read this", profile: "chat", attachments: [file.id] }).run;
  await drain(w);
  assert.equal(getConversation(w, run.conversationId).unreadReplyId, run.id);
  const again = againRun(w, run.id, { requestId: "a2" }).run;
  assert.equal(getConversation(w, run.conversationId).unreadReplyId, null, "the set-aside reply is no longer the unread one");
  assert.deepEqual(listRunFiles(w, [again.id])[again.id]?.map((f) => f.id), [file.id]);
  await drain(w);
  assert.equal(getConversation(w, run.conversationId).unreadReplyId, again.id);
});

test("upgrading: every existing run is a first version, in use", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zirma-versions-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "world.sqlite");
  const before = openWorld(path, CORE_MIGRATIONS.filter((migration) => migration.id !== "core:34"));
  const old = submitRun(before, { requestId: "old", goal: "Old", profile: "chat" }).run;
  before.close();
  const after = openWorld(path, CORE_MIGRATIONS);
  t.after(() => after.close());
  const run = getRun(after, old.id).run;
  assert.equal(run.versionOf, null);
  assert.equal(run.setAside, false);
});
