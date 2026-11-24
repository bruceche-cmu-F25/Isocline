import assert from "node:assert/strict";
import { test } from "node:test";
import { keychainLine, keychainStore, type KeychainItems } from "../src/secrets.ts";

/** A keychain in memory. `failAt`: the write (counted from 1) that fails, as when the tool cannot store an item. */
function fake(): KeychainItems & { held: Map<string, string>; failAt: number | null; writes: number } {
  const held = new Map<string, string>();
  const items = {
    held, failAt: null as number | null, writes: 0,
    async read(account: string) { return held.get(account); },
    async write(account: string, text: string) {
      if (++items.writes === items.failAt) throw new Error("Keychain write failed");
      keychainLine("Zirma", account, text); // refuses what the real tool would cut
      held.set(account, text);
    },
    async remove(account: string) { held.delete(account); },
  };
  return items;
}

const base64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
/** Like several providers' sign-ins in one entry: well past what one item holds. */
const long = (seed: string) => JSON.stringify({ provider: { type: "oauth", access: seed.repeat(3000), refresh: "钥匙".repeat(400) } });

test("a short secret is one keychain item, as it always was", async () => {
  const items = fake();
  const store = keychainStore("Zirma", items);
  await store.set("google:me@example.com", "{\"refresh\":\"abc\"}");
  assert.deepEqual([...items.held], [["google:me@example.com", base64("{\"refresh\":\"abc\"}")]]);
  assert.equal(await store.get("google:me@example.com"), "{\"refresh\":\"abc\"}");
  assert.equal(await store.get("nothing"), undefined);
});

test("a long secret is split over items the keychain tool reads whole, and reads back whole", async () => {
  const items = fake();
  const store = keychainStore("Zirma", items);
  const value = long("a");
  await store.set("models", value);
  assert.equal(await store.get("models"), value);
  assert.ok(items.held.size > 2, "several items");
  for (const [account, text] of items.held) assert.ok(keychainLine("Zirma", account, text).length < 2600, `${account} fits one line with room to spare`);
  assert.match(items.held.get("models")!, /^parts:[0-9a-f]{8}:\d+:[0-9a-f]{64}$/, "the entry names its parts");
});

test("a line the keychain tool would cut, or that could be read as two commands, is never built", () => {
  const around = keychainLine("Zirma", "models", "").length;
  assert.equal(keychainLine("Zirma", "models", "A".repeat(4096 - around)).length, 4096, "the longest line the tool reads whole");
  assert.throws(() => keychainLine("Zirma", "models", "A".repeat(4097 - around)), /Too long/);
  for (const text of ["a\"b", "a\nb", "a b", "a\\b"]) assert.throws(() => keychainLine("Zirma", "models", text), /Not a keychain item/);
  assert.throws(() => keychainLine("Zirma", "mod\"els", "abc"), /Not a keychain item/);
});

test("replacing a long secret leaves no parts of the old one behind; nor does a short one, or deleting", async () => {
  const items = fake();
  const store = keychainStore("Zirma", items);
  await store.set("models", long("a"));
  const first = items.held.size;
  await store.set("models", long("b"));
  assert.equal(await store.get("models"), long("b"));
  assert.equal(items.held.size, first, "only the new parts and the entry");

  await store.set("models", "{}");
  assert.deepEqual([...items.held], [["models", base64("{}")]]);

  await store.set("models", long("c"));
  await store.delete("models");
  assert.equal(items.held.size, 0);
  assert.equal(await store.get("models"), undefined);
});

test("a write that fails halfway leaves the secret that was there, whole", async () => {
  const items = fake();
  const store = keychainStore("Zirma", items);
  await store.set("models", long("a"));
  const before = new Map(items.held);
  for (const failAt of [1, 2, items.held.size]) { // a part, another part, the header itself
    items.writes = 0;
    items.failAt = failAt;
    await assert.rejects(store.set("models", long("b")), /Keychain write failed/);
    assert.deepEqual([...items.held], [...before], "nothing changed, nothing left over");
    assert.equal(await store.get("models"), long("a"));
  }
  // And a short secret that was there is not lost to a long one that fails.
  items.failAt = null;
  await store.set("models", "{\"k\":1}");
  items.writes = 0;
  items.failAt = 2;
  await assert.rejects(store.set("models", long("b")));
  assert.equal(await store.get("models"), "{\"k\":1}");
});

test("an entry written in one piece before secrets were split still reads", async () => {
  const items = fake();
  const old = JSON.stringify({ provider: { access: "x".repeat(2800) } });
  items.held.set("models", base64(old)); // longer than a part, but it fitted the old way
  assert.equal(await keychainStore("Zirma", items).get("models"), old);
});

test("a reader that meets a write in progress reads again and gets the new secret", async () => {
  const items = fake();
  const writer = keychainStore("Zirma", items);
  await writer.set("models", long("a"));
  let interrupted = false;
  const racing: KeychainItems = {
    ...items,
    async read(account) {
      const text = await items.read(account);
      // Right after the reader has the old header, another process replaces the secret and clears the old parts.
      if (account === "models" && !interrupted) { interrupted = true; await writer.set("models", long("b")); }
      return text;
    },
  };
  assert.equal(await keychainStore("Zirma", racing).get("models"), long("b"));
});

test("two writes to one entry at the same moment both succeed, and the later one is kept", async () => {
  // Like the real tool: a write lands, then is read back to check it, and other work happens in between.
  const held = new Map<string, string>();
  const pause = () => new Promise((resolve) => setImmediate(resolve));
  const items: KeychainItems = {
    async read(account) { await pause(); return held.get(account); },
    async write(account, text) { await pause(); held.set(account, text); await pause(); if (held.get(account) !== text) throw new Error("Keychain write failed"); },
    async remove(account) { await pause(); held.delete(account); },
  };
  const store = keychainStore("Zirma", items);
  // The calendar and the mail refreshing one account's token in the same pass.
  await Promise.all([store.set("google:me@example.com", "first"), store.set("google:me@example.com", "second")]);
  assert.equal(await store.get("google:me@example.com"), "second");
  await Promise.all([store.set("models", long("a")), store.set("models", long("b")), store.set("push:vapid", "{}")]);
  assert.equal(await store.get("models"), long("b"));
  assert.equal(await store.get("push:vapid"), "{}", "other entries do not wait on it");
  await assert.rejects(store.set("not a name", "x"), /Invalid secret name/);
});

test("an entry whose parts are gone says so instead of returning half a secret", async () => {
  const items = fake();
  const store = keychainStore("Zirma", items);
  await store.set("models", long("a"));
  const part = [...items.held.keys()].find((account) => account.endsWith("/1"))!;
  items.held.delete(part);
  await assert.rejects(store.get("models"), /incomplete/);
});
