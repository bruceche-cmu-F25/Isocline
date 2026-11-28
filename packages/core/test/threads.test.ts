import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addProject, answerRequest, claimNextRun, finishRun, markConversationReplyRead, startSession, trustProject, CORE_MIGRATIONS, createRunDrain, getConversation, getRun, heartbeatRun, listArchivedConversations, listConversations, listEvents, listNotices,
  openWorld, recordDomainEvent, requestCancel, RunError, submitRun, sweepRuns, updateConversation, updateSettings,
  type EnginePort, type RunProfile, type RunTool, type World,
} from "../src/index.ts";

const TOY = { id: "toy:1", sql: "CREATE TABLE toys (id TEXT PRIMARY KEY NOT NULL) STRICT;" };
const world = (): World => openWorld(":memory:", [...CORE_MIGRATIONS, TOY]);
const toys = (w: World) => w.db.prepare("SELECT id FROM toys ORDER BY id").all().map((row) => row.id);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function addToy(w: World): RunTool {
  return {
    name: "toy_add", label: "Add toy", description: "", parameters: { type: "object" },
    describe: (params) => String(params.name),
    execute: (params) => { w.tx(() => { w.db.prepare("INSERT INTO toys (id) VALUES (?)").run(String(params.name)); recordDomainEvent(w, { kind: "toy.added", payload: {} }); }); return "ok"; },
  };
}
function dropToy(w: World): RunTool {
  return {
    name: "toy_drop", label: "Drop toy", description: "", parameters: { type: "object" },
    permission: (params) => `Throw away ${String(params.name)} for good`,
    execute: (params) => { w.tx(() => { w.db.prepare("DELETE FROM toys WHERE id = ?").run(String(params.name)); recordDomainEvent(w, { kind: "toy.dropped", payload: {} }); }); return "dropped"; },
  };
}
function askUser(): RunTool {
  return {
    name: "ask_user", label: "Ask", description: "", parameters: { type: "object" },
    execute: (params, _signal, context) => context!.ask({ question: String(params.question), options: params.options as string[] }),
  };
}
const profiles = (w: World): Record<string, RunProfile> => ({ tasks: { instructions: "", tools: [addToy(w), dropToy(w), askUser()] } });
const tool = (request: Parameters<EnginePort["submit"]>[0], name: string) => request.tools.find((candidate) => candidate.name === name)!;

test("ordinary replies stay unread until that reply is viewed; archive clears the dot and stale reads cannot clear a later one", () => {
  const w = world();
  const reply = (requestId: string, conversationId?: string) => {
    const run = submitRun(w, { requestId, conversationId, goal: "What time is it?", profile: "assistant" }).run;
    assert.equal(claimNextRun(w, "home")?.id, run.id);
    finishRun(w, run.id, "home", { status: "completed", reply: "Noon." });
    return run;
  };
  const first = reply("one");
  const chat = first.conversationId;
  assert.equal(listConversations(w)[0].unreadReplyId, first.id);
  assert.equal(listNotices(w).some((n) => n.payload.runId === first.id), false);
  const second = reply("two", chat);
  markConversationReplyRead(w, chat, first.id);
  assert.equal(getConversation(w, chat).unreadReplyId, second.id);
  const lastActivity = getConversation(w, chat).updatedAt;
  markConversationReplyRead(w, chat, second.id);
  markConversationReplyRead(w, chat, second.id);
  assert.equal(getConversation(w, chat).unreadReplyId, null);
  assert.equal(getConversation(w, chat).updatedAt, lastActivity);
  assert.equal(listEvents(w).events.filter((e) => e.kind === "conversation.read").length, 1);
  reply("three", chat);
  updateConversation(w, chat, { archived: true });
  assert.equal(updateConversation(w, chat, { archived: false }).unreadReplyId, null);
  w.close();
});

