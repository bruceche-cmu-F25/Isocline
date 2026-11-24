import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationDetail } from "@zirma/protocol";
import { mergeHistory } from "../src/conversationHistory.ts";

test("an arriving reply and an overlapping older page keep one chronological transcript and its older cursor", () => {
  const page = (ids: number[], cursor?: string | null, state = "completed") => ({
    conversation: { id: "same", title: state }, runs: ids.map((n) => ({ id: String(n), createdAt: "same millisecond", historyOrder: n, state })),
    activity: Object.fromEntries(ids.map((n) => [n, [{ kind: state }]])), receipts: {}, nextCursor: cursor,
  }) as unknown as ConversationDetail;
  const initial = page([1, 4, 5], "4", "waiting_input");
  const updated = page([1, 6]);
  const past = page([1, 2, 3], "1", "waiting_input");
  for (const merged of [
    mergeHistory(mergeHistory(initial, updated, false), past, true),
    mergeHistory(mergeHistory(initial, past, true), updated, false),
  ]) {
    assert.deepEqual(merged.runs.map((r) => r.id), ["1", "2", "3", "4", "5", "6"]);
    assert.equal(merged.nextCursor, "1");
    assert.equal(merged.runs[0].state, "completed");
    assert.equal(merged.activity["1"][0].kind, "completed");
    assert.equal(merged.conversation.title, "completed");
  }
});
