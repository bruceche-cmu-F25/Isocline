import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acknowledgeNotice, answerRequest, claimNextRun, claimNotice, CommandConflictError, conversationRuns, CORE_MIGRATIONS, createNotice, createRunDrain, executeNextRun, finishRun, getRun,
  interruptOrphanedRuns, listEvents, listNotices, listRuns, NoticeStateError, onEvents, openRequest, openWorld, presentNotice, recordDomainEvent,
  isRunUnfinished, requestCancel, resumeRun, runCommand, RunError, RunLeaseLostError, submitRun, withCoreContext,
  undeliveredNotices, type EnginePort, type RunProfile, type World,
} from "../src/index.ts";

const TOY = { id: "toy:1", sql: "CREATE TABLE toys (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL) STRICT;" };

function world(): World {
  return openWorld(":memory:", [...CORE_MIGRATIONS, TOY]);
}

function addToy(w: World, name: string): void {
  w.tx((db) => {
    db.prepare("INSERT INTO toys (id, name) VALUES (?, ?)").run(name, name);
    recordDomainEvent(w, { kind: "toy.added", subject: `toy:${name}`, payload: { name } });
  });
}

function profiles(w: World): Record<string, RunProfile> {
  return {
    tasks: {
      instructions: "test",
      tools: [{
        name: "toy_add", label: "Add toy", description: "", parameters: { type: "object" },
        execute: (params) => { addToy(w, String(params.name)); return "ok"; },
      }],
    },
  };
}

const toys = (w: World) => w.db.prepare("SELECT name FROM toys ORDER BY name").all().map((row) => row.name);

test("a request id replays its run and refuses different content", () => {
  const w = world();
  const first = submitRun(w, { requestId: "r1", goal: "add a toy", profile: "tasks" });
  assert.equal(first.replayed, false);
  assert.equal(first.run.state, "queued");
  const again = submitRun(w, { requestId: "r1", goal: "add a toy", profile: "tasks" });
  assert.equal(again.replayed, true);
  assert.equal(again.run.id, first.run.id);
  assert.throws(() => submitRun(w, { requestId: "r1", goal: "something else", profile: "tasks" }), RunError);
});

test("a run's receipts remain in the conversation without a separate result notice", async () => {
  const w = world();
  const engine: EnginePort = {
    async submit(request) {
      await request.tools[0].execute({ name: "kite" }, new AbortController().signal);
      return { reply: "Added a kite." };
    },
  };
  const { run } = submitRun(w, { requestId: "r1", goal: "add a kite", profile: "tasks" });
  await createRunDrain(w, engine, { owner: "node-a", profiles: profiles(w) }).kick();
  const { run: done, events } = getRun(w, run.id);
  assert.equal(done.state, "completed");
  const receipt = events.find((event) => event.kind === "toy.added");
  assert.ok(receipt);
  assert.equal(receipt.actor, "alfred");
  assert.deepEqual(done.outcome?.receipts, [receipt.id]);
  assert.deepEqual(toys(w), ["kite"]);
  assert.deepEqual(listNotices(w), []);
  assert.equal(done.outcome?.reply, "Added a kite.");
});

test("a reply that claims work without a tool call has no receipts", async () => {
  const w = world();
  const engine: EnginePort = { submit: async () => ({ reply: "Done, I added it!" }) };
  const { run } = submitRun(w, { requestId: "r1", goal: "add a kite", profile: "tasks" });
  await executeNextRun(w, engine, { owner: "node-a", profiles: profiles(w) });
  assert.deepEqual(getRun(w, run.id).run.outcome?.receipts, []);
});

test("a write under a lapsed lease is refused and rolled back", async () => {
  const w = world();
  let now = Date.now();
  const engine: EnginePort = {
    async submit(request) {
      // The lease runs out while the model is thinking.
      w.db.prepare("UPDATE core_runs SET lease_until = ?").run(new Date(now - 1).toISOString());
      return { reply: String(await request.tools[0].execute({ name: "late" }, new AbortController().signal)) };
    },
  };
  submitRun(w, { requestId: "r1", goal: "add a toy", profile: "tasks" });
  const run = await executeNextRun(w, engine, { owner: "node-a", profiles: profiles(w) });
  assert.deepEqual(toys(w), []);
  assert.equal(run?.state, "interrupted");
  assert.throws(() => withCoreContext({ actor: "alfred", run: { id: run!.id, owner: "node-a" } }, () => addToy(w, "x")), RunLeaseLostError);
});