test("upgrading leaves old chats read and a new unread project reply survives a restart", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "alfred-unread-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "world.sqlite");
  const prior = openWorld(path, CORE_MIGRATIONS.filter((m) => m.id !== "core:21"));
  const old = submitRun(prior, { requestId: "old", goal: "Old question", profile: "assistant" }).run;
  prior.db.prepare("UPDATE core_runs SET state = 'completed', outcome = ? WHERE id = ?")
    .run(JSON.stringify({ status: "completed", reply: "Earlier reply", receipts: [] }), old.id);
  prior.close();

  const upgraded = openWorld(path, CORE_MIGRATIONS);
  assert.equal(getConversation(upgraded, old.conversationId).unreadReplyId, null);
  const project = trustProject(upgraded, addProject(upgraded, { path: dir }).id);
  const session = startSession(upgraded, { title: "Review", projectId: project.id });
  const run = submitRun(upgraded, { requestId: "fresh", conversationId: session.id, goal: "Explain this function", profile: "developer" }).run;
  assert.equal(claimNextRun(upgraded, "home")?.id, run.id);
  finishRun(upgraded, run.id, "home", { status: "completed", reply: "It loads the settings." });
  upgraded.close();

  const reopened = openWorld(path, CORE_MIGRATIONS);
  t.after(() => reopened.close());
  assert.equal(getConversation(reopened, session.id).unreadReplyId, run.id);
  markConversationReplyRead(reopened, session.id, run.id);
  assert.equal(getConversation(reopened, session.id).unreadReplyId, null);
});

test("a first message starts a conversation named after it; later ones continue it", () => {
  const w = world();
  const { run } = submitRun(w, { requestId: "r1", goal: "Plan   the trip to\nLisbon in March with the kids", profile: "tasks" });
  const conversation = getConversation(w, run.conversationId);
  assert.equal(conversation.title, "Plan the trip to Lisbon in March with t…");
  const next = submitRun(w, { requestId: "r2", goal: "and book a hotel", profile: "tasks", conversationId: conversation.id }).run;
  assert.equal(next.conversationId, conversation.id);
  assert.equal(getConversation(w, conversation.id).busy, 2);
  assert.throws(() => submitRun(w, { requestId: "r3", goal: "x", profile: "tasks", conversationId: "nope" }), /No such conversation/);
});

test("conversations can be renamed and archived, and say what needs the user", () => {
  const w = world();
  const { run } = submitRun(w, { requestId: "r1", goal: "first", profile: "tasks" });
  updateConversation(w, run.conversationId, { title: "  Taxes 2026 " });
  updateConversation(w, run.conversationId, { archived: true });
  assert.equal(listConversations(w).length, 0);
  const [archived] = listConversations(w, { includeArchived: true });
  assert.equal(archived.title, "Taxes 2026");
  assert.ok(archived.archivedAt);
  assert.deepEqual(listEvents(w).events.map((event) => event.kind).filter((kind) => kind.startsWith("conversation.")),
    ["conversation.created", "conversation.renamed", "conversation.archived"]);
});

test("the archive includes older conversations and restoring one brings it back to the recent list once", () => {
  const w = world();
  const add = (title: string, now: number) => submitRun(w, { requestId: title, goal: title, profile: "tasks", now }).run.conversationId;
  const older = add("older", 1), newer = add("newer", 2);
  updateConversation(w, older, { archived: true, now: 3 });
  updateConversation(w, newer, { archived: true, now: 4 });
  for (let i = 0; i < 101; i++) add(`active-${i}`, i + 5);
  const archive = () => listArchivedConversations(w, { includeSessions: false }).map((row) => row.id);
  assert.deepEqual(archive(), [newer, older]);
  const restored = updateConversation(w, older, { archived: false, now: 200 });
  assert.equal(restored.archivedAt, null);
  assert.equal(listConversations(w)[0].id, older);
  assert.deepEqual(archive(), [newer]);
  assert.equal(updateConversation(w, older, { archived: false, now: 201 }).updatedAt, restored.updatedAt);
  assert.equal(listEvents(w, { limit: 500 }).events.filter((event) => event.kind === "conversation.restored").length, 1);
});

