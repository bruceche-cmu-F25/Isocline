import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileStore } from "@zirma/core";
import { codexServers, createMcpVault, McpConnectors, readMcpFile, registryPlan } from "../src/index.ts";

function setup(options: { home?: string; fetcher?: typeof fetch } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "zirma-mcp-find-"));
  const secrets = fileStore(join(dataDir, "secrets.json"));
  const connectors = new McpConnectors({ dataDir, secrets, probe: async () => ({ state: "connected", tools: 1, readOnly: 1 }), ...options });
  return { dataDir, connectors, vault: createMcpVault({ secrets, lockDir: dataDir }) };
}
const put = (home: string, path: string, text: string) => { mkdirSync(dirname(join(home, path)), { recursive: true }); writeFileSync(join(home, path), text); };

test("Codex's TOML tables are read for what an MCP entry uses, lists over several lines included", () => {
  const servers = codexServers([
    "model = \"x\" # not a server",
    "[mcp_servers.docs]",
    "command = \"npx\"",
    "args = [",
    "  \"-y\", # the package",
    "  \"docs-mcp@1\",",
    "]",
    "[mcp_servers.docs.env]",
    "DOCS_TOKEN = 'abc#def'",
    "[mcp_servers.\"remote one\"]",
    "url = \"https://example.com/mcp\"",
    "http_headers = { X-Key = \"k\" }",
    "[profiles.other]",
    "command = \"ignored\"",
  ].join("\n"));
  assert.deepEqual(servers, {
    docs: { command: "npx", args: ["-y", "docs-mcp@1"], env: { DOCS_TOKEN: "abc#def" } },
    "remote one": { url: "https://example.com/mcp", http_headers: { "X-Key": "k" } },
  });
});

test("servers other agents on this Mac have are listed without their secrets, and copied in with them in the keychain", async () => {
  const home = mkdtempSync(join(tmpdir(), "zirma-home-"));
  put(home, "Library/Application Support/Claude/claude_desktop_config.json", JSON.stringify({ mcpServers: {
    files: { command: "npx", args: ["-y", "files-mcp", "--api-key", "SECRET1"], env: { FILES_TOKEN: "SECRET2", FILES_HOME: "${HOME}" } },
    old: { type: "sse", url: "https://old.example.com/sse" },
  } }));
  put(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: {
    files: { command: "other" },
    remote: { url: "https://remote.example.com/mcp?key=SECRET3", headers: { Authorization: "Bearer SECRET4" } },
  } }));
  put(home, "Library/Application Support/Code/User/mcp.json", JSON.stringify({ servers: { asks: { command: "x", env: { K: "${input:key}" } } } }));
  put(home, ".codex/config.toml", "[mcp_servers.taken]\ncommand = \"y\"\n");
  const t = setup({ home });
  await t.connectors.add({ name: "taken", command: "z" });

  const { found } = await t.connectors.describe();
  assert.deepEqual(found.map((server) => [server.id, server.place, server.kind]), [["Claude:files", "Claude", "stdio"], ["Cursor:remote", "Cursor", "http"]]);
  const shown = JSON.stringify(found);
  for (const secret of ["SECRET1", "SECRET2", "SECRET3", "SECRET4"]) assert.ok(!shown.includes(secret), secret);

  await t.connectors.add({ found: "Claude:files" });
  await t.connectors.add({ found: "Cursor:remote" });
  const file = readFileSync(join(t.dataDir, "mcp.json"), "utf8");
  assert.ok(!file.includes("SECRET2") && !file.includes("SECRET4"));
  assert.deepEqual(readMcpFile(t.dataDir).servers.files, { command: "npx", args: ["-y", "files-mcp", "--api-key", "SECRET1"], env: { FILES_HOME: "${HOME}" }, alfred: { title: "files", secretEnv: ["FILES_TOKEN"] } });
  assert.deepEqual(await t.vault.secrets("files"), { headers: {}, env: { FILES_TOKEN: "SECRET2" } });
  assert.deepEqual(await t.vault.secrets("remote"), { headers: { Authorization: "Bearer SECRET4" }, env: {} });
  assert.deepEqual((await t.connectors.describe()).found, []);
  await assert.rejects(t.connectors.add({ found: "Claude:files" }), /No such server on this Mac/);
});

