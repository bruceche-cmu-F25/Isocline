import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { placeFor, readRecord, recordEnd, type TurnRecord } from "../src/turns.ts";

const record: TurnRecord = { file: "/s/a.jsonl", ends: { r1: "e1", r2: "e2" } };
const place = (over: Partial<Parameters<typeof placeFor>[0]>) => placeFor({ after: "r2", branched: false, empty: false, leaf: "e2", record, ...over });

test("where the session goes before a turn", () => {
  assert.deepEqual(place({}), { kind: "stay" }, "going on from where it is");
  assert.deepEqual(place({ after: "r1", branched: true }), { kind: "go", to: "e1" }, "another version: back to the end of the turn before");
  assert.deepEqual(place({ leaf: "e9" }), { kind: "go", to: "e2" }, "the session moved on since: back to that turn's end");
  assert.deepEqual(place({ after: null }), { kind: "fresh" }, "the first turn again: a new session");
  assert.deepEqual(place({ after: "old", branched: true }), { kind: "fresh" }, "a turn it never recorded, and it must move: a new session");
  assert.deepEqual(place({ after: "old" }), { kind: "stay" }, "a turn from before the record, simply going on");
  assert.deepEqual(place({ record: null, after: "old" }), { kind: "stay" }, "an old session without a record, simply going on");
  assert.deepEqual(place({ empty: true, after: "r1", branched: true }), { kind: "stay" }, "an empty session has nothing to move");
  assert.deepEqual(place({ after: undefined, branched: true }), { kind: "stay" }, "an older home node says nothing: as before");
});

test("the record belongs to one session file and is written whole", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zirma-turns-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "thread.turns.json");
  assert.equal(readRecord(path, "/s/a.jsonl"), null);
  recordEnd(path, "/s/a.jsonl", "r1", "e1");
  recordEnd(path, "/s/a.jsonl", "r2", "e2");
  assert.deepEqual(readRecord(path, "/s/a.jsonl"), { file: "/s/a.jsonl", ends: { r1: "e1", r2: "e2" } });
  assert.equal(readRecord(path, "/s/b.jsonl"), null, "another session file: no record");
  recordEnd(path, "/s/b.jsonl", "r3", "e3");
  assert.deepEqual(readRecord(path, "/s/b.jsonl"), { file: "/s/b.jsonl", ends: { r3: "e3" } }, "a new session file starts a new record");
  assert.equal(readRecord(path, undefined), null);
});