test("different conversations run side by side; one conversation runs in order", async () => {
  const w = world();
  const started: string[] = [];
  const release = new Map<string, () => void>();
  const engine: EnginePort = { submit: (request) => new Promise((resolve) => { started.push(request.goal); release.set(request.goal, () => resolve({ reply: "ok" })); }) };
  const a1 = submitRun(w, { requestId: "a1", goal: "a1", profile: "tasks" }).run;
  submitRun(w, { requestId: "a2", goal: "a2", profile: "tasks", conversationId: a1.conversationId });
  submitRun(w, { requestId: "b1", goal: "b1", profile: "tasks" });
  const done = createRunDrain(w, engine, { owner: "home", profiles: profiles(w) }).kick();
  await tick();
  assert.deepEqual(started.sort(), ["a1", "b1"], "a2 waits for a1 in its conversation");
  release.get("a1")!();
  await tick();
  assert.ok(started.includes("a2"));
  release.get("a2")!(); release.get("b1")!();
  await done;
});

test("each tool call is a step, with what it was about", async () => {
  const w = world();
  const { run } = submitRun(w, { requestId: "r1", goal: "add a kite", profile: "tasks" });
  await createRunDrain(w, { submit: async (request) => { await tool(request, "toy_add").execute({ name: "kite" }, new AbortController().signal); return { reply: "ok" }; } },
    { owner: "home", profiles: profiles(w) }).kick();
  const steps = getRun(w, run.id).events.filter((event) => event.kind === "run.step").map((event) => [event.payload.tool, event.payload.about, event.payload.status]);
  assert.deepEqual(steps, [["toy_add", "kite", "started"], ["toy_add", "kite", "done"]]);
  assert.equal(getRun(w, run.id).run.outcome?.receipts.length, 1, "steps are not receipts");
});

test("a run can stop to ask, and continues with the user's answer", async () => {
  const w = world();
  const { run } = submitRun(w, { requestId: "r1", goal: "add a toy", profile: "tasks" });
  const engine: EnginePort = {
    async submit(request) {
      const answer = await tool(request, "ask_user").execute({ question: "Which one?", options: ["kite", "ball"] }, new AbortController().signal);
      await tool(request, "toy_add").execute({ name: answer }, new AbortController().signal);
      return { reply: `Added ${answer}` };
    },
  };
  const done = createRunDrain(w, engine, { owner: "home", profiles: profiles(w) }).kick();
  await tick();
  const waiting = getRun(w, run.id).run;
  assert.equal(waiting.state, "waiting_input");
  assert.deepEqual(waiting.request?.options, ["kite", "ball"]);
  const notice = listNotices(w).find((candidate) => candidate.kind === "run_request")!;
  assert.equal(notice.payload.question, "Which one?");
  assert.throws(() => answerRequest(w, run.id, { requestId: "stale", answer: "kite" }), RunError);
  answerRequest(w, run.id, { requestId: waiting.request!.id, answer: "ball" });
  await done;
  assert.equal(getRun(w, run.id).run.state, "completed");
  assert.deepEqual(toys(w), ["ball"]);
  assert.equal(listNotices(w).some((candidate) => candidate.kind === "run_request"), false, "the question is closed once answered");
  const answered = listEvents(w).events.find((event) => event.kind === "run.answered")!;
  assert.equal(answered.actor, "user");
});

test("an irreversible tool runs only after the user allows that one call", async () => {
  const w = world();
  w.db.prepare("INSERT INTO toys (id) VALUES ('kite'), ('ball')").run();
  const engine: EnginePort = {
    async submit(request) {
      const first = await tool(request, "toy_drop").execute({ name: "kite" }, new AbortController().signal);
      const second = await tool(request, "toy_drop").execute({ name: "ball" }, new AbortController().signal);
      return { reply: `${first} / ${second}` };
    },
  };
  const { run } = submitRun(w, { requestId: "r1", goal: "throw both away", profile: "tasks" });
  const done = createRunDrain(w, engine, { owner: "home", profiles: profiles(w) }).kick();
  await tick();
  let current = getRun(w, run.id).run;
  assert.equal(current.state, "waiting_permission");
  assert.equal(current.request?.question, "Throw away kite for good");
  assert.deepEqual(current.request?.options, ["allow", "deny"]);
  assert.throws(() => answerRequest(w, run.id, { requestId: current.request!.id, answer: "sure" }), /allow or deny/);
  answerRequest(w, run.id, { requestId: current.request!.id, answer: "allow" });
  await tick();
  current = getRun(w, run.id).run;
  assert.equal(current.request?.question, "Throw away ball for good", "the next call asks again");
  answerRequest(w, run.id, { requestId: current.request!.id, answer: "deny" });
  await done;
  assert.deepEqual(toys(w), ["ball"]);
  assert.match(getRun(w, run.id).run.outcome!.reply!, /dropped \/ The user did not allow this/);
});

