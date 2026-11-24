import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  answerRequest, CORE_MIGRATIONS, createRunDrain, getRun, listEvents, openWorld, recordDomainEvent, submitRun, updateConversation,
  type EngineRequest, type RunTool, type World,
} from "@isocline/core";
import { createWorkerEngine, type WorkerEngine } from "../src/index.ts";

const worker = fileURLToPath(new URL("./fixtures/fake-worker.ts", import.meta.url));
const engines: WorkerEngine[] = [];
const engine = (options: { idleMs?: number; abortGraceMs?: number; args?: string[] } = {}) => {
  const created = createWorkerEngine({ worker, ...options });
  engines.push(created);
  return created;
};
test.after(async () => { await Promise.all(engines.map((created) => created.close())); });
const pidOf = (reply: string) => Number(reply.split("pid=")[1]);
const signal = () => new AbortController().signal;

const noExternal: EngineRequest["external"] = { allow: async () => "deny", step: () => {}, receipt: () => {} };
function request(goal: string, tools: RunTool[] = [], extra: Partial<EngineRequest> = {}): EngineRequest {
  return { thread: "t1", goal, instructions: "", history: [], tools, today: "2026-11-18", timezone: "UTC", external: noExternal, ...extra };
}

test("a tool call travels to the home node and its result goes back to the model; text streams", async () => {
  const seen: unknown[] = [];
  const texts: string[] = [];
  const echo: RunTool = { name: "echo", label: "Echo", description: "", parameters: { type: "object" }, execute: (params) => { seen.push(params); return `got ${String(params.word)}`; } };
  const result = await engine().submit({ ...request('tool echo {"word":"kite"}', [echo]), onText: (text) => texts.push(text) }, new AbortController().signal);
  assert.equal(result.reply, "tool said: got kite");
  assert.deepEqual(seen, [{ word: "kite" }]);
  assert.deepEqual(texts, ["thinking"]);
});

test("a tool that fails reports its error to the model instead of crashing the run", async () => {
  const broken: RunTool = { name: "broken", label: "", description: "", parameters: {}, execute: () => { throw new Error("disk full"); } };
  const result = await engine().submit(request("tool broken {}", [broken]), new AbortController().signal);
  assert.equal(result.reply, "tool said: error: disk full");
});

test("a crashed worker fails only its run; the next run gets a fresh worker", async () => {
  const pool = engine();
  await assert.rejects(pool.submit(request("crash"), new AbortController().signal), { name: "EngineCrashedError" });
  assert.equal((await pool.submit(request("hello"), new AbortController().signal)).reply, "echo: hello");
});

test("aborting stops the worker's run; a worker that ignores it is killed", async () => {
  const pool = engine({ abortGraceMs: 100 });
  const polite = new AbortController();
  const hanging = pool.submit(request("hang"), polite.signal);
  setTimeout(() => polite.abort(), 50);
  await assert.rejects(hanging, { name: "AbortError" });

  const stubborn = new AbortController();
  const ignoring = pool.submit(request("stubborn"), stubborn.signal);
  setTimeout(() => stubborn.abort(new Error("cancelled")), 50);
  await assert.rejects(ignoring, /cancelled/);
});

test("warm workers are reused, parallel runs get their own, idle ones stop", async () => {
  const pool = engine({ idleMs: 200 });
  const first = (await pool.submit(request("who"), new AbortController().signal)).reply;
  const second = (await pool.submit(request("who", [], { thread: "t2", history: [{ role: "user", text: "earlier" }] }), new AbortController().signal)).reply;
  assert.equal(first.split("pid=")[1], second.split("pid=")[1], "the same warm worker");
  assert.match(first, /^t1 history=no/);
  assert.match(second, /^t2 history=yes/);
  const both = await Promise.all([pool.submit(request("who"), new AbortController().signal), pool.submit(request("who"), new AbortController().signal)]);
  assert.notEqual(both[0].reply.split("pid=")[1], both[1].reply.split("pid=")[1], "two at once need two workers");
  assert.equal(pool.size(), 2);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(pool.size(), 0, "idle workers are stopped");
});

