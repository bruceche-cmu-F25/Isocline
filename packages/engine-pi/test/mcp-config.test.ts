import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadIsoclineMcpConfig } from "../src/index.ts";

test("no mcp.json means no servers", () => {
  assert.deepEqual(loadIsoclineMcpConfig(mkdtempSync(join(tmpdir(), "alfred-mcp-"))), { servers: [], errors: [] });
});

test("valid servers load; invalid ones are reported and skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "alfred-mcp-"));
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({
    mcpServers: {
      notes: { command: "node", args: ["notes.js"], env: { TOKEN: "${NOTES_TOKEN}" } },
      docs: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${DOCS}" } },
      "bad name": { command: "x" },
      nothing: { args: [] },
      old: { url: "https://example.com/sse", type: "sse" },
      wrongArgs: { command: "x", args: "a b" },
    },
  }));
  const loaded = loadIsoclineMcpConfig(dir);
  assert.deepEqual(loaded.servers.map((server) => server.name), ["notes", "docs"]);
  assert.equal(loaded.servers[0].config.env && (loaded.servers[0].config.env as Record<string, string>).TOKEN, "${NOTES_TOKEN}", "placeholders are left for Pi to resolve when it connects");
  assert.equal(loaded.errors.length, 4);
});

test("a broken file is reported, not thrown", () => {
  const dir = mkdtempSync(join(tmpdir(), "alfred-mcp-"));
  writeFileSync(join(dir, "mcp.json"), "{ not json");
  const loaded = loadIsoclineMcpConfig(dir);
  assert.deepEqual(loaded.servers, []);
  assert.equal(loaded.errors.length, 1);
});