test("a run waiting on the user outlasts its lease (the machine slept) and goes on when they answer", async () => {
  const w = world();
  w.db.prepare("INSERT INTO toys (id) VALUES ('kite')").run();
  const { run } = submitRun(w, { requestId: "r1", goal: "throw the kite away", profile: "tasks" });
  const engine: EnginePort = { submit: async (request) => ({ reply: await tool(request, "toy_drop").execute({ name: "kite" }, new AbortController().signal) }) };
  // No heartbeat in this test: the answer comes before the executor's first one after waking.
  const done = createRunDrain(w, engine, { owner: "home", profiles: profiles(w), heartbeatMs: 1e9 }).kick();
  await tick();
  assert.equal(getRun(w, run.id).run.state, "waiting_permission");
  // The lid was closed for an hour: nothing ran, and the lease is long past.
  w.db.prepare("UPDATE core_runs SET lease_until = ?").run(new Date(Date.now() - 3_600_000).toISOString());
  sweepRuns(w);
  const waiting = getRun(w, run.id).run;
  assert.equal(waiting.state, "waiting_permission", "still asking");
  assert.equal(listNotices(w).some((notice) => notice.kind === "run_interrupted"), false);
  assert.deepEqual(heartbeatRun(w, run.id, "home"), { cancelRequested: false }, "its executor still holds it");
  w.db.prepare("UPDATE core_runs SET lease_until = ?").run(new Date(Date.now() - 3_600_000).toISOString());

  answerRequest(w, run.id, { requestId: waiting.request!.id, answer: "allow" });
  await done;
  assert.equal(getRun(w, run.id).run.state, "completed");
  assert.deepEqual(toys(w), [], "what the answer allowed was done");
});

test("stopping a waiting run after sleep needs neither an answer nor a heartbeat", async () => {
  const w = world();
  const { run } = submitRun(w, { requestId: "r1", goal: "ask me", profile: "tasks" });
  const done = createRunDrain(w, { submit: async (request) => ({ reply: await tool(request, "ask_user").execute({ question: "?" }, new AbortController().signal) }) },
    { owner: "home", profiles: profiles(w), heartbeatMs: 1e9 }).kick();
  await tick();
  assert.equal(getRun(w, run.id).run.state, "waiting_input");
  w.db.prepare("UPDATE core_runs SET lease_until = ? WHERE id = ?").run(new Date(Date.now() - 3_600_000).toISOString(), run.id);
  requestCancel(w, run.id);
  await done;
  const final = getRun(w, run.id).run;
  assert.equal(final.state, "cancelled");
  assert.equal(final.request, null);
});

