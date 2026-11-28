/** A turn's versions through the real Pi engine (docs/design/chat-regenerate.md R2): a stand-in model numbers its
 * replies and records what it was sent, so each check is about what the model actually saw. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPiEngine } from "@zirma/engine-pi";
import type { SubmitRunResponse } from "@zirma/protocol";
import { createHttpServer, openHome } from "../src/index.ts";

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("regenerate, edit and switch: the model sees the version in use and never the one set aside", { timeout: 60_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "zirma-versions-pi-"));
  const agentDir = join(dataDir, "agent");
  mkdirSync(agentDir);
  // What the model was sent, each request as the words of its messages; it answers R1, R2, ...
  const seen: string[] = [];
  let replies = 0;
  const provider: Server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { messages, model } = JSON.parse(body) as { model: string; messages: Array<{ role: string; content: unknown }> };
    const words = (content: unknown) => typeof content === "string" ? content
      : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("") : "";
    seen.push(messages.filter((message) => message.role !== "system").map((message) => `${message.role}: ${words(message.content)}`).join("\n"));
    const part = { id: "fixture", object: "chat.completion.chunk", created: 1, model,
      choices: [{ index: 0, delta: { role: "assistant", content: `R${++replies}` }, finish_reason: "stop" }] };
    res.writeHead(200, { "Content-Type": "text/event-stream" }).end(`data: ${JSON.stringify(part)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => { provider.close(); provider.closeAllConnections(); });
  const baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl, api: "openai-completions", apiKey: "fixture", models: [{ id: "fast", input: ["text"] }] } } }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fast" }));
  const secrets = process.env.ZIRMA_SECRETS;
  process.env.ZIRMA_SECRETS = "file";
  const engine = createPiEngine({ cwd: join(dataDir, "engine"), agentDir, config: dataDir });
  const home = openHome({ dataDir, engine, modules: [] });
  const server = createHttpServer(home, { port: 0, uiDir: "/nonexistent" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.close(); server.closeAllConnections(); home.close();
    await engine.close();
    if (secrets === undefined) delete process.env.ZIRMA_SECRETS; else process.env.ZIRMA_SECRETS = secrets;
  });

  const sent = async (path: string, body: unknown) => {
    const response = await post(base, path, body);
    assert.equal(response.status, 202, await response.clone().text());
    const { run } = (await response.json()) as SubmitRunResponse;
    await home.idle();
    return run;
  };
  const last = () => seen.at(-1)!;

  const first = await sent("/api/runs", { requestId: "a", goal: "Alpha question" });
  const conversationId = first.conversationId;
  const second = await sent("/api/runs", { requestId: "b", goal: "Bravo question", conversationId });
  assert.match(last(), /Alpha question[\s\S]*R1[\s\S]*Bravo question/);

  // Regenerate the last turn: the model sees the first exchange and the question again, not the reply set aside.
  const third = await sent(`/api/runs/${second.id}/again`, { requestId: "b2" });
  assert.match(last(), /Alpha question[\s\S]*R1[\s\S]*Bravo question/);
  assert.doesNotMatch(last(), /R2/, "the set-aside reply is not in what the model sees");
  assert.doesNotMatch(last(), /Earlier in this conversation/, "Pi's own session moved back; it did not start over from the core's history");

  // Edit it: the new words, and neither earlier version's reply.
  await sent(`/api/runs/${third.id}/again`, { requestId: "b3", goal: "Charlie question" });
  assert.match(last(), /Alpha question[\s\S]*R1[\s\S]*Charlie question/);
  assert.doesNotMatch(last(), /Bravo question|R2|R3/);

  // Going on: from the version in use (R4).
  const fourth = await sent("/api/runs", { requestId: "c", goal: "Delta question", conversationId });
  assert.match(last(), /Charlie question[\s\S]*R4[\s\S]*Delta question/);
  assert.doesNotMatch(last(), /Bravo question|R2|R3/);

  // Regenerate Delta, switch back to its first version, and go on: the model sees R5 again, not R6.
  await sent(`/api/runs/${fourth.id}/again`, { requestId: "c2" });
  assert.equal((await post(base, `/api/runs/${fourth.id}/use`, {})).status, 200);
  await sent("/api/runs", { requestId: "d", goal: "Echo question", conversationId });
  assert.match(last(), /Delta question[\s\S]*R5[\s\S]*Echo question/);
  assert.doesNotMatch(last(), /R6/, "the switched-away version is not in what the model sees");
  assert.doesNotMatch(last(), /Earlier in this conversation/);

  // A conversation's first turn again: a new session, nothing before it.
  const solo = await sent("/api/runs", { requestId: "s", goal: "Solo question" });
  await sent(`/api/runs/${solo.id}/again`, { requestId: "s2" });
  assert.match(last(), /Solo question/);
  assert.doesNotMatch(last(), /R8\b/);
  assert.equal(last().match(/Solo question/g)?.length, 1, "asked once, not after its old self");
});
