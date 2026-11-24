import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { agentLabelFor, checkStage, currentStage, dataDirFor, keychainServiceFor, portFor, stageDataDir } from "../src/stage.ts";

const PRODUCTION = { ISOCLINE_ENV: "production" };

test("anything not said to be production is development, with nothing of production's", () => {
  for (const env of [{}, { ISOCLINE_ENV: "dev" }, { ISOCLINE_ENV: "Production" }]) assert.equal(currentStage(env), "development");
  assert.equal(currentStage(PRODUCTION), "production");
  assert.notEqual(stageDataDir("development", {}, "darwin", "/h"), stageDataDir("production", {}, "darwin", "/h"));
  assert.notEqual(stageDataDir("development", {}, "linux", "/h"), stageDataDir("production", {}, "linux", "/h"));
  assert.notEqual(portFor({}), portFor(PRODUCTION));
  assert.notEqual(keychainServiceFor({}), keychainServiceFor(PRODUCTION));
  assert.notEqual(agentLabelFor({}), agentLabelFor(PRODUCTION));
});

test("neither stage's port or ingress port (port + 10, server cli.ts) is one of the other stage's", () => {
  const ports = (env: NodeJS.ProcessEnv) => [portFor(env), portFor(env) + 10];
  for (const port of ports({})) assert.ok(!ports(PRODUCTION).includes(port), `development uses ${port}, which production also uses`);
});

test("overrides apply within a stage", () => {
  assert.equal(dataDirFor({ ISOCLINE_DATA_DIR: "/tmp/w" }), "/tmp/w");
  assert.equal(portFor({ ISOCLINE_PORT: "7471" }), 7471);
  assert.equal(keychainServiceFor({ ISOCLINE_KEYCHAIN_SERVICE: "Test" }), "Test");
});

test("a development run may not open production's world or keychain", () => {
  const real = stageDataDir("production", {});
  assert.match(checkStage(real, {}) ?? "", /real world/);
  assert.match(checkStage(join(real, "..", "Isocline"), {}) ?? "", /real world/);
  assert.match(checkStage("/tmp/w", { ISOCLINE_KEYCHAIN_SERVICE: "Isocline" }) ?? "", /keychain/);
  assert.equal(checkStage("/tmp/w", {}), null);
  assert.equal(checkStage(stageDataDir("development", {}), {}), null);
  assert.equal(checkStage(real, PRODUCTION), null);
});
