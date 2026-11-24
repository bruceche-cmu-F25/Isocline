import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileStore } from "@isocline/core";
import type { McpConnector } from "@isocline/protocol";
import { createMcpVault, loadIsoclineMcpConfig, McpConnectorError, McpConnectors, readMcpFile } from "../src/index.ts";

function setup(probe?: ConstructorParameters<typeof McpConnectors>[0]["probe"]) {
  const dataDir = mkdtempSync(join(tmpdir(), "alfred-mcp-"));
  const secrets = fileStore(join(dataDir, "secrets.json"));
  const changes: string[] = [];
  const connectors = new McpConnectors({ dataDir, secrets, onChange: (kind, name) => changes.push(`${kind} ${name}`), ...(probe ? { probe } : {}) });
  return { dataDir, secrets, connectors, changes, vault: createMcpVault({ secrets, lockDir: dataDir }) };
}
const fileText = (dataDir: string) => readFileSync(join(dataDir, "mcp.json"), "utf8");

/** A small MCP server over streamable HTTP: two tools, one of them read-only, for whoever sends the right token. */
async function mcpServer(token: string | null): Promise<{ url: string; server: Server; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => {
      seen.push(String(req.headers.authorization ?? ""));
      if (token !== null && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401, { "WWW-Authenticate": "Bearer realm=\"test\"" }).end(); return; }
      const call = JSON.parse(text) as { id?: number; method: string };
      if (call.id === undefined) { res.writeHead(202).end(); return; }
      const result = call.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } }
        : call.method === "tools/list"
          ? { tools: [
            { name: "search", description: "Search", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
            { name: "write", description: "Write", inputSchema: { type: "object" } },
          ] }
          : {};
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, server, seen };
}

test("a connector from the catalog is one entry in mcp.json; a token goes to the secret store, never the file", async () => {
  const t = setup(async () => ({ state: "needs_login" }));
  const listed = await t.connectors.describe();
  assert.ok(listed.catalog.some((entry) => entry.id === "notion" && entry.auth === "oauth" && !entry.added));
  assert.deepEqual(listed.servers, []);

  const notion = await t.connectors.add({ catalog: "notion" });
  assert.deepEqual([notion.name, notion.title, notion.kind, notion.state, notion.auth, notion.signedIn], ["notion", "Notion", "http", "needs_login", "oauth", false]);
  assert.deepEqual(readMcpFile(t.dataDir).servers.notion, { url: "https://mcp.notion.com/mcp", alfred: { title: "Notion", catalog: "notion" } });

  await assert.rejects(t.connectors.add({ catalog: "github" }), /Paste the token/);
  const github = await t.connectors.add({ catalog: "github", token: "github_pat_SECRET" });
  assert.equal(github.auth, "secret");
  assert.ok(!fileText(t.dataDir).includes("SECRET"), "the token is not in mcp.json");
  assert.deepEqual(readMcpFile(t.dataDir).servers.github.alfred, { title: "GitHub", catalog: "github", secretHeaders: ["Authorization"] });
  assert.deepEqual(await t.vault.secrets("github"), { headers: { Authorization: "Bearer github_pat_SECRET" }, env: {} });

  // Pi is handed the entries without Isocline's own key, and other clients' entries are left as they are.
  assert.deepEqual(loadIsoclineMcpConfig(t.dataDir).servers.map((server) => [server.name, server.config]), [
    ["notion", { url: "https://mcp.notion.com/mcp" }], ["github", { url: "https://api.githubcopilot.com/mcp/" }],
  ]);
  const again = await t.connectors.describe();
  assert.deepEqual(again.catalog.filter((entry) => entry.added).map((entry) => entry.id), ["notion", "github"]);
  await assert.rejects(t.connectors.add({ catalog: "notion" }), (error: McpConnectorError) => error.code === "exists");
  await assert.rejects(t.connectors.add({ catalog: "nope" }), (error: McpConnectorError) => error.code === "invalid");

  // Switching one off keeps it; removing it forgets its secret too.
  assert.equal((await t.connectors.setEnabled("github", false)).state, "off");
  assert.equal(readMcpFile(t.dataDir).servers.github.enabled, false);
  assert.equal((await t.connectors.setEnabled("github", true)).enabled, true);
  await t.connectors.remove("github");
  assert.deepEqual(await t.vault.secrets("github"), {});
  assert.deepEqual(Object.keys(readMcpFile(t.dataDir).servers), ["notion"]);
  assert.deepEqual(t.changes, ["added notion", "added github", "disabled github", "enabled github", "removed github"]);
  await assert.rejects(t.connectors.login("github"), (error: McpConnectorError) => error.code === "missing");
});

