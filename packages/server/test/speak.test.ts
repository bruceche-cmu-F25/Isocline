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
import { createHttpServer, openHome, parseSystemVoices, Speaker, type Home } from "../src/index.ts";

const SAY = fileURLToPath(new URL("./fixtures/fake-say.sh", import.meta.url));
const MODEL = [process.execPath, fileURLToPath(new URL("./fixtures/fake-speaker.ts", import.meta.url))];

async function start(speaker: Speaker): Promise<{ home: Home; server: Server; base: string }> {
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine: { submit: () => Promise.reject(new Error("no engine")) }, modules: [todoModule] });
  const server = createHttpServer(home, { port: 0, uiDir: "/nonexistent", speaker });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { home, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const speak = (base: string, body: Record<string, unknown>) =>
  fetch(`${base}/api/voice/speak`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("the system's voices: mainland Chinese and English, no novelty ones, the preferred one first", () => {
  const voices = parseSystemVoices([
    "Bubbles             en_US    # Hello!",
    "Flo (Chinese (China mainland)) zh_CN    # 你好！我叫Flo。",
    "Tingting             zh_CN    # 你好！我叫婷婷。",
    "Meijia              zh_TW    # 你好，我叫美佳。",
    "Daniel              en_GB    # Hello!",
    "Samantha            en_US    # Hello!",
    "Amélie              fr_CA    # Bonjour !",
  ].join("\n"));
  assert.deepEqual(voices.map((voice) => voice.id), ["system:Samantha", "system:Daniel", "system:Tingting", "system:Flo (Chinese (China mainland))"]);
});

test("speaks with the system voice for the language, at the chosen pace; the text goes in on stdin", async () => {
  const speaker = new Speaker({ sayCommand: SAY, modelCommand: MODEL, modelPresent: () => false });
  const { home, server, base } = await start(speaker);
  try {
    updateSettings(home.world, { locale: "zh" });
    const said = await speak(base, { text: "-v 明天 三点" });
    assert.equal(said.status, 200);
    assert.equal(said.headers.get("content-type"), "audio/wav");
    const body = Buffer.from(await said.arrayBuffer()).toString();
    assert.match(body, /^RIFF/);
    assert.match(body, /-v Tingting /);
    assert.match(body, /\|-v 明天 三点$/, "a text starting with a dash is the text, not an option");
    assert.doesNotMatch(body, / -r /, "the voice's own pace by default");

    // The user's choices apply when the device does not say.
    updateSettings(home.world, { voice: { voice: "system:Samantha", rate: 1.2 } });
    const chosen = Buffer.from(await (await speak(base, { text: "Done." })).arrayBuffer()).toString();
    assert.match(chosen, /-v Samantha .*-r 216/);
    // No voice chosen: the text's language picks, whatever the app's is.
    updateSettings(home.world, { locale: "en", voice: { voice: null } });
    assert.match(Buffer.from(await (await speak(base, { text: "好，加上了。" })).arrayBuffer()).toString(), /-v Tingting/);
    assert.match(Buffer.from(await (await speak(base, { text: "Done." })).arrayBuffer()).toString(), /-v Samantha/);
    updateSettings(home.world, { locale: "zh", voice: { voice: "system:Samantha" } });
    // A voice that is not here falls back to the language's default.
    const missing = Buffer.from(await (await speak(base, { text: "好", voice: "system:Nobody" })).arrayBuffer()).toString();
    assert.match(missing, /-v Tingting/);

    assert.equal((await speak(base, { text: "   " })).status, 502);
    assert.equal((await speak(base, { text: "x".repeat(601) })).status, 502);
    assert.equal((await speak(base, { text: "fail" })).status, 502);
    assert.equal((await speak(base, {})).status, 400);

    const status = await (await fetch(`${base}/api/voice`)).json() as { speak: { voices: Array<{ id: string }>; current: string; model: string } };
    assert.deepEqual(status.speak.voices.map((voice) => voice.id), ["system:Samantha", "system:Daniel", "system:Tingting", "system:Eddy (Chinese (China mainland))", "system:Flo (Chinese (China mainland))"]);
    assert.equal(status.speak.current, "system:Samantha");
    assert.equal(status.speak.model, "absent");
  } finally {
    speaker.close();
    server.close();
    home.close();
  }
});

test("a model voice is used once the model is on disk, in the language of the text", async () => {
  let present = false;
  const speaker = new Speaker({ sayCommand: SAY, modelCommand: MODEL, modelPresent: () => present, idleMs: 60_000 });
  const { home, server, base } = await start(speaker);
  try {
    updateSettings(home.world, { locale: "zh" });
    // Not downloaded: the system voice speaks instead.
    assert.match(Buffer.from(await (await speak(base, { text: "好的", voice: "model:Vivian" })).arrayBuffer()).toString(), /-v Tingting/);
    present = true;
    assert.match(Buffer.from(await (await speak(base, { text: "好的", voice: "model:Vivian" })).arrayBuffer()).toString(), /^RIFF\.\.\.\.WAVEmodel Vivian Chinese\|好的$/);
    assert.match(Buffer.from(await (await speak(base, { text: "Done.", voice: "model:Vivian" })).arrayBuffer()).toString(), /model Vivian English/);
    const status = await (await fetch(`${base}/api/voice`)).json() as { speak: { voices: Array<{ id: string }> } };
    assert.ok(status.speak.voices.some((voice) => voice.id === "model:Vivian"));
  } finally {
    speaker.close();
    server.close();
    home.close();
  }
});

test("voice settings: a patch changes only what it names, and bad values are refused", async () => {
  const speaker = new Speaker({ sayCommand: SAY, modelPresent: () => false });
  const { home, server } = await start(speaker);
  try {
    let settings = updateSettings(home.world, { voice: { words: [" Zirma ", "useSpeech", "Zirma"] } });
    assert.deepEqual(settings.voice, { speakFigure: true, muted: false, voice: null, rate: 1, words: ["Zirma", "useSpeech"] });
    settings = updateSettings(home.world, { voice: { muted: true } });
    assert.deepEqual(settings.voice.words, ["Zirma", "useSpeech"]);
    assert.equal(settings.voice.muted, true);
    assert.throws(() => updateSettings(home.world, { voice: { rate: 3 } }), /rate/);
    assert.throws(() => updateSettings(home.world, { voice: { voice: "cloud:x" } }), /voice\.voice/);
    assert.throws(() => updateSettings(home.world, { voice: { loud: true } }), /Unknown voice setting/);
    assert.throws(() => updateSettings(home.world, { voice: { words: Array.from({ length: 41 }, (_, i) => `w${i}`) } }), /at most 40/);
  } finally {
    speaker.close();
    server.close();
    home.close();
  }
});

test("the default voice is the character's: Ana's a woman's, Kata's a man's; a voice the user picked is kept", async () => {
  const speaker = new Speaker({ sayCommand: SAY, modelPresent: () => false });
  assert.equal(await speaker.pick(null, "zh"), "system:Tingting");
  assert.equal(await speaker.pick(null, "en", "ana"), "system:Samantha");
  assert.equal(await speaker.pick(null, "zh", "kata"), "system:Eddy (Chinese (China mainland))");
  assert.equal(await speaker.pick(null, "en", "kata"), "system:Daniel");
  assert.equal(await speaker.pick("system:Flo (Chinese (China mainland))", "zh", "kata"), "system:Flo (Chinese (China mainland))");
});