test("the engine's own tools ask through the home node; only a yes runs them, and leaves a receipt", async () => {
  const pool = engine();
  const asked: string[] = [];
  const steps: string[] = [];
  const receipts: string[] = [];
  const hooks = (answer: boolean): EngineRequest["external"] => ({
    allow: async (question) => { asked.push(question); return answer ? "allow" : "deny"; },
    step: (step) => steps.push(`${step.tool}:${step.status}`),
    receipt: (call) => receipts.push(call.tool),
  });
  assert.equal((await pool.submit(request("external notes_send", [], { external: hooks(false) }), new AbortController().signal)).reply, "external denied");
  assert.equal((await pool.submit(request("external notes_send", [], { external: hooks(true) }), new AbortController().signal)).reply, "external allowed");
  assert.deepEqual(asked, ["Use notes_send?", "Use notes_send?"]);
  assert.deepEqual(steps, ["notes_send:declined", "notes_send:started", "notes_send:done"]);
  assert.deepEqual(receipts, ["notes_send"]);
});

test("a conversation goes back to the worker that holds its warm session", async () => {
  const pool = engine();
  const first = pidOf((await pool.submit(request("who", [], { thread: "a" }), signal())).reply);
  // While that worker is busy with "a", "b" needs another one.
  const slow = pool.submit(request("slow", [], { thread: "a" }), signal());
  const b = pidOf((await pool.submit(request("who", [], { thread: "b" }), signal())).reply);
  await slow;
  assert.notEqual(b, first);
  // Both idle now: each conversation returns to its own worker.
  assert.equal(pidOf((await pool.submit(request("who", [], { thread: "b" }), signal())).reply), b);
  assert.equal(pidOf((await pool.submit(request("who", [], { thread: "a" }), signal())).reply), first);
  assert.equal(pool.holder("a"), first);
});

test("a conversation whose worker is busy moves: the old holder lets go first", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "alfred-pool-")), "log");
  const pool = engine({ args: ["--log", log] });
  const holder = pidOf((await pool.submit(request("who", [], { thread: "a" }), signal())).reply);
  const busy = pool.submit(request("slow", [], { thread: "other" }), signal()); // occupies the holder
  const moved = pidOf((await pool.submit(request("who", [], { thread: "a" }), signal())).reply);
  await busy;
  assert.notEqual(moved, holder);
  assert.equal(pool.holder("a"), moved);
  assert.match(readFileSync(log, "utf8"), new RegExp(`^${holder} release a$`, "m"));
});

test("the user's words reach the turn that is running; with nothing running they are refused", async () => {
  const pool = engine();
  const working = pool.submit(request("slow", [], { thread: "s" }), signal());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await pool.steer!("s", "also buy milk"), true);
  assert.equal((await working).reply, "you added: also buy milk");
  assert.equal(await pool.steer!("s", "too late"), false);
});

test("usage, the chosen model and the model list come back from the worker", async () => {
  const pool = engine();
  const usage: unknown[] = [];
  const reply = (await pool.submit(request("who", [], { model: "openai/gpt-x", thinking: "high", onUsage: (u) => usage.push(u) }), signal())).reply;
  assert.match(reply, /model=openai\/gpt-x/);
  assert.deepEqual(usage, [{ model: "openai/gpt-x", thinking: "high", tokens: 1200, contextWindow: 100000, percent: 1.2 }]);
  assert.deepEqual(await pool.models!(), [{ id: "fake-1", provider: "fake", name: "Fake One", reasoning: true }]);
});

test("closing the engine asks each worker to close its sessions before it exits", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "alfred-pool-")), "log");
  const pool = createWorkerEngine({ worker, args: ["--log", log] });
  await pool.submit(request("who", [], { thread: "x" }), signal());
  await pool.close();
  assert.equal(pool.size(), 0);
  assert.ok(existsSync(log));
  assert.match(readFileSync(log, "utf8"), / shutdown x$/m);
});

