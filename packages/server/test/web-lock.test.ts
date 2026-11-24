import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_MIGRATIONS, openWorld } from "@zirma/core";
import { WEB_LOCK_IDLE_MS, WebLock } from "../src/web-lock.ts";

const password = "a temporary test password";

test("the home clock expires inactive sessions, while actual activity extends just that browser", async (t) => {
  const world = openWorld(":memory:", CORE_MIGRATIONS);
  t.after(() => world.close());
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const changes: (string | null)[] = [];
  const lock = new WebLock(world, (id) => changes.push(id));
  assert.equal(lock.enabled, false);
  await lock.configure(true, password);
  const token = (await lock.unlock("laptop", password))!;
  assert.ok(token);
  assert.equal(lock.status("phone", token).locked, true);
  assert.equal(lock.status("laptop", "").locked, true);
  const first = lock.status("laptop", token);
  assert.equal(first.expiresAt, now + WEB_LOCK_IDLE_MS);
  now += 60_000;
  assert.deepEqual(lock.status("laptop", token), first);
  assert.equal(lock.activity("laptop", token).expiresAt, now + WEB_LOCK_IDLE_MS);
  now += WEB_LOCK_IDLE_MS;
  assert.throws(() => lock.activity("laptop", token), { code: "web_locked" });
  assert.deepEqual(changes, [null, "laptop"]);
});

test("restart keeps the verifier, changing settings and revoking a device invalidate in-flight unlocks", async (t) => {
  const world = openWorld(":memory:", CORE_MIGRATIONS);
  t.after(() => world.close());
  const lock = new WebLock(world, () => {});
  await lock.configure(true, password);
  const token = (await lock.unlock("phone", password))!;
  const restarted = new WebLock(world, () => {});
  assert.equal(restarted.status("phone", token).locked, true);
  const inFlight = restarted.unlock("phone", password);
  restarted.revoke("phone");
  await assert.rejects(inFlight, { code: "unpaired" });
  const duringChange = restarted.unlock("laptop", password);
  await restarted.configure(false);
  await assert.rejects(duringChange, { code: "web_locked" });
  assert.equal(restarted.enabled, false);
  lock.revoke("phone");
});

test("attempts are bounded before hashing starts; an unreadable verifier keeps every browser locked", async (t) => {
  const world = openWorld(":memory:", CORE_MIGRATIONS);
  t.after(() => world.close());
  const lock = new WebLock(world, () => {});
  await lock.configure(true, password);
  const wrong = lock.unlock("phone", "wrong");
  await assert.rejects(lock.unlock("phone", password), { code: "rate_limited" });
  await assert.rejects(wrong, { code: "wrong_password" });
  for (let n = 0; n < 4; n++) await assert.rejects(lock.unlock("phone", "wrong"), { code: "wrong_password" });
  await assert.rejects(lock.unlock("phone", password), { code: "rate_limited" });
  world.tx((db) => db.prepare("DELETE FROM core_web_lock").run());
  const damaged = new WebLock(world, () => {});
  assert.equal(damaged.status("phone", "").locked, true);
  await assert.rejects(damaged.unlock("phone", password), { code: "web_lock_unavailable" });
  await damaged.configure(true, password);
  assert.ok(await damaged.unlock("phone", password));
  damaged.revoke("phone");
});
