import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  claimNextRun, conversationRuns, CORE_MIGRATIONS, finishRun, getRun, listRuns,
  openRequest, openWorld, submitRun,
} from "../src/index.ts";

test("a long completed reply survives restart in full, while the overview keeps a bounded preview", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "alfred-history-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "test.sqlite");
  const old = openWorld(path, CORE_MIGRATIONS.filter((migration) => migration.id !== "core:23"));
  const legacy = submitRun(old, { requestId: "prior", goal: "Already recorded", profile: "assistant" }).run;
  claimNextRun(old, "home");
  const legacyText = "a".repeat(4000);
  finishRun(old, legacy.id, "home", { status: "completed", reply: legacyText });
  old.close();

  const world = openWorld(path, CORE_MIGRATIONS);
  const long = submitRun(world, { requestId: "long", conversationId: legacy.conversationId, goal: "Review", profile: "assistant" }).run;
  claimNextRun(world, "home");
  const text = "界".repeat(4050) + "\nTests passed ✓";
  assert.equal(finishRun(world, long.id, "home", { status: "completed", reply: text }).outcome?.reply, text);
  world.close();

  const saved = openWorld(path, CORE_MIGRATIONS);
  t.after(() => saved.close());
  assert.deepEqual(listRuns(saved)[0].outcome, { status: "completed", reply: text.slice(0, 4000), replyTruncated: true, receipts: [] });
  assert.equal(getRun(saved, long.id).run.outcome?.reply, text);
  assert.deepEqual(conversationRuns(saved, legacy.conversationId).runs.map((run) => run.outcome?.reply), [legacyText, text]);
});

test("a running turn stays reachable behind queued turns and a pending request does not advance the history cursor; ties and newly arrived turns keep their order", (t) => {
  const world = openWorld(":memory:", CORE_MIGRATIONS);
  t.after(() => world.close());
  const now = Date.now();
  const add = (requestId: string, conversationId?: string) => submitRun(world, { requestId, conversationId, goal: requestId, profile: "assistant", now }).run;
  const pin = add("first");
  claimNextRun(world, "home", { now });
  const id = pin.conversationId;
  const second = add("second", id), third = add("third", id), fourth = add("fourth", id), fifth = add("fifth", id);
  const page = (before?: string) => conversationRuns(world, id, { before, limit: 2 });
  assert.deepEqual(page().runs.map((run) => run.id), [pin.id, fourth.id, fifth.id]);
  openRequest(world, pin.id, "home", { kind: "input", question: "Which?", now });
  assert.deepEqual(page().runs.map((run) => run.id), [pin.id, fourth.id, fifth.id]);
  assert.equal(page().nextCursor, fourth.id);
  const latest = add("latest", id);
  assert.deepEqual(page(fourth.id).runs.map((run) => run.id), [second.id, third.id]);
  assert.equal(page(fourth.id).nextCursor, second.id);
  assert.deepEqual(page(second.id).runs.map((run) => run.id), [pin.id]);
  assert.equal(page(second.id).nextCursor, null);
  const foreign = add("other");
  assert.deepEqual(conversationRuns(world, id, { changed: [foreign.id, latest.id, pin.id] }).runs.map((run) => run.id), [pin.id, latest.id]);
  assert.deepEqual(page(foreign.id).runs, []);
});
