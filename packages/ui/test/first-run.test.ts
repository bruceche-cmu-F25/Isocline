import test from "node:test";
import assert from "node:assert/strict";
import { owedSteps, withoutSamples } from "../src/shell/first-run.ts";

const off = { enabled: false }, on = { enabled: true };

test("first run: someone new is asked everything, in order", () => {
  assert.deepEqual(owedSteps({ name: null, models: 0, google: { accounts: 0, ready: true }, samples: [off, on] }), ["name", "model", "google", "samples", "tour"]);
});

test("first run: what is already set is not asked again; the walk round always is", () => {
  assert.deepEqual(owedSteps({ name: "小林", models: 2, google: { accounts: 1, ready: true }, samples: [off, on] }), ["samples", "tour"]);
  assert.deepEqual(owedSteps({ name: "小林", models: 2, google: { accounts: 1, ready: true }, samples: [on, on] }), ["tour"]);
});

test("first run: a step that cannot be done here is left out", () => {
  // Another device: the connections cannot be read. No samples: nothing to time.
  assert.deepEqual(owedSteps({ name: null, models: null, google: null, samples: [] }), ["name", "tour"]);
  // No Google client yet is not left out: that step walks the user through making one.
  assert.deepEqual(owedSteps({ name: "小林", models: 0, google: { accounts: 0, ready: false }, samples: [on, on] }), ["model", "google", "tour"]);
});

test("first run: skipping the model step drops the samples question", () => {
  assert.deepEqual(withoutSamples(["model", "google", "samples", "tour"]), ["model", "google", "tour"]);
});
