import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptProposal, claimOutbound, CORE_MIGRATIONS, enqueueOutbound, finishOutbound, interruptOutbound, listNotices, listOutbound,
  OUTBOUND_MAX_ATTEMPTS, openProposal, openWorld, retryOutbound, type World,
} from "../src/index.ts";

const world = (): World => openWorld(":memory:", CORE_MIGRATIONS);
const outboundNotices = (w: World) => listNotices(w).filter((notice) => notice.kind === "outbound").map((notice) => notice.payload);

test("a change accepted in a proposal is recorded with it, then claimed, delivered, and told", () => {
  const w = world();
  const proposal = openProposal(w, { title: "Hold time?", summary: "", steps: [{ op: "calendar.add", input: {}, preview: "Add “Focus” to Me" }] });
  acceptProposal(w, proposal.id, () => { enqueueOutbound(w, { module: "calendar", action: "add", payload: { title: "Focus" }, preview: "Add “Focus” to Me", idempotent: true }); });
  const [queued] = listOutbound(w);
  assert.deepEqual([queued.state, queued.proposalId, queued.attempts], ["queued", proposal.id, 0]);

  assert.equal(claimOutbound(w, "mail"), null, "each module claims its own");
  const claimed = claimOutbound(w, "calendar")!;
  assert.deepEqual([claimed.state, claimed.attempts], ["sending", 1]);
  assert.equal(claimOutbound(w, "calendar"), null, "one delivery at a time");
  finishOutbound(w, claimed.id, { state: "done", result: { id: "evt1" } });
  assert.deepEqual(outboundNotices(w), [{ outboundId: claimed.id, module: "calendar", action: "add", state: "done", preview: "Add “Focus” to Me", proposalId: proposal.id }]);
  assert.throws(() => finishOutbound(w, claimed.id, { state: "done" }), /done, not being sent/);
});

test("what one proposal changed is told together once the last has ended; a failure on its own", () => {
  const w = world();
  const previews = ["Add “Lab” to Me", "Add “Review” to Me", "Add “Final” to Me"];
  const proposal = openProposal(w, { title: "Plan the week?", summary: "", steps: previews.map((preview) => ({ op: "calendar.add", input: {}, preview })) });
  acceptProposal(w, proposal.id, (step) => { enqueueOutbound(w, { module: "calendar", action: "add", payload: { account: "me@example.com" }, preview: step.preview, idempotent: true }); });
  const deliver = (state: "done" | "failed") => {
    const claimed = claimOutbound(w, "calendar")!;
    finishOutbound(w, claimed.id, state === "done" ? { state } : { state, error: "Forbidden" });
  };
  deliver("done");
  deliver("failed");
  assert.deepEqual(outboundNotices(w).map((payload) => [payload.state, payload.preview]), [["failed", previews[1]]], "nothing done is told while others wait");
  deliver("done");
  const done = outboundNotices(w).filter((payload) => payload.state === "done");
  assert.equal(done.length, 1);
  assert.deepEqual([done[0].count, done[0].previews, done[0].title, done[0].account, done[0].module], [2, [previews[0], previews[2]], "Plan the week?", "me@example.com", "calendar"]);
});

test("a declined or failed proposal leaves nothing to deliver", () => {
  const w = world();
  const proposal = openProposal(w, { title: "Send?", summary: "", steps: [{ op: "mail.send", input: {}, preview: "Email Leo" }] });
  acceptProposal(w, proposal.id, () => {
    enqueueOutbound(w, { module: "mail", action: "send", payload: {}, preview: "Email Leo", idempotent: false });
    throw new Error("a later step failed");
  });
  assert.deepEqual(listOutbound(w), [], "it rolled back with the decision");
});

test("retries: an idempotent change waits for the next pass until it gives up; one that is not becomes unknown", () => {
  const w = world();
  const event = enqueueOutbound(w, { module: "calendar", action: "add", payload: {}, preview: "Add", idempotent: true });
  const email = enqueueOutbound(w, { module: "mail", action: "send", payload: {}, preview: "Email Leo", idempotent: false });
  const tried = new Set<string>();
  for (let attempt = 1; attempt < OUTBOUND_MAX_ATTEMPTS; attempt++) {
    const claimed = claimOutbound(w, "calendar", tried)!;
    tried.add(claimed.id);
    assert.equal(retryOutbound(w, claimed.id, "Google could not be reached").state, "queued");
    assert.equal(claimOutbound(w, "calendar", tried), null, "not again in the same pass");
    tried.clear();
  }
  retryOutbound(w, claimOutbound(w, "calendar")!.id, "Google could not be reached");
  assert.equal(listOutbound(w, { module: "calendar" })[0].state, "failed");
  assert.equal(listOutbound(w, { module: "calendar" })[0].id, event.id);

  claimOutbound(w, "mail");
  assert.equal(retryOutbound(w, email.id, "connection reset").state, "unknown", "an email is never sent twice");
  assert.deepEqual(outboundNotices(w).map((payload) => payload.state), ["failed", "unknown"]);
});

test("a home node that stopped mid-delivery: idempotent changes go back in the queue, the rest are unknown and told", () => {
  const w = world();
  enqueueOutbound(w, { module: "calendar", action: "move", payload: {}, preview: "Move standup", idempotent: true });
  enqueueOutbound(w, { module: "mail", action: "send", payload: {}, preview: "Email Leo", idempotent: false });
  claimOutbound(w, "calendar");
  claimOutbound(w, "mail");
  assert.equal(interruptOutbound(w), 2);
  assert.deepEqual(listOutbound(w).map((outbound) => [outbound.module, outbound.state]), [["calendar", "queued"], ["mail", "unknown"]]);
  assert.deepEqual(outboundNotices(w), [{ outboundId: listOutbound(w)[1].id, module: "mail", action: "send", state: "unknown", preview: "Email Leo", error: "Isocline stopped while sending this" }]);
  assert.equal(interruptOutbound(w), 0);
});

test("a change the user made with their own hands is told only when it did not go through", () => {
  const w = world();
  const typed = enqueueOutbound(w, { module: "calendar", action: "add", payload: {}, preview: "Add “Lunch”", idempotent: true, quiet: true });
  assert.equal(typed.quiet, true);
  finishOutbound(w, claimOutbound(w, "calendar")!.id, { state: "done" });
  assert.deepEqual(outboundNotices(w), [], "it went through: they watched it happen");

  enqueueOutbound(w, { module: "calendar", action: "edit", payload: {}, preview: "Change “Lunch”", idempotent: true, quiet: true });
  finishOutbound(w, claimOutbound(w, "calendar")!.id, { state: "failed", error: "Google refused (403)" });
  assert.deepEqual(outboundNotices(w).map((payload) => [payload.state, payload.preview]), [["failed", "Change “Lunch”"]]);
});
