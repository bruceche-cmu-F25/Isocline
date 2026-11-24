import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiveUpdate, StateResponse } from "@isocline/protocol";
import { createLiveReplies } from "../src/live.ts";
import { shared } from "../src/share.ts";
import { heldRevisions, mergeState } from "../src/stateMerge.ts";

test("what says the same keeps the object it was; what changed is new, and only that", () => {
  const before = { runs: [{ id: "a", state: "running" }, { id: "b", state: "completed" }], settings: { locale: "zh" } };
  const same = shared(before, structuredClone(before));
  assert.equal(same, before);

  const next = shared(before, { runs: [{ id: "c", state: "queued" }, { id: "a", state: "running" }, { id: "b", state: "completed" }], settings: { locale: "zh" } });
  assert.notEqual(next, before);
  assert.equal(next.settings, before.settings);
  assert.equal(next.runs[1], before.runs[0], "a new item at the top does not make the ones after it new");
  assert.equal(next.runs[2], before.runs[1]);

  const changed = shared(before, { runs: [{ id: "a", state: "completed" }, { id: "b", state: "completed" }], settings: { locale: "zh" } });
  assert.notEqual(changed.runs[0], before.runs[0]);
  assert.equal(changed.runs[1], before.runs[1]);
  assert.deepEqual(shared({ a: 1, b: 2 }, { a: 1 }), { a: 1 }, "a field that went away is gone");
  assert.deepEqual(shared([1, 2], { 0: 1 }), { 0: 1 });
});

const state = (extra: Partial<StateResponse>): StateResponse => ({
  protocol: 1, cursor: 1, conversations: [], runs: [], receipts: {}, notices: [], modules: {}, views: {}, areas: [], proposals: [],
  settings: {} as StateResponse["settings"], automations: [], projects: [], ...extra,
});

test("a state read again keeps the snapshots the home node left out, and is the same state when nothing changed", () => {
  const first = state({ cursor: 5, modules: { todo: { todos: [{ id: "t1" }] }, mail: { messages: [{ id: "m1" }] } }, revisions: { todo: "r1", mail: "r1" } });
  assert.deepEqual(heldRevisions(first), { todo: "r1", mail: "r1" });

  // Only an event was recorded: every snapshot is the one already held, and nothing else differs.
  assert.equal(mergeState(first, state({ cursor: 6, modules: {}, revisions: { todo: "r1", mail: "r1" } })), first);

  // The todo list changed; mail did not and was not sent again.
  const next = mergeState(first, state({ cursor: 7, modules: { todo: { todos: [{ id: "t1" }, { id: "t2" }] } }, revisions: { todo: "r2", mail: "r1" } }));
  assert.equal(next.modules.mail, first.modules.mail);
  assert.deepEqual(next.modules.todo, { todos: [{ id: "t1" }, { id: "t2" }] });
  assert.deepEqual(heldRevisions(next), { todo: "r2", mail: "r1" });

  // A module that is no longer there goes; a home node that sends no revisions is taken whole.
  assert.deepEqual(Object.keys(mergeState(next, state({ modules: { todo: {} }, revisions: { todo: "r3" } })).modules), ["todo"]);
  assert.equal(heldRevisions(state({ modules: { todo: {} } })), undefined);
});

test("a reply being written: the whole once, then what was written since; what does not go on from here is not taken", () => {
  const live = createLiveReplies(0);
  const heard: string[] = [];
  let writers = 0;
  live.onText("r1", () => heard.push(live.text("r1") ?? "(none)"));
  live.onWriting(() => writers++);
  const update = (extra: Partial<LiveUpdate>): LiveUpdate => ({ runId: "r1", conversationId: "c1", ...extra });

  live.apply(update({ text: "Let me" }));
  const writing = live.writing();
  assert.deepEqual([...writing], ["r1"]);
  live.apply(update({ at: 6, add: " check" }));
  assert.equal(live.writing(), writing, "more words are not a new set of who is writing");
  live.apply(update({ at: 3, add: "??" }));
  assert.equal(live.text("r1"), "Let me check", "an addition for another place in the text is left out");
  live.apply(update({ text: "Rewritten" }));
  assert.deepEqual(heard, ["Let me", "Let me check", "Rewritten"]);

  live.end("r1");
  assert.equal(live.text("r1"), undefined);
  assert.equal(live.text("r1", true), "Rewritten", "its last words stay for whoever still shows it working");
  assert.equal(live.writing().size, 0);
  assert.equal(writers, 2, "told when a run begins and when it ends, not for each word");
  live.apply({ runId: "r2", conversationId: "c1", at: 4, add: "late" });
  assert.equal(live.text("r2"), undefined, "an addition to a reply this window never had the start of");
});
