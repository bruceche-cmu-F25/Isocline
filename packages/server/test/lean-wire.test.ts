/** What keeps the wire lean: a state that does not send again what the device holds, replies sent as what was
 * written since, and answers packed for other devices. */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import type { EnginePort } from "@zirma/core";
import { todoModule } from "@zirma/module-todo";
import type { LiveUpdate, StateResponse, SubmitRunResponse } from "@zirma/protocol";
import { createHttpServer, openHome, type Home } from "../src/index.ts";
import { overTheWire, send } from "../src/wire.ts";

async function start(home: Home): Promise<{ server: Server; base: string }> {
  const server = createHttpServer(home, { port: 0, uiDir: "/nonexistent" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const state = async (base: string, query = "") => (await (await fetch(`${base}/api/state${query}`)).json()) as StateResponse;
const none: EnginePort = { submit: () => Promise.reject(new Error("no engine")) };

test("the state leaves out the snapshots a device already holds, and sends one again once it has changed", async () => {
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine: none, modules: [todoModule] });
  const { server, base } = await start(home);
  try {
    const first = await state(base);
    assert.ok(first.modules.todo, "asked plainly, every snapshot comes");
    assert.match(first.revisions!.todo, /^[A-Za-z0-9_-]{16}$/);

    const have = `?have=todo.${first.revisions!.todo}`;
    const again = await state(base, have);
    assert.deepEqual(again.modules, {}, "held and unchanged: not sent again");
    assert.deepEqual(again.revisions, first.revisions);
    assert.deepEqual(again.views, first.views, "the rest of the state is all there");

    assert.equal((await post(base, "/api/ops/todo.add", { requestId: "op-1", input: { title: "Hand in report" } })).status, 200);
    const changed = await state(base, have);
    assert.ok(changed.modules.todo, "changed since: sent");
    assert.notEqual(changed.revisions!.todo, first.revisions!.todo);
    assert.ok((await state(base, "?have=todo.somethingelse")).modules.todo, "a revision that is not the current one gets the snapshot");

    const bare = await state(base, "?modules=0");
    assert.deepEqual(bare.modules, {});
    assert.deepEqual(bare.revisions, {});
    assert.equal(bare.protocol, 1);
  } finally {
    server.close(); server.closeAllConnections(); home.close();
  }
});

async function liveUntilComplete(stream: Response): Promise<LiveUpdate[]> {
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes('"run.completed"')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return text.split("\n\n").filter((block) => block.startsWith("event: live\n")).map((block) => JSON.parse(block.slice(block.indexOf("data: ") + 6)) as LiveUpdate);
}

test("live updates stay complete for v1 clients and use deltas when requested", async () => {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
  const engine: EnginePort = {
    async submit(request) {
      for (const text of ["Let", "Let me", "Let me check", "No: starting over"]) { request.onText?.(text); await pause(); }
      return { reply: "Done." };
    },
  };
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine, modules: [todoModule] });
  const { server, base } = await start(home);
  try {
    const { cursor } = await state(base, "?modules=0");
    const url = `${base}/api/events?after=${cursor}`;
    const [full, incremental] = await Promise.all([fetch(url), fetch(url + "&delta=1")]);
    const { run } = (await (await post(base, "/api/runs", { requestId: "r-1", goal: "look" })).json()) as SubmitRunResponse;
    const [legacy, live] = await Promise.all([liveUntilComplete(full), liveUntilComplete(incremental)]);
    const where = { runId: run.id, conversationId: run.conversationId };
    assert.deepEqual(legacy, ["Let", "Let me", "Let me check", "No: starting over"].map((text) => ({ ...where, text })));
    assert.deepEqual(live, [
      { ...where, text: "Let" },
      { ...where, at: 3, add: " me" },
      { ...where, at: 6, add: " check" },
      { ...where, text: "No: starting over" },
    ]);
  } finally {
    server.close(); server.closeAllConnections(); home.close();
  }
});

/** One GET, with the body as it came (not unpacked). */
function raw(port: number, headers: Record<string, string>): Promise<{ headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("an answer to another device is packed the way its browser takes; this machine's own, and a small one, are not", async () => {
  const big = { words: Array.from({ length: 400 }, (_, i) => `the same few words again ${i % 7}`) };
  let remote = true;
  let body: unknown = big;
  const server = createServer((_req, res) => { if (remote) overTheWire(res); send(res, 200, body); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const plain = Buffer.byteLength(JSON.stringify(big));
    const br = await raw(port, { "accept-encoding": "gzip, deflate, br" });
    assert.equal(br.headers["content-encoding"], "br");
    assert.equal(br.headers.vary, "Accept-Encoding");
    assert.equal(Number(br.headers["content-length"]), br.body.byteLength);
    assert.ok(br.body.byteLength < plain / 5, `packed to ${br.body.byteLength} of ${plain}`);
    assert.deepEqual(JSON.parse(brotliDecompressSync(br.body).toString("utf8")), big);

    const gz = await raw(port, { "accept-encoding": "gzip" });
    assert.equal(gz.headers["content-encoding"], "gzip");
    assert.deepEqual(JSON.parse(gunzipSync(gz.body).toString("utf8")), big);

    for (const [accept, expected] of [
      ["gzip, br;q=0", "gzip"], ["gzip, br;q=0.5", "gzip"], ["gzip;q=0, *;q=0.5", "br"],
      ["br;q=0, gzip;q=0", undefined], ["identity;q=1, gzip;q=0.5", undefined],
    ] as const) {
      assert.equal((await raw(port, { "accept-encoding": accept })).headers["content-encoding"], expected, accept);
    }

    const asked = await raw(port, {});
    assert.equal(asked.headers["content-encoding"], undefined, "a client that takes neither gets it plain");
    assert.equal(asked.body.byteLength, plain);

    body = { ok: true };
    assert.equal((await raw(port, { "accept-encoding": "br" })).headers["content-encoding"], undefined, "too small to be worth it");
    body = big; remote = false;
    assert.equal((await raw(port, { "accept-encoding": "br" })).headers["content-encoding"], undefined, "this machine's own");
  } finally {
    server.close(); server.closeAllConnections();
  }
});
