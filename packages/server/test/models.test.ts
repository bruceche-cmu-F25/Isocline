import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileStore } from "@zirma/core";
import { createCredentialStore, ModelAccounts } from "@zirma/engine-pi";
import { todoModule } from "@zirma/module-todo";
import type { ModelAccountsResponse, ModelSignIn } from "@zirma/protocol";
import { createHttpServer, openHome } from "../src/index.ts";

test("over HTTP: list providers, sign in with a key by answering Pi's question, import from Pi, sign out", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "alfred-models-http-"));
  const piAgentDir = join(dataDir, "pi");
  mkdirSync(piAgentDir);
  writeFileSync(join(piAgentDir, "auth.json"), JSON.stringify({ groq: { type: "api_key", key: "gsk-from-pi" }, anthropic: { type: "oauth", access: "a", refresh: "r", expires: 0 } }));
  const store = createCredentialStore({ secrets: fileStore(join(dataDir, "secrets.json")), lockDir: dataDir });
  const models = new ModelAccounts({ store, dataDir, piAgentDir });
  const home = openHome({ dataDir, engine: { submit: () => Promise.reject(new Error("no engine")) }, modules: [todoModule] });
  const server: Server = createHttpServer(home, { port: 0, uiDir: "/nonexistent", models });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async <T>(path: string) => (await fetch(`${base}${path}`)).json() as Promise<T>;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const listed = await get<ModelAccountsResponse>("/api/connections/models");
    assert.ok(listed.providers.some((provider) => provider.id === "anthropic" && provider.oauth?.subscription));
    assert.deepEqual(listed.piKeys.map((item) => item.id), ["groq"]);
    assert.deepEqual(listed.piSubscriptions.map((item) => item.id), ["anthropic"]);
    // Without Google wired in, the Google routes are simply not there.
    assert.equal((await fetch(`${base}/api/connections`)).status, 404);

    assert.equal((await post("/api/connections/models/deepseek/login", { method: "password" })).status, 400);
    assert.equal((await post("/api/connections/models/nope/login", { method: "api_key" })).status, 404);
    const started = (await (await post("/api/connections/models/deepseek/login", { method: "api_key" })).json()) as ModelSignIn;
    let state = started;
    for (let i = 0; i < 100 && !state.prompt; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      state = await get<ModelSignIn>(`/api/connections/models/flows/${started.id}`);
    }
    assert.equal(state.prompt?.type, "secret");
    assert.equal((await post(`/api/connections/models/flows/${started.id}/answer`, { promptId: "wrong", value: "x" })).status, 409);
    assert.equal((await post(`/api/connections/models/flows/${started.id}/answer`, { promptId: state.prompt!.id, value: "sk-deep" })).status, 200);
    for (let i = 0; i < 100 && state.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      state = await get<ModelSignIn>(`/api/connections/models/flows/${started.id}`);
    }
    assert.equal(state.status, "done");

    const imported = (await (await post("/api/connections/models/import", { providers: ["groq"] })).json()) as ModelAccountsResponse;
    assert.deepEqual(imported.piKeys, []);
    const configured = imported.providers.filter((provider) => provider.status.source === "alfred").map((provider) => provider.id).sort();
    assert.deepEqual(configured, ["deepseek", "groq"]);
    assert.doesNotMatch(JSON.stringify(imported), /sk-deep|gsk-from-pi/, "no secret in a response");

    const out = (await (await post("/api/connections/models/deepseek/logout", {})).json()) as ModelAccountsResponse;
    assert.equal(out.providers.find((provider) => provider.id === "deepseek")!.status.configured, false);
  } finally {
    server.close();
    models.close();
    home.close();
  }
});