test("the user's own connector: an address or a command, with secrets kept apart; a hand-written file is read as it is", async () => {
  const t = setup(async () => ({ state: "connected", tools: 3, readOnly: 2 }));
  writeFileSync(join(t.dataDir, "mcp.json"), JSON.stringify({ note: "mine", mcpServers: { files: { command: "npx", args: ["-y", "server-files", "."] } } }));
  const docs = await t.connectors.add({ name: "docs", url: "https://docs.example/mcp", headers: { "X-Api-Key": "k-123" } });
  assert.deepEqual([docs.state, docs.tools, docs.readOnly, docs.auth], ["connected", 3, 2, "secret"]);
  const local = await t.connectors.add({ name: "db", command: "uvx", args: ["mcp-db"], env: { DB_URL: "postgres://secret" } });
  assert.deepEqual([local.kind, local.where], ["stdio", "uvx mcp-db"]);
  const text = fileText(t.dataDir);
  assert.ok(!text.includes("k-123") && !text.includes("postgres://secret"));
  assert.equal(JSON.parse(text).note, "mine", "what else the file holds is kept");
  assert.deepEqual((await t.connectors.describe()).servers.map((server: McpConnector) => server.name), ["files", "docs", "db"]);

  // What is shown of a hand-written entry hides what looks like a credential.
  writeFileSync(join(t.dataDir, "mcp.json"), JSON.stringify({ mcpServers: {
    q: { url: "https://user:pw@a.example/mcp?api_key=abc123" }, c: { command: "srv", args: ["--api-key", "abc123", "--token=xyz", "--port", "8080"] },
  } }));
  const shown = Object.fromEntries((await t.connectors.describe()).servers.map((server: McpConnector) => [server.name, server.where]));
  assert.deepEqual(shown, { q: "https://user:•••@a.example/mcp?api_key=•••", c: "srv --api-key ••• --token=••• --port 8080" });

  for (const bad of [{ name: "x y", url: "https://a.example" }, { name: "both", url: "https://a.example", command: "x" }, { name: "none" },
    { name: "ftp", url: "ftp://a.example" }, { name: "hdr", command: "x", headers: { A: "b" } }, { name: "env", url: "https://a.example", env: { A: "b" } }]) {
    await assert.rejects(t.connectors.add(bad), (error: McpConnectorError) => error.code === "invalid", JSON.stringify(bad));
  }
});

test("a server is reached the way a run reaches it: the secret header is sent, and its tools are counted", async () => {
  const good = await mcpServer("s3cret");
  const open = await mcpServer(null);
  const t = setup();
  try {
    const mine = await t.connectors.add({ name: "mine", url: good.url, headers: { Authorization: "Bearer s3cret" } });
    assert.deepEqual([mine.state, mine.tools, mine.readOnly], ["connected", 2, 1]);
    assert.ok(good.seen.every((header) => header === "Bearer s3cret"));

    // A refused token is an error to fix, not a sign-in to offer.
    const wrong = await t.connectors.add({ name: "wrong", url: good.url, headers: { Authorization: "Bearer nope" } });
    assert.deepEqual([wrong.state, wrong.error], ["error", "The server refused the token"]);

    // No account needed: connected, nothing sent.
    const free = await t.connectors.add({ name: "free", url: open.url });
    assert.deepEqual([free.state, free.auth, free.tools], ["connected", "none", 2]);
    assert.ok(open.seen.every((header) => header === ""));

    // A server that wants a sign-in and has none says so.
    const locked = await t.connectors.add({ name: "locked", url: good.url });
    assert.deepEqual([locked.state, locked.auth, locked.signedIn], ["needs_login", "oauth", false]);
  } finally {
    for (const { server } of [good, open]) { server.close(); server.closeAllConnections(); }
    t.connectors.close();
  }
});