test("a restart interrupts the dead executor's run; it is never re-run until resumed", async () => {
  const w = world();
  let calls = 0;
  const hang: EnginePort = { submit: () => { calls++; return new Promise(() => {}); } };
  const { run } = submitRun(w, { requestId: "r1", goal: "add a toy", profile: "tasks" });
  void executeNextRun(w, hang, { owner: "node-old", profiles: profiles(w), heartbeatMs: 1e9 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getRun(w, run.id).run.state, "running");

  // The home node restarts under a new owner.
  assert.equal(interruptOrphanedRuns(w, "node-new"), 1);
  assert.equal(getRun(w, run.id).run.state, "interrupted");
  assert.ok(listNotices(w).some((notice) => notice.kind === "run_interrupted"));
  const ok: EnginePort = { submit: async () => { calls++; return { reply: "ok" }; } };
  await createRunDrain(w, ok, { owner: "node-new", profiles: profiles(w) }).kick();
  assert.equal(calls, 1, "the drain must not pick an interrupted run up again");

  resumeRun(w, run.id);
  assert.equal(listNotices(w).some((item) => item.kind === "run_interrupted"), false, "resuming from any surface removes the old interruption");
  await createRunDrain(w, ok, { owner: "node-new", profiles: profiles(w) }).kick();
  const resumed = getRun(w, run.id).run;
  assert.equal(resumed.state, "completed");
  assert.equal(resumed.attempt, 2);
});

test("a committed stop immediately signals only its run and waits for the engine's result", async () => {
  const w = world();
  const { run } = submitRun(w, { requestId: "r1", goal: "add a toy", profile: "tasks" });
  const other = submitRun(w, { requestId: "r2", goal: "another", profile: "tasks" }).run;
  const signals = new Map<string, AbortSignal>();
  const engine: EnginePort = {
    submit: (request, signal) => new Promise((_resolve, reject) => {
      signals.set(request.thread, signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  };
  const options = { owner: "node-a", profiles: profiles(w), heartbeatMs: 1e9 };
  const pending = executeNextRun(w, engine, options);
  const otherPending = executeNextRun(w, engine, options);
  assert.throws(() => w.tx(() => {
    requestCancel(w, run.id);
    throw new Error("rollback");
  }), /rollback/);
  assert.equal(signals.get(run.conversationId)?.aborted, false);
  assert.equal(requestCancel(w, run.id).state, "cancelling");
  assert.equal(signals.get(run.conversationId)?.aborted, true);
  assert.equal(signals.get(other.conversationId)?.aborted, false);
  assert.equal((await pending)?.state, "cancelled");
  requestCancel(w, other.id);
  assert.equal((await otherPending)?.state, "cancelled");

  const queued = submitRun(w, { requestId: "r3", goal: "later", profile: "tasks" }).run;
  assert.equal(requestCancel(w, queued.id).state, "cancelled");
});

test("an unknown profile fails without calling the engine", async () => {
  const w = world();
  let called = false;
  submitRun(w, { requestId: "r1", goal: "x", profile: "nope" });
  const run = await executeNextRun(w, { submit: async () => { called = true; return { reply: "" }; } }, { owner: "a", profiles: profiles(w) });
  assert.equal(run?.state, "failed");
  assert.equal(run?.outcome?.error, "unknown_profile");
  assert.equal(called, false);
});

test("only the claiming device presents a notice, and never twice", async () => {
  const w = world();
  submitRun(w, { requestId: "r1", goal: "Notify me when done.", profile: "tasks" });
  await executeNextRun(w, { submit: async () => ({ reply: "done" }) }, { owner: "a", profiles: profiles(w) });
  const [notice] = listNotices(w);
  claimNotice(w, notice.id, "mac");
  assert.throws(() => claimNotice(w, notice.id, "phone"), NoticeStateError);
  assert.throws(() => presentNotice(w, notice.id, "phone"), NoticeStateError);
  assert.equal(presentNotice(w, notice.id, "mac").state, "presented");
  assert.throws(() => claimNotice(w, notice.id, "phone"), NoticeStateError);
  assert.equal(acknowledgeNotice(w, notice.id).state, "acknowledged");
  assert.deepEqual(listNotices(w), []);
});

test("dismissing a notice is an event, so every device hears of it and drops it; once", () => {
  const w = world();
  const notice = w.tx((db) => {
    const event = recordDomainEvent(w, { kind: "toy.added", payload: {} });
    return createNotice(db, { eventSeq: event.seq, kind: "welcome", payload: {} });
  });
  claimNotice(w, notice.id, "mac");
  presentNotice(w, notice.id, "mac");
  const before = listEvents(w).cursor;
  assert.equal(acknowledgeNotice(w, notice.id).state, "acknowledged");
  acknowledgeNotice(w, notice.id);
  assert.deepEqual(listEvents(w, { after: before }).events.map((event) => [event.kind, event.subject, event.actor, event.payload.kind]),
    [["notice.acknowledged", `notice:${notice.id}`, "user", "welcome"]]);
  assert.equal(listNotices(w, { states: ["pending", "claimed", "presented"] }).length, 0);
});

test("notices nobody dismissed do not keep a new one from being listed", () => {
  const w = world();
  const tell = (now: number) => w.tx((db) => {
    const event = recordDomainEvent(w, { kind: "toy.added", payload: {}, now });
    return createNotice(db, { eventSeq: event.seq, kind: "run_result", payload: {}, now });
  });
  const start = Date.now() - 60_000;
  const old = Array.from({ length: 60 }, (_, i) => tell(start + i));
  // Shown once, never clicked: they stay in the inbox.
  for (const notice of old) { claimNotice(w, notice.id, "mac"); presentNotice(w, notice.id, "mac"); }
  const fresh = tell(Date.now());
  const listed = listNotices(w, { states: ["pending", "claimed", "presented"] });
  assert.equal(listed.length, 50);
  assert.equal(listed.at(-1)!.id, fresh.id, "the newest is there, last");
  assert.equal(listed[0].id, old[11].id, "the oldest are the ones left out");
});

test("active runs stay visible outside recent history until they finish", () => {
  const w = world();
  const now = Date.now();
  const submit = (id: string, conversationId?: string) =>
    submitRun(w, { requestId: id, conversationId, goal: id, profile: "tasks", now }).run;
  const waiting = submit("wait");
  claimNextRun(w, "home", { now });
  const question = openRequest(w, waiting.id, "home", { kind: "input", question: "Which day?", now });
  const hidden = submit("private");
  claimNextRun(w, "home", { now });
  openRequest(w, hidden.id, "home", { kind: "permission", question: "Apply edit?", now });
  const recent = Array.from({ length: 51 }, (_, i) => submit(`new-${i}`, waiting.conversationId));
  submit("hidden-new", hidden.conversationId);
  const options = { limit: 50, includeWaiting: true, hiddenConversations: [hidden.conversationId] };
  const visible = recent.slice(-50).reverse().map((run) => run.id);
  assert.deepEqual(listRuns(w, options).map((run) => run.id), [...visible, waiting.id]);
  assert.deepEqual(listRuns(w, { ...options, conversationId: waiting.conversationId }).map((run) => run.id), [...visible, waiting.id]);
  answerRequest(w, waiting.id, { requestId: question.id, answer: "Monday", now });
  assert.equal(listRuns(w, options).at(-1)?.state, "running");
  requestCancel(w, waiting.id, { now });
  assert.equal(listRuns(w, options).at(-1)?.state, "cancelling");
  const page = conversationRuns(w, waiting.conversationId, { limit: 2 });
  assert.deepEqual(page.runs.map((run) => run.id), [waiting.id, recent[49].id, recent[50].id]);
  finishRun(w, waiting.id, "home", { status: "cancelled" }, { now });
  assert.deepEqual(listRuns(w, options).map((run) => run.id), visible);
  w.close();
});

test("old unresolved receipts and interruptions survive newer results within a device's scope", () => {
  const w = world();
  const now = Date.now();
  const tell = (kind: string, payload: Record<string, unknown>) => w.tx((db) => {
    const event = recordDomainEvent(w, { kind: "toy.added", payload: {}, now });
    return createNotice(db, { eventSeq: event.seq, kind, payload, now }).id;
  });
  const pending = ["failed", "unknown"].map((state) => tell("outbound", { state }));
  pending.push(tell("run_interrupted", { conversationId: "public" }));
  tell("outbound", { state: "done" });
  tell("run_interrupted", { conversationId: "private" });
  const news = Array.from({ length: 51 }, () => tell("run_result", { conversationId: "public" }));
  tell("run_result", { conversationId: "private" });
  const visible = () => listNotices(w, { includeNeedsYou: true, hiddenConversations: ["private"] }).map((notice) => notice.id);
  assert.deepEqual(visible(), [...pending, ...news.slice(-50)]);
  acknowledgeNotice(w, pending[0]);
  assert.deepEqual(visible(), [...pending.slice(1), ...news.slice(-50)]);
  w.close();
});

test("a command runs once per request id and rolls back with its change", () => {
  const w = world();
  const add = (name: string, requestId: string) => runCommand(w, { requestId, command: "toy.add", input: { name } }, () => { addToy(w, name); return { name }; });
  assert.deepEqual(add("kite", "c1"), { result: { name: "kite" }, replayed: false });
  assert.deepEqual(add("kite", "c1"), { result: { name: "kite" }, replayed: true });
  assert.deepEqual(toys(w), ["kite"]);
  assert.throws(() => add("ball", "c1"), CommandConflictError);
  assert.throws(() => runCommand(w, { requestId: "c2", command: "toy.add", input: {} }, () => { addToy(w, "boom"); throw new Error("no"); }));
  assert.deepEqual(toys(w), ["kite"]);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM core_commands").get()!.n, 1);
});

test("transactions are synchronous, nest as savepoints and signal commits", () => {
  const w = world();
  let commits = 0;
  w.onCommit(() => commits++);
  w.tx(() => {
    addToy(w, "a");
    assert.throws(() => w.tx(() => { addToy(w, "b"); throw new Error("inner"); }));
  });
  assert.deepEqual(toys(w), ["a"]);
  assert.equal(commits, 1);
  assert.throws(() => w.tx(async () => {}), /synchronous/);
  assert.throws(() => recordDomainEvent(w, { kind: "toy.added", payload: {} }), /inside the domain's own transaction/);
  assert.equal(listEvents(w).events.length, 1);
});

test("a listener hears the kinds of events each commit recorded, each once, and nothing from before it listened", () => {
  const w = world();
  addToy(w, "before");
  const heard: string[][] = [];
  const off = onEvents(w, (kinds) => heard.push([...kinds].sort()));
  // A commit that recorded nothing is not news.
  w.tx((db) => db.prepare("UPDATE toys SET name = name").run());
  w.tx(() => {
    addToy(w, "a");
    addToy(w, "b");
    recordDomainEvent(w, { kind: "toy.counted", payload: {} });
  });
  addToy(w, "c");
  // What was rolled back never happened.
  assert.throws(() => w.tx(() => { addToy(w, "d"); throw new Error("no"); }));
  assert.deepEqual(heard, [["toy.added", "toy.counted"], ["toy.added"]]);
  off();
  addToy(w, "e");
  assert.equal(heard.length, 2);
});

test("upgrading closes legacy interruption notices for completed runs and superseded attempts", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "alfred-interruption-upgrade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "world.sqlite");
  const prior = openWorld(path, CORE_MIGRATIONS.filter((migration) => Number(migration.id.split(":")[1]) < 19));
  const stop = (id: string) => {
    assert.equal(claimNextRun(prior, "old-home")!.id, id);
    interruptOrphanedRuns(prior, "new-home");
    return listNotices(prior).find((notice) => notice.kind === "run_interrupted" && notice.payload.runId === id)!;
  };
  const complete = submitRun(prior, { requestId: "finish", goal: "Notify me when finished.", profile: "tasks" }).run;
  const finishedNotice = stop(complete.id);
  resumeRun(prior, complete.id);
  claimNextRun(prior, "new-home");
  finishRun(prior, complete.id, "new-home", { status: "completed" });

  const stopped = submitRun(prior, { requestId: "again", goal: "stopped twice", profile: "tasks" }).run;
  const first = stop(stopped.id);
  resumeRun(prior, stopped.id);
  const current = stop(stopped.id);
  // Restore exactly what older versions left behind when a different surface handled the interruption.
  prior.db.prepare("UPDATE core_notices SET state = 'presented', claimed_by = 'phone' WHERE id = ?").run(finishedNotice.id);
  prior.db.prepare("UPDATE core_notices SET state = 'claimed', claimed_by = 'mac', claim_until = ? WHERE id = ?")
    .run(new Date(Date.now() + 60_000).toISOString(), first.id);
  prior.close();

  const w = openWorld(path, CORE_MIGRATIONS);
  t.after(() => w.close());
  const open = listNotices(w, { states: ["pending", "claimed", "presented"], includeNeedsYou: true });
  assert.deepEqual(open.filter((n) => n.kind === "run_interrupted").map((n) => n.id), [current.id]);
  assert.deepEqual(undeliveredNotices(w).filter((n) => n.kind === "run_interrupted").map((n) => n.id), [current.id]);
  assert.ok(open.some((n) => n.kind === "run_result" && n.payload.runId === complete.id));
  assert.deepEqual(listNotices(w, { states: ["acknowledged"] }).filter((n) => n.kind === "run_interrupted")
    .map((n) => [n.id, n.claimedBy, n.claimUntil]), [[finishedNotice.id, null, null], [first.id, null, null]]);
});

test("a run is unfinished while queued or cancelling, finished once cancelled, and an unknown id is not a run", () => {
  const w = world();
  const { run } = submitRun(w, { requestId: "u1", goal: "add a toy", profile: "tasks" });
  assert.equal(isRunUnfinished(w, run.id), true);
  assert.equal(requestCancel(w, run.id).state, "cancelled");
  assert.equal(isRunUnfinished(w, run.id), false);
  assert.equal(isRunUnfinished(w, "nope"), false);
});
