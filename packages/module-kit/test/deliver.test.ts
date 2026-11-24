import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_MIGRATIONS, enqueueOutbound, listNotices, listOutbound, openWorld, OUTBOUND_MAX_ATTEMPTS, withCoreContext, type Outbound, type World } from "@zirma/core";
import { defineModule, deliverQueued, ServiceError, type ZirmaModule, type Delivered, type GoogleService } from "../src/index.ts";

const world = (): World => openWorld(":memory:", CORE_MIGRATIONS);
/** A module whose deliveries go as `answer` says. */
const post = (answer: (outbound: Outbound) => Delivered | Promise<Delivered>): ZirmaModule =>
  defineModule({ id: "post", title: "Post", migrations: [], ops: [], tools: [], deliver: async (_world, outbound) => answer(outbound) });
const queue = (w: World, preview: string, idempotent: boolean) => withCoreContext({ actor: "user" }, () =>
  enqueueOutbound(w, { module: "post", action: "send", payload: { account: "me@example.com" }, preview, idempotent }));
const states = (w: World) => listOutbound(w).map((outbound) => [outbound.preview, outbound.state, outbound.error]);

test("each waiting change is handed to the module once, oldest first, and ended as the module says", async () => {
  const w = world();
  queue(w, "first", true);
  queue(w, "second", true);
  queue(w, "for another module", true);
  w.db.prepare("UPDATE core_outbound SET module = 'other' WHERE preview = 'for another module'").run();
  const seen: string[] = [];
  const handled = await deliverQueued(w, post((outbound) => { seen.push(outbound.preview); return outbound.preview === "first" ? { state: "done", result: { id: 7 } } : { state: "failed", error: "refused" }; }), {});
  assert.equal(handled, 2);
  assert.deepEqual(seen, ["first", "second"]);
  assert.deepEqual(states(w), [["first", "done", null], ["second", "failed", "refused"], ["for another module", "queued", null]]);
  assert.deepEqual(listOutbound(w)[0].result, { id: 7 });
  assert.deepEqual(listNotices(w).map((notice) => [notice.kind, notice.payload.state]), [["outbound", "done"], ["outbound", "failed"]], "every ending is told");
  assert.equal(await deliverQueued(w, defineModule({ id: "post", title: "Post", migrations: [], ops: [], tools: [] }), {}), 0, "a module that delivers nothing");
});

test("no clear answer: a change that is safe to send again waits for the next pass; one that is not becomes unknown", async () => {
  const w = world();
  queue(w, "an event", true);
  queue(w, "an email", false);
  let calls = 0;
  const unclear = post(() => { calls++; return { state: "unclear", error: "Google answered 503" }; });
  await deliverQueued(w, unclear, {});
  assert.equal(calls, 2, "not tried twice in one pass");
  assert.deepEqual(states(w), [["an event", "queued", "Google answered 503"], ["an email", "unknown", "Google answered 503"]]);
  // The event keeps waiting, pass after pass, until it is given up; the email is never sent again.
  for (let pass = 1; pass < OUTBOUND_MAX_ATTEMPTS; pass++) await deliverQueued(w, unclear, {});
  assert.equal(calls, 1 + OUTBOUND_MAX_ATTEMPTS);
  assert.deepEqual(states(w)[0].slice(0, 2), ["an event", "failed"]);
});

test("a thrown error is read the same for every module: reconnect means it did not happen, anything else is unclear", async () => {
  const w = world();
  queue(w, "an email", false);
  await deliverQueued(w, post(() => { throw new ServiceError("reconnect", "Google refused the account's access"); }), {});
  queue(w, "another email", false);
  await deliverQueued(w, post(() => { throw new ServiceError("unavailable", "Google could not be reached"); }), {});
  queue(w, "an event", true);
  await deliverQueued(w, post(() => { throw new Error("socket hang up"); }), {});
  assert.deepEqual(states(w), [
    ["an email", "failed", "Google refused the account's access"],
    ["another email", "unknown", "Google could not be reached"],
    ["an event", "queued", "socket hang up"],
  ]);
});

test("one pass gets an account's session once, and stops between changes when the home node is closing", async () => {
  const w = world();
  for (const preview of ["one", "two", "three"]) queue(w, preview, true);
  let sessions = 0;
  const google: GoogleService = { accounts: () => [], async session() { sessions++; return { get: async () => ({}), send: async () => ({ status: 200, body: {} }) }; } };
  const closing = new AbortController();
  const module = defineModule({
    id: "post", title: "Post", migrations: [], ops: [], tools: [],
    async deliver(_world, outbound, services) {
      await services.google!.session("me@example.com");
      if (outbound.preview === "two") closing.abort();
      return { state: "done" };
    },
  });
  await deliverQueued(w, module, { google }, closing.signal);
  assert.equal(sessions, 1);
  assert.deepEqual(states(w).map(([preview, state]) => [preview, state]), [["one", "done"], ["two", "done"], ["three", "queued"]], "the third was never taken");
});
