import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_MIGRATIONS, lastChanges, lastChangesOf, listEvents, openWorld, recordDomainEvent, runCommand, tidyWorld, withCoreContext, type World } from "../src/index.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-21T12:00:00Z");
const world = (): World => openWorld(":memory:", [...CORE_MIGRATIONS]);

function step(w: World, id: string, at: number, output?: string): void {
  w.tx(() => recordDomainEvent(w, { kind: "run.step", subject: "run:r1", runId: "r1", payload: { step: id, tool: "bash", status: "done", exit: 0, ...(output ? { output } : {}) }, now: at }));
}
const steps = (w: World) => listEvents(w).events.filter((event) => event.kind === "run.step").map((event) => event.payload);

test("upkeep drops what old commands printed and keeps the steps themselves; young ones are left whole", () => {
  const w = world();
  step(w, "old", NOW - 40 * DAY, "x".repeat(5000));
  step(w, "old-quiet", NOW - 35 * DAY);
  step(w, "young", NOW - 2 * DAY, "still here");

  assert.deepEqual(tidyWorld(w, { now: NOW }), { outputs: 1, commands: 0 });
  assert.deepEqual(steps(w), [
    { step: "old", tool: "bash", status: "done", exit: 0 },
    { step: "old-quiet", tool: "bash", status: "done", exit: 0 },
    { step: "young", tool: "bash", status: "done", exit: 0, output: "still here" },
  ]);
  assert.equal(listEvents(w).events.length, 3, "no event is removed");
  assert.deepEqual(tidyWorld(w, { now: NOW }), { outputs: 0, commands: 0 }, "a second pass has nothing to do");
});

test("upkeep goes on from where it stopped: what has come of age since is dropped, nothing is read twice", () => {
  const w = world();
  step(w, "a", NOW - 31 * DAY, "first");
  step(w, "b", NOW - 29 * DAY, "second");
  assert.equal(tidyWorld(w, { now: NOW }).outputs, 1);
  assert.equal(w.db.prepare("SELECT trimmed_seq FROM core_upkeep").get()!.trimmed_seq, 1);
  assert.equal(tidyWorld(w, { now: NOW + 2 * DAY }).outputs, 1, "two days on, the second is old enough");
  assert.deepEqual(steps(w).map((payload) => payload.output), [undefined, undefined]);
});

test("upkeep forgets a command's kept answer once no retry can come for it", () => {
  const w = world();
  runCommand(w, { requestId: "old-1", command: "toy.add", input: {}, now: NOW - 31 * DAY }, () => "done");
  runCommand(w, { requestId: "new-1", command: "toy.add", input: {}, now: NOW - DAY }, () => "done");
  assert.equal(tidyWorld(w, { now: NOW }).commands, 1);
  assert.equal(runCommand(w, { requestId: "new-1", command: "toy.add", input: {}, now: NOW }, () => "again").replayed, true, "a recent one still answers its retry");
});

test("who last changed a thing is read by the thing: the same answer as reading the whole log by its prefix", () => {
  const w = world();
  const change = (subject: string, kind: string, actor: "user" | "alfred") =>
    withCoreContext({ actor }, () => w.tx(() => recordDomainEvent(w, { kind, subject, payload: {} })));
  change("todo:a", "todo.added", "user");
  change("todo:b", "todo.added", "user");
  change("todo:a", "todo.updated", "alfred");
  change("link:a", "link.saved", "alfred");

  const all = lastChanges(w, "todo:");
  const some = lastChangesOf(w, ["todo:a", "todo:b", "todo:gone"]);
  assert.deepEqual([...some].sort(), [...all].sort());
  assert.equal(some.get("todo:a")?.actor, "alfred");
  assert.equal(some.get("todo:a")?.kind, "todo.updated");
  assert.equal(some.has("todo:gone"), false);
  assert.equal(lastChangesOf(w, []).size, 0);
});

test("a world hands back the statement it prepared before for the same SQL", () => {
  const w = world();
  assert.equal(w.db.prepare("SELECT 1 AS one"), w.db.prepare("SELECT 1 AS one"));
  assert.notEqual(w.db.prepare("SELECT 1 AS one"), w.db.prepare("SELECT 2 AS two"));
  // Used again and again, with different values each time.
  for (const n of [1, 2, 3]) assert.equal(w.db.prepare("SELECT ? AS n").get(n)!.n, n);
});
