import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { todoModule } from "@zirma/module-todo";
import { updateSettings } from "@zirma/core";
import { createHttpServer, openHome, Transcriber, type Home } from "../src/index.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-transcriber.ts", import.meta.url));
const fake = (env: Record<string, string> = {}) =>
  ["env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), process.execPath, FAKE];

/** A WAV header plus `samples` 16-bit samples of silence. */
function wav(samples: number): Buffer {
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0, "ascii"); buffer.writeUInt32LE(36 + samples * 2, 4); buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii"); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii"); buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

async function start(voice?: Transcriber): Promise<{ home: Home; server: Server; base: string }> {
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine: { submit: () => Promise.reject(new Error("no engine")) }, modules: [todoModule] });
  const server = createHttpServer(home, { port: 0, uiDir: "/nonexistent", voice });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { home, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

type Heard = { text: string; ms: number };
const text = async (response: Response) => ((await response.json()) as Heard).text;

const send = (base: string, body: Buffer, type = "audio/wav") =>
  fetch(`${base}/api/voice/transcribe`, { method: "POST", headers: { "Content-Type": type }, body: new Uint8Array(body) });

test("a recording comes back as words; the model loads on warm and unloads when idle", async () => {
  const voice = new Transcriber({ command: fake(), idleMs: 150 });
  const { home, server, base } = await start(voice);
  try {
    const status = await (await fetch(`${base}/api/voice`)).json() as Record<string, unknown>;
    assert.deepEqual({ ...status, speak: undefined }, { available: true, reason: null, loaded: false, speak: undefined });
    await fetch(`${base}/api/voice/warm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const heard = await send(base, wav(1000));
    assert.equal(heard.status, 200);
    assert.deepEqual(await heard.json(), { text: "heard 2044 bytes", ms: 5 });
    assert.equal(voice.loaded, true);
    // Several at once are answered each to its own.
    const many = await Promise.all([10, 20, 30].map(async (n) => text(await send(base, wav(n)))));
    assert.deepEqual(many, ["heard 64 bytes", "heard 84 bytes", "heard 104 bytes"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(voice.loaded, false, "unloaded after the idle time");
    // And loads again for the next one.
    assert.equal(await text(await send(base, wav(5))), "heard 54 bytes");
  } finally {
    voice.close();
    server.close();
    home.close();
  }
});

test("bad input is refused, a failed recording is an error, and a crashed model restarts", async () => {
  const voice = new Transcriber({ command: fake({ FAKE_EXIT_AFTER: "1" }), idleMs: 60_000 });
  const { home, server, base } = await start(voice);
  try {
    assert.equal((await send(base, wav(10), "application/json")).status, 415);
    assert.equal((await send(base, Buffer.from("not a wav at all, just some text here to be long enough"))).status, 400);
    const failed = await send(base, wav(1));
    assert.equal(failed.status, 502);
    assert.equal(((await failed.json()) as { code: string }).code, "voice_failed");
    // The fake quit after that answer; the next recording starts it again.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await text(await send(base, wav(3))), "heard 50 bytes");
  } finally {
    voice.close();
    server.close();
    home.close();
  }
});

test("every recording is given the user's words and name, so the model spells them right", async () => {
  const voice = new Transcriber({ command: fake(), idleMs: 60_000 });
  const { home, server, base } = await start(voice);
  try {
    assert.equal(await text(await send(base, wav(2))), "context: ");
    updateSettings(home.world, { preferredName: "Bruce", voice: { words: ["useSpeech", "Bruce", "Stripe"] } });
    assert.equal(await text(await send(base, wav(2))), "context: Bruce, useSpeech, Stripe");
  } finally {
    voice.close();
    server.close();
    home.close();
  }
});

test("without a transcriber the voice routes do not exist", async () => {
  const { home, server, base } = await start();
  try {
    assert.equal((await fetch(`${base}/api/voice`)).status, 404);
    assert.equal((await send(base, wav(10))).status, 404);
  } finally {
    server.close();
    home.close();
  }
});
