import assert from "node:assert/strict";
import { test } from "node:test";
import type { Run } from "@zirma/protocol";
import { CONTINUE_MS, continues, newestRun, standing } from "../src/shell/ask.ts";

const now = Date.parse("2026-11-19T15:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

test("the bar adds to the open conversation while it is recent, and starts a new one after a while", () => {
  const quiet = { id: "c1", busy: 0, attention: 0 };
  assert.equal(continues({ ...quiet, updatedAt: ago(60_000) }, now), "c1");
  assert.equal(continues({ ...quiet, updatedAt: ago(CONTINUE_MS + 1) }, now), null, "this morning's conversation is not this afternoon's question");
  assert.equal(continues(undefined, now), null, "no conversation is open");
});

test("a conversation that still runs or waits for the user is continued however old it is", () => {
  const old = { id: "c1", updatedAt: ago(5 * CONTINUE_MS) };
  assert.equal(continues({ ...old, busy: 1, attention: 0 }, now), "c1");
  assert.equal(continues({ ...old, busy: 0, attention: 1 }, now), "c1");
});

test("the card is about the newest run of the open conversation", () => {
  const run = (id: string, conversationId: string) => ({ id, conversationId }) as Run;
  const runs = [run("r3", "c2"), run("r2", "c1"), run("r1", "c1")];
  assert.equal(newestRun(runs, "c1")?.id, "r2");
  assert.equal(newestRun(runs, "c9"), undefined);
  assert.equal(newestRun(runs, null), undefined);
});

test("a run is busy, waiting for the user, or over", () => {
  assert.equal(standing({ state: "running", request: null }), "busy");
  assert.equal(standing({ state: "queued", request: null }), "busy");
  assert.equal(standing({ state: "waiting_input", request: null }), "waiting");
  assert.equal(standing({ state: "running", request: { id: "q", kind: "input", question: "?", options: [], createdAt: "" } }), "waiting");
  assert.equal(standing({ state: "completed", request: null }), "over");
  assert.equal(standing({ state: "interrupted", request: null }), "over");
});
