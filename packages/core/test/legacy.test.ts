import assert from "node:assert/strict";
import { test } from "node:test";
import { adoptLegacyEnv, carryingOver, type SecretStore } from "../src/index.ts";
import { assistantNameOf, getSettings, SettingsError, updateSettings } from "../src/index.ts";
import { openWorld, CORE_MIGRATIONS } from "../src/index.ts";

function memory(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { kind: "keychain", data, get: async (name) => data.get(name), set: async (name, value) => { data.set(name, value); }, delete: async (name) => { data.delete(name); } };
}

test("a secret kept under the old keychain name is copied over the first time it is read; the old copy stays for an older app", async () => {
  const store = memory(), legacy = memory();
  legacy.data.set("google:me@example.com", "token-1");
  const both = carryingOver(store, legacy);
  assert.equal(await both.get("google:me@example.com"), "token-1");
  assert.equal(store.data.get("google:me@example.com"), "token-1", "now under the new name");
  assert.equal(legacy.data.get("google:me@example.com"), "token-1", "the old copy is left for an older app still running");
  assert.equal(await both.get("missing"), undefined);
});

test("a secret the user removes never comes back from the old place, and a new value is read from the new place", async () => {
  const store = memory(), legacy = memory();
  legacy.data.set("a", "old-a");
  legacy.data.set("b", "old-b");
  const both = carryingOver(store, legacy);
  await both.delete("a");
  assert.equal(await both.get("a"), undefined);
  assert.equal(legacy.data.has("a"), false, "deleting removes the old copy too");
  await both.set("b", "new-b");
  assert.equal(legacy.data.get("b"), "old-b", "writing leaves the old copy alone");
  assert.equal(await both.get("b"), "new-b");
});

test("a setting made under the old prefix still applies, unless the new one is set", () => {
  const env: NodeJS.ProcessEnv = { ALFRED_PORT: "7490", ALFRED_DATA_DIR: "/old", ISOCLINE_DATA_DIR: "/new" };
  adoptLegacyEnv(env);
  assert.equal(env.ISOCLINE_PORT, "7490");
  assert.equal(env.ISOCLINE_DATA_DIR, "/new");
});

test("the assistant is Ana until the user picks Kata or gives it a name of their own", () => {
  const world = openWorld(":memory:", CORE_MIGRATIONS);
  assert.equal(assistantNameOf(getSettings(world)), "Ana");
  assert.equal(assistantNameOf(updateSettings(world, { character: "kata" })), "Kata");
  assert.equal(assistantNameOf(updateSettings(world, { assistantName: " Alfred " })), "Alfred");
  assert.equal(assistantNameOf(updateSettings(world, { assistantName: "" })), "Kata", "an empty name is the character's own");
  assert.throws(() => updateSettings(world, { character: "robin" }), SettingsError);
  assert.throws(() => updateSettings(world, { assistantName: "x".repeat(41) }), SettingsError);
});
