import test from "node:test";
import assert from "node:assert/strict";
import { owedSteps, withoutMorning } from "../src/shell/first-run.ts";

const off = { enabled: false }, on = { enabled: true };

test("first run: someone new is asked everything, in order", () => {
  assert.deepEqual(owedSteps({ name: null, models: 0, google: { accounts: 0, ready: true }, brief: off }), ["name", "model", "google", "morning", "tour"]);
});

test("first run: what is already set is not asked again; the walk round always is", () => {
  assert.deepEqual(owedSteps({ name: "小林", models: 2, google: { accounts: 1, ready: true }, brief: off }), ["morning", "tour"]);
  assert.deepEqual(owedSteps({ name: "小林", models: 2, google: { accounts: 1, ready: true }, brief: on }), ["tour"]);
});

test("first run: a step that cannot be done here is left out", () => {
  // Another device: the connections cannot be read. No Google client: nothing to sign in with. No brief: nothing to time.
  assert.deepEqual(owedSteps({ name: null, models: null, google: null, brief: undefined }), ["name", "tour"]);
  assert.deepEqual(owedSteps({ name: "小林", models: 0, google: { accounts: 0, ready: false }, brief: on }), ["model", "tour"]);
});

test("first run: skipping the model step drops the morning question", () => {
  assert.deepEqual(withoutMorning(["model", "google", "morning", "tour"]), ["model", "google", "tour"]);
});