test("through the core: the model's tool writes under the run's lease; a crash keeps what was done and redoes nothing", async () => {
  const w: World = openWorld(":memory:", [...CORE_MIGRATIONS, { id: "toy:1", sql: "CREATE TABLE toys (id TEXT PRIMARY KEY NOT NULL) STRICT;" }]);
  const add: RunTool = {
    name: "toy_add", label: "Add toy", description: "", parameters: { type: "object" },
    execute: (params) => { w.tx(() => { w.db.prepare("INSERT INTO toys (id) VALUES (?)").run(String(params.name)); recordDomainEvent(w, { kind: "toy.added", payload: {} }); }); return "added"; },
  };
  const pool = engine();
  const drain = createRunDrain(w, pool, { owner: "home", profiles: { tasks: { instructions: "", tools: [add] } } });
  const ok = submitRun(w, { requestId: "r1", goal: 'tool toy_add {"name":"kite"}', profile: "tasks" }).run;
  const crash = submitRun(w, { requestId: "r2", goal: "crash", profile: "tasks" }).run;
  await drain.kick();
  const done = getRun(w, ok.id);
  assert.equal(done.run.state, "completed");
  assert.equal(done.run.outcome?.receipts.length, 1);
  assert.equal(done.events.filter((event) => event.kind === "run.step").length, 2, "steps are recorded in the home node");
  const crashed = getRun(w, crash.id).run;
  assert.equal(crashed.state, "failed");
  assert.equal(crashed.outcome?.error, "engine_crashed");

  // An external call asks the user through the core's request, and its receipt counts.
  const outside = submitRun(w, { requestId: "r3", goal: "external notes_send", profile: "tasks" }).run;
  const finished = drain.kick();
  let waiting = getRun(w, outside.id).run;
  for (let i = 0; i < 200 && waiting.state !== "waiting_permission"; i++) { await new Promise((resolve) => setTimeout(resolve, 10)); waiting = getRun(w, outside.id).run; }
  assert.equal(waiting.request?.question, "Use notes_send?");
  answerRequest(w, outside.id, { requestId: waiting.request!.id, answer: "allow" });
  await finished;
  const after = getRun(w, outside.id);
  assert.equal(after.run.outcome?.reply, "external allowed");
  const receipt = after.events.find((event) => event.kind === "external.called");
  assert.ok(receipt, "an external call that may change things is a receipt");
  assert.deepEqual(after.run.outcome?.receipts, [receipt.id]);

  // A conversation's model reaches the engine; each turn's usage is recorded.
  updateConversation(w, outside.conversationId, { model: "openai/gpt-x", thinking: "high" });
  const who = submitRun(w, { requestId: "r4", goal: "who", profile: "tasks", conversationId: outside.conversationId }).run;
  await drain.kick();
  assert.match(getRun(w, who.id).run.outcome!.reply!, /model=openai\/gpt-x/);
  const usage = getRun(w, who.id).events.find((event) => event.kind === "run.usage")!;
  assert.equal(usage.payload.model, "openai/gpt-x");
  assert.equal(usage.payload.thinking, "high");

  // Words sent while a run works join it, recorded as the user's.
  const slow = submitRun(w, { requestId: "r5", goal: "slow", profile: "tasks" }).run;
  const working = drain.kick();
  for (let i = 0; i < 100 && getRun(w, slow.id).run.state !== "running"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await drain.steer(slow.id, "also milk"), true);
  await working;
  assert.equal(getRun(w, slow.id).run.outcome?.reply, "you added: also milk");
  const steered = listEvents(w).events.find((event) => event.kind === "run.steered")!;
  assert.equal(steered.actor, "user");
  assert.equal(steered.payload.text, "also milk");
  assert.equal(await drain.steer(slow.id, "after the fact"), false, "a finished run takes no more words");
  w.close();
});
