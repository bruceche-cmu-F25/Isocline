import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_MIGRATIONS, openWorld, recordDomainEvent, type World } from "@zirma/core";
import { defineModule } from "@zirma/module-kit";
import { modulePasses } from "../src/passes.ts";

const world = (): World => openWorld(":memory:", CORE_MIGRATIONS);
const saved = (w: World) => w.tx(() => { recordDomainEvent(w, { kind: "shelf.saved", payload: {} }); });
const settle = async (until: () => boolean) => { for (let i = 0; i < 100 && !until(); i++) await new Promise((resolve) => setTimeout(resolve, 5)); };

test("a module's pass runs soon after an event it named, and once more when the event came during a pass", async () => {
  const w = world();
  let passes = 0;
  let finish!: () => void;
  const reading = new Promise<void>((resolve) => { finish = resolve; });
  const shelf = defineModule({
    id: "shelf", title: "Shelf", migrations: [], ops: [], tools: [],
    sync: { everyMs: 3_600_000, onEvents: ["shelf.saved"], async run() { if (++passes === 1) await reading; } },
  });
  const quiet = defineModule({ id: "quiet", title: "Quiet", migrations: [], ops: [], tools: [], sync: { everyMs: 3_600_000, async run() { assert.fail("nothing asked for this one"); } } });
  const running = modulePasses({ world: w, modules: [shelf, quiet] });
  try {
    // An event of another kind starts nothing.
    w.tx(() => { recordDomainEvent(w, { kind: "todo.added", payload: {} }); });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(passes, 0);
    saved(w);
    await settle(() => passes === 1);
    assert.equal(passes, 1, "soon, not at the next scheduled pass");
    // Two more while it is reading: it may have read before them, so it reads again, once.
    saved(w);
    saved(w);
    assert.equal(passes, 1, "never two passes at a time");
    finish();
    await settle(() => passes === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(passes, 2);
    // A device asking gets the pass it asked for; a module without a mirror has none to refresh.
    await running.sync("shelf");
    assert.equal(passes, 3);
    await assert.rejects(running.sync("nope"), /No module nope/);
  } finally {
    running.close();
    w.close();
  }
});

test("closing stops what was about to run", async () => {
  const w = world();
  let passes = 0;
  const shelf = defineModule({ id: "shelf", title: "Shelf", migrations: [], ops: [], tools: [], sync: { everyMs: 3_600_000, onEvents: ["shelf.saved"], async run() { passes++; } } });
  const running = modulePasses({ world: w, modules: [shelf] });
  saved(w);
  running.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(passes, 0);
  saved(w);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(passes, 0);
  w.close();
});

test("a pass that could not reach its service is tried again soon, backing off, and stops once it gets through", async () => {
  const w = world();
  const at: number[] = [];
  const mirror = defineModule({
    id: "mirror", title: "Mirror", migrations: [], ops: [], tools: [],
    sync: { everyMs: 3_600_000, async run() { at.push(Date.now()); return { retrySoon: at.length < 3 }; } },
  });
  const running = modulePasses({ world: w, modules: [mirror], retryFirstMs: 20 });
  try {
    await running.sync("mirror");
    await settle(() => at.length === 3);
    assert.equal(at.length, 3, "two retries, not the hour-long interval");
    assert.ok(at[2]! - at[1]! >= at[1]! - at[0]! - 5, "each wait at least as long as the one before");
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(at.length, 3, "no more once a pass gets through");
  } finally {
    running.close();
    w.close();
  }
});