test("a run remembers the page it was asked from and hands it to the engine; a malformed one is refused", async () => {
  const w = world();
  const context = { view: "todo.list", title: "Todos", summary: "3 open, 1 overdue", selection: { id: "t1", title: "Hand in report" } };
  const { run } = submitRun(w, { requestId: "r1", goal: "what first?", profile: "tasks", context });
  assert.deepEqual(run.context, context);
  assert.equal(submitRun(w, { requestId: "r1", goal: "what first?", profile: "tasks", context }).run.id, run.id, "a replay is the same run");
  assert.throws(() => submitRun(w, { requestId: "r1", goal: "what first?", profile: "tasks", context: { view: "core.inbox" } }), RunError,
    "the same request id from another page is a different request");
  assert.equal(submitRun(w, { requestId: "r2", goal: "hi", profile: "tasks" }).run.context, null);

  // Said out loud: kept, and only as `true`.
  assert.deepEqual(submitRun(w, { requestId: "r3", goal: "明天三点交材料", profile: "tasks", context: { view: "core.voice", spoken: true } }).run.context, { view: "core.voice", spoken: true });
  for (const bad of [{ view: "Todo List" }, { view: "todo.list", summary: "x".repeat(301) }, { view: "todo.list", selection: {} }, { view: "core.voice", spoken: "yes" }, "todo.list", [1]]) {
    assert.throws(() => submitRun(w, { requestId: `bad-${JSON.stringify(bad).length}`, goal: "x", profile: "tasks", context: bad }), /Invalid view context/);
  }

  const seen: unknown[] = [];
  await createRunDrain(w, { submit: async (request) => { seen.push(request.context); return { reply: "ok" }; } }, { owner: "home", profiles: profiles(w) }).kick();
  assert.equal(seen.length, 3);
  assert.deepEqual(seen.filter(Boolean), [context, { view: "core.voice", spoken: true }], "only runs asked from a page, or by voice, carry one");
});

test("a first message can carry the model, thinking level and speed its new conversation is made with", async () => {
  const w = world();
  updateSettings(w, { model: "anthropic/claude-sonnet-5-5", thinking: "low" });
  const tuned = submitRun(w, { requestId: "t1", goal: "hi", profile: "tasks", model: "openai/gpt-5.4", thinking: "high", speed: "fast" });
  const made = getConversation(w, tuned.run.conversationId);
  assert.deepEqual([made.model, made.thinking, made.speed], ["openai/gpt-5.4", "high", "fast"]);
  // The same request again is the same run; with another choice it is a different request.
  assert.equal(submitRun(w, { requestId: "t1", goal: "hi", profile: "tasks", model: "openai/gpt-5.4", thinking: "high", speed: "fast" }).replayed, true);
  assert.throws(() => submitRun(w, { requestId: "t1", goal: "hi", profile: "tasks", model: "openai/gpt-5.5" }), RunError);
  // Only a new conversation takes them: an open one is changed with updateConversation.
  assert.throws(() => submitRun(w, { requestId: "t2", goal: "more", profile: "tasks", conversationId: made.id, model: "openai/gpt-5.4" }), /first message only/);
  assert.throws(() => submitRun(w, { requestId: "t3", goal: "hi", profile: "tasks", thinking: "huge" as never }), /Unknown thinking level/);
  assert.throws(() => submitRun(w, { requestId: "t4", goal: "hi", profile: "tasks", speed: "slow" as never }), /Unknown speed/);
  assert.throws(() => submitRun(w, { requestId: "t5", goal: "hi", profile: "tasks", model: "no slash" }), /provider\/model/);
  assert.equal(listConversations(w).length, 1, "a refused first message makes no conversation");
  const seen: unknown[] = [];
  await createRunDrain(w, { submit: async (request) => { seen.push([request.model, request.thinking]); return { reply: "ok" }; } }, { owner: "home", profiles: profiles(w) }).kick();
  assert.deepEqual(seen, [["openai/gpt-5.4", "high"]], "the picked model and level win over the defaults");
});

test("a conversation without its own model uses the user's default model and thinking level", async () => {
  const w = world();
  updateSettings(w, { model: "anthropic/claude-sonnet-5-5", thinking: "low" });
  const first = submitRun(w, { requestId: "m1", goal: "hi", profile: "tasks" }).run;
  const second = submitRun(w, { requestId: "m2", goal: "hi", profile: "tasks" }).run;
  updateConversation(w, second.conversationId, { model: "openai/gpt-5.4", thinking: "high" });
  const seen: Record<string, [unknown, unknown]> = {};
  await createRunDrain(w, { submit: async (request) => { seen[request.thread] = [request.model, request.thinking]; return { reply: "ok" }; } }, { owner: "home", profiles: profiles(w) }).kick();
  assert.deepEqual(seen[first.conversationId], ["anthropic/claude-sonnet-5-5", "low"]);
  assert.deepEqual(seen[second.conversationId], ["openai/gpt-5.4", "high"], "the conversation's own choice wins");
});
