import assert from "node:assert/strict";
import { test } from "node:test";
import { resumeStep } from "../src/push-resume.ts";

test("on every start a subscription for the node's key is handed over again, even when the node says it has one", () => {
  // The node cannot tell the browser's current subscription from one iOS replaced: it is given the current one.
  assert.equal(resumeStep("KEY", "KEY"), "resend");
});

test("a subscription that is gone, or for another key or none known, is made again", () => {
  assert.equal(resumeStep(null, "KEY"), "renew");
  assert.equal(resumeStep("OLD", "KEY"), "renew", "a node that started over");
});