const REGISTRY = {
  "/v0/servers?search=%2Fnotes": [
    { server: { name: "com.example/notes-helper", description: "Helps with notes", version: "1.0.0", packages: [{ registryType: "npm", identifier: "@example/notes", version: "1.0.0", transport: { type: "stdio" }, environmentVariables: [{ name: "NOTES_DIR", isRequired: true, description: "A folder" }, { name: "OPTIONAL", isRequired: false }] }] } },
  ],
  "/v0/servers?search=notes": [
    { server: { name: "io.github.someone/stuff-notes", description: "Notes too", version: "2.0.0", remotes: [{ type: "streamable-http", url: "https://stuff.example.com/mcp" }] } },
    { server: { name: "com.notes/mcp", title: "Notes", description: "The service's own", version: "3.0.0", remotes: [{ type: "streamable-http", url: "https://mcp.notes.example/mcp", headers: [{ name: "Authorization", value: "Bearer {api_key}", isRequired: true, isSecret: true }] }] } },
    { server: { name: "com.example/notes-helper", version: "1.0.0", packages: [{ registryType: "npm", identifier: "@example/notes", version: "1.0.0" }] } },
    { server: { name: "com.example/notes-docker", version: "1.0.0", packages: [{ registryType: "oci", identifier: "example/notes" }] } },
    { server: { name: "com.example/notes-gone", version: "1.0.0", remotes: [{ type: "streamable-http", url: "https://gone.example.com/mcp" }] }, _meta: { "io.modelcontextprotocol.registry/official": { status: "deleted" } } },
  ],
};
const registryFetch: typeof fetch = async (input) => {
  const url = new URL(String(input));
  if (url.pathname.startsWith("/v0/servers/")) {
    const name = decodeURIComponent(url.pathname.slice("/v0/servers/".length).replace(/\/versions\/latest$/, ""));
    const entry = Object.values(REGISTRY).flat().find((item) => item.server.name === name);
    return new Response(JSON.stringify(entry ?? {}), { status: entry ? 200 : 404 });
  }
  const key = `/v0/servers?search=${encodeURIComponent(url.searchParams.get("search") ?? "")}` as keyof typeof REGISTRY;
  assert.equal(url.searchParams.get("version"), "latest");
  return new Response(JSON.stringify({ servers: REGISTRY[key] ?? [] }));
};

test("the MCP Registry is searched two ways; the service's own server comes first, and one Zirma cannot run is left out", async () => {
  const t = setup({ fetcher: registryFetch, home: mkdtempSync(join(tmpdir(), "zirma-home-")) });
  const results = await t.connectors.search("notes");
  assert.deepEqual(results.map((result) => result.id), ["com.notes/mcp", "com.example/notes-helper", "io.github.someone/stuff-notes"]);
  assert.deepEqual(results[0].inputs, [{ name: "Authorization", kind: "header", secret: true }]);
  assert.deepEqual(results[1].inputs, [{ name: "NOTES_DIR", kind: "env", secret: false, description: "A folder" }]);
  assert.equal(results[1].where, "npx -y @example/notes@1.0.0");
  await assert.rejects(t.connectors.search("  "), /Say what to look for/);
});

test("a registry server is added with what it needs: a header template filled into the keychain, a package run with npx", async () => {
  const t = setup({ fetcher: registryFetch, home: mkdtempSync(join(tmpdir(), "zirma-home-")) });
  await assert.rejects(t.connectors.add({ registry: "com.notes/mcp" }), /Give Authorization/);
  const notes = await t.connectors.add({ registry: "com.notes/mcp", values: { Authorization: "KEY1" } });
  assert.deepEqual([notes.name, notes.title, notes.kind, notes.auth], ["notes", "Notes", "http", "secret"]);
  assert.deepEqual(readMcpFile(t.dataDir).servers.notes, { url: "https://mcp.notes.example/mcp", alfred: { title: "Notes", secretHeaders: ["Authorization"] } });
  assert.deepEqual(await t.vault.secrets("notes"), { headers: { Authorization: "Bearer KEY1" }, env: {} });

  const helper = await t.connectors.add({ registry: "com.example/notes-helper", values: { NOTES_DIR: "/tmp/notes" } });
  assert.equal(helper.name, "notes-helper");
  assert.deepEqual(readMcpFile(t.dataDir).servers["notes-helper"], { command: "npx", args: ["-y", "@example/notes@1.0.0"], alfred: { title: "notes-helper", secretEnv: ["NOTES_DIR"] } });
  assert.ok((await t.connectors.search("notes")).find((result) => result.id === "com.example/notes-helper")?.added);

  // A second server with the same last name gets a key of its own.
  assert.equal((await t.connectors.add({ registry: "io.github.someone/stuff-notes" })).name, "stuff-notes");
  await assert.rejects(t.connectors.add({ registry: "com.example/notes-docker" }), /cannot add this server/);
  await assert.rejects(t.connectors.add({ registry: "not a name" }), /named like/);
});

test("a registry entry with required arguments Zirma cannot fill, or only an SSE address, is not offered", () => {
  assert.equal(registryPlan({ name: "a/b", packages: [{ registryType: "npm", identifier: "b", packageArguments: [{ type: "positional", isRequired: true, valueHint: "path" }] }] }), null);
  assert.equal(registryPlan({ name: "a/b", remotes: [{ type: "sse", url: "https://b.example/sse" }] }), null);
  assert.deepEqual(registryPlan({ name: "a/b", packages: [{ registryType: "pypi", identifier: "b-mcp", version: "1", packageArguments: [{ type: "named", name: "--mode", default: "read" }] }] }),
    { name: "b", title: "b", command: "uvx", args: ["b-mcp==1", "--mode", "read"], inputs: [] });
});

test("an unreachable registry is said as such", async () => {
  const t = setup({ fetcher: async () => { throw new Error("offline"); } });
  await assert.rejects(t.connectors.search("x"), (error: Error & { code?: string }) => error.code === "unreachable" && /could not be reached/.test(error.message));
});
