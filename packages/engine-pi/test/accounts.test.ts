import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileStore } from "@isocline/core";
import { createCredentialStore, ModelAccounts } from "../src/index.ts";

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "alfred-models-"));
  const piAgentDir = join(dataDir, "pi");
  mkdirSync(piAgentDir);
  const secrets = fileStore(join(dataDir, "secrets.json"));
  const store = createCredentialStore({ secrets, lockDir: dataDir });
  return { dataDir, piAgentDir, secrets, store };
}

const waitFor = async <T>(read: () => T, done: (value: T) => boolean): Promise<T> => {
  for (let i = 0; i < 200; i++) {
    const value = read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
};

test("the credential store keeps every provider in one secret and serialises changes across stores", async () => {
  const t = setup();
  // Two stores over the same secret and lock stand in for the home node and a worker.
  const other = createCredentialStore({ secrets: t.secrets, lockDir: t.dataDir, cacheMs: 0 });
  const bump = (store: typeof t.store) => store.modify("counter", async (current) => {
    const n = Number(current?.type === "api_key" ? current.key : 0);
    await new Promise((resolve) => setTimeout(resolve, 2));
    return { type: "api_key", key: String(n + 1) };
  });
  await Promise.all(Array.from({ length: 10 }, (_, i) => bump(i % 2 ? t.store : other)));
  const stored = await other.read("counter");
  assert.deepEqual(stored, { type: "api_key", key: "10" });
  assert.deepEqual(await t.store.list(), [{ providerId: "counter", type: "api_key" }]);
  assert.deepEqual(Object.keys(JSON.parse(readSecrets(t.dataDir))), ["models"]);

  await t.store.delete("counter");
  assert.equal(await other.read("counter"), undefined);
});

function readSecrets(dataDir: string): string {
  return readFileSync(join(dataDir, "secrets.json"), "utf8");
}

test("signing in with an API key: Pi asks for the key, the device answers, the key lands in Isocline's store", async () => {
  const t = setup();
  const changes: string[] = [];
  const accounts = new ModelAccounts({ store: t.store, dataDir: t.dataDir, piAgentDir: t.piAgentDir, onChange: (kind, provider) => changes.push(`${kind}:${provider}`) });

  const before = await accounts.describe();
  const deepseek = before.providers.find((provider) => provider.id === "deepseek")!;
  assert.equal(deepseek.apiKey, true);
  assert.equal(deepseek.status.configured, false);
  const anthropic = before.providers.find((provider) => provider.id === "anthropic")!;
  assert.equal(anthropic.oauth?.subscription, true);
  // Providers reachable only through ambient cloud credentials are not offered.
  assert.equal(before.providers.some((provider) => provider.id === "amazon-bedrock" && !provider.apiKey && !provider.oauth), false);

  const flow = await accounts.start("deepseek", "api_key");
  const asked = await waitFor(() => accounts.flow(flow.id)!, (state) => state.prompt !== null);
  assert.equal(asked.prompt!.type, "secret");
  accounts.answer(flow.id, asked.prompt!.id, "sk-test-123");
  const done = await waitFor(() => accounts.flow(flow.id)!, (state) => state.status !== "running");
  assert.equal(done.status, "done", done.error ?? "the sign-in did not finish");
  assert.deepEqual(await t.store.read("deepseek"), { type: "api_key", key: "sk-test-123" });
  assert.deepEqual(changes, ["signed_in:deepseek"]);

  const after = await accounts.describe();
  assert.deepEqual(after.providers.find((provider) => provider.id === "deepseek")!.status, { configured: true, method: "api_key", source: "alfred" });
  // The response never carries the key.
  assert.doesNotMatch(JSON.stringify(after), /sk-test-123/);

  await accounts.logout("deepseek");
  assert.equal(await t.store.read("deepseek"), undefined);
  assert.deepEqual(changes, ["signed_in:deepseek", "signed_out:deepseek"]);
});

test("a sign-in can be cancelled, and only one runs at a time", async () => {
  const t = setup();
  const accounts = new ModelAccounts({ store: t.store, dataDir: t.dataDir, piAgentDir: t.piAgentDir });
  const flow = await accounts.start("mistral", "api_key");
  await waitFor(() => accounts.flow(flow.id)!, (state) => state.prompt !== null);
  await assert.rejects(accounts.start("groq", "api_key"), { name: "ModelSignInError", code: "busy" });
  assert.equal(accounts.cancel(flow.id)!.status, "cancelled");
  assert.equal(await t.store.read("mistral"), undefined);
  assert.throws(() => accounts.answer(flow.id, "nope", "x"), { code: "state" });
  await assert.rejects(accounts.start("nope-provider", "api_key"), { code: "unknown_provider" });
  await assert.rejects(accounts.start("deepseek", "oauth"), { code: "unsupported" });
  accounts.close();
});

test("Pi's setup: plain API keys can be imported; commands and subscriptions are not copied", async () => {
  const t = setup();
  writeFileSync(join(t.piAgentDir, "auth.json"), JSON.stringify({
    deepseek: { type: "api_key", key: "sk-deep" },
    google: { type: "api_key", key: "!security find-generic-password -w" },
    anthropic: { type: "oauth", access: "a", refresh: "r", expires: 0 },
  }));
  const accounts = new ModelAccounts({ store: t.store, dataDir: t.dataDir, piAgentDir: t.piAgentDir });
  const offer = await accounts.describe();
  assert.deepEqual(offer.piKeys.map((item) => item.id), ["deepseek"]);
  assert.deepEqual(offer.piSubscriptions.map((item) => item.id), ["anthropic"]);

  const after = await accounts.importFromPi(["deepseek", "google", "anthropic"]);
  assert.deepEqual(await t.store.read("deepseek"), { type: "api_key", key: "sk-deep" });
  assert.equal(await t.store.read("google"), undefined);
  assert.equal(await t.store.read("anthropic"), undefined);
  // Once imported it is no longer offered; the subscription still is, to sign in again.
  assert.deepEqual(after.piKeys, []);
  assert.deepEqual(after.piSubscriptions.map((item) => item.id), ["anthropic"]);
});
