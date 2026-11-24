import assert from "node:assert/strict";
import { test } from "node:test";
import type { SecretStore } from "@isocline/core";
import { boson, elevenlabs, inworld } from "../src/speak-cloud.ts";
import { Speaker } from "../src/speak.ts";

/** A WAV header and a little silence: what each service is asked for. */
const WAV = (() => {
  const data = 480;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(36 + data, 4); b.write("WAVE", 8, "ascii"); b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36, "ascii"); b.writeUInt32LE(data, 40);
  return b;
})();

interface Seen { url: string; method: string; headers: Record<string, string>; body: unknown }
/** A fake web: each request is recorded and answered by `answer`. */
function web(answer: (seen: Seen) => Response): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const request: Seen = { url: String(input), method: init?.method ?? "GET", headers, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(request);
    return answer(request);
  }) as typeof fetch;
  return { fetch: fake, seen };
}
const signal = () => AbortSignal.timeout(5000);
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("ElevenLabs: voices from /v2/voices with the key in xi-api-key; a WAV at 24 kHz from flash v2.5", async () => {
  const { fetch, seen } = web((request) => request.url.includes("/v2/voices")
    ? jsonResponse({ voices: [
      { voice_id: "v1", name: "Lin", labels: { language: "zh" } },
      { voice_id: "v2", name: "Rachel", labels: { language: "en", gender: "female" } },
      { voice_id: "v3", name: "Mix" },
    ], has_more: false })
    : new Response(WAV, { headers: { "Content-Type": "audio/wav" } }));
  const voices = await elevenlabs.voices("sk_test", fetch, signal());
  assert.deepEqual(voices.map((voice) => [voice.id, voice.lang]), [["elevenlabs:v1", "zh"], ["elevenlabs:v2", "en"], ["elevenlabs:v3", "any"]]);
  assert.equal(seen[0]!.headers["xi-api-key"], "sk_test");
  const wav = await elevenlabs.synthesize("sk_test", { text: "好，加上了。", voice: "v1", rate: 1.4, lang: "zh" }, fetch, signal());
  assert.deepEqual(wav, WAV);
  const said = seen[1]!;
  assert.equal(said.method, "POST");
  assert.equal(said.url, "https://api.elevenlabs.io/v1/text-to-speech/v1?output_format=wav_24000");
  assert.deepEqual(said.body, { text: "好，加上了。", model_id: "eleven_flash_v2_5", voice_settings: { speed: 1.2 } }, "its speed stops at 1.2");
});

test("Inworld: Basic auth with the key as given; Chinese asked as zh-CN; the Base64 WAV decoded", async () => {
  const { fetch, seen } = web((request) => request.url.includes("/voices/v1/voices")
    ? jsonResponse({ voices: [{ voiceId: "Xiaoyin", displayName: "晓音", languageCode: "zh-CN" }, { voiceId: "Ashley", displayName: "Ashley", languageCode: "en-US" }] })
    : jsonResponse({ audioContent: WAV.toString("base64"), usage: { processedCharactersCount: 6 } }));
  const voices = await inworld.voices("aW53b3JsZA==", fetch, signal());
  assert.deepEqual(voices.map((voice) => [voice.id, voice.name, voice.lang]), [["inworld:Xiaoyin", "晓音", "zh"], ["inworld:Ashley", "Ashley", "en"]]);
  assert.equal(seen[0]!.headers.authorization, "Basic aW53b3JsZA==", "the portal's key is already Base64: not encoded again");
  assert.match(new URL(seen[0]!.url).searchParams.get("filter")!, /lang_code = "zh"/);
  assert.deepEqual(await inworld.synthesize("aW53b3JsZA==", { text: "好的。", voice: "Xiaoyin", rate: 1, lang: "zh" }, fetch, signal()), WAV);
  assert.deepEqual(seen[1]!.body, { text: "好的。", voiceId: "Xiaoyin", modelId: "inworld-tts-2", language: "zh-CN", audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 24000, speakingRate: 1 } });
});

test("Boson AI: the presets and the user's own voices; higgs-tts-3 as WAV; pace as an inline tag", async () => {
  const { fetch, seen } = web((request) => request.url.endsWith("/v1/audio/voices")
    ? jsonResponse({ object: "list", data: [{ voice_id: "voice_abc12345", title: "Mine" }] })
    : new Response(WAV, { headers: { "Content-Type": "audio/wav" } }));
  const voices = await boson.voices("bai-test", fetch, signal());
  assert.deepEqual(voices.map((voice) => voice.id), ["boson:chloe", "boson:eleanor", "boson:nora", "boson:jake", "boson:marcus", "boson:oliver", "boson:voice_abc12345"]);
  assert.equal(seen[0]!.headers.authorization, "Bearer bai-test");
  await boson.synthesize("bai-test", { text: "现在是下午两点。", voice: "oliver", rate: 0.85, lang: "zh" }, fetch, signal());
  assert.equal(seen[1]!.url, "https://api.boson.ai/v1/audio/speech");
  assert.deepEqual(seen[1]!.body, { model: "higgs-tts-3", input: "<|prosody:speed_slow|>现在是下午两点。", voice: "oliver", response_format: "wav", stream: false });
  await boson.synthesize("bai-test", { text: "Done.", voice: "oliver", rate: 1, lang: "en" }, fetch, signal());
  assert.equal((seen[2]!.body as { input: string }).input, "Done.", "no tag at the normal pace");
});

test("a refusal says the service's status and reason; something that is not a WAV is refused", async () => {
  const refused = web(() => jsonResponse({ detail: { message: "Invalid API key" } }, 401));
  await assert.rejects(elevenlabs.voices("bad", refused.fetch, signal()), (error: Error & { code?: string }) => error.code === "unavailable" && /ElevenLabs said 401: Invalid API key/.test(error.message));
  const notWav = web(() => new Response("ID3 mp3 bytes", { headers: { "Content-Type": "audio/mpeg" } }));
  await assert.rejects(boson.synthesize("k", { text: "x", voice: "oliver", rate: 1, lang: "en" }, notWav.fetch, signal()), /did not send a WAV/);
});

/** Secrets in memory. */
function memory(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { kind: "file", values, get: async (name) => values.get(name), set: async (name, value) => { values.set(name, value); }, delete: async (name) => { values.delete(name); } };
}

test("a key is kept only once the service takes it; its voices are offered; when it fails the Mac's voice reads instead", async () => {
  let failing = false;
  const { fetch, seen } = web((request) => {
    const key = request.headers["xi-api-key"];
    if (key !== "sk_good") return jsonResponse({ detail: { message: "Invalid API key" } }, 401);
    if (request.url.includes("/v2/voices")) return jsonResponse({ voices: [{ voice_id: "v1", name: "Lin", labels: { language: "zh" } }], has_more: false });
    return failing ? jsonResponse({ detail: { message: "quota exceeded" } }, 429) : new Response(WAV);
  });
  const secrets = memory();
  const logs: string[] = [];
  const speaker = new Speaker({
    secrets, fetch, env: {}, sayCommand: new URL("./fixtures/fake-say.sh", import.meta.url).pathname, modelPresent: () => false, log: (line) => logs.push(line),
  });
  try {
    await assert.rejects(speaker.setKey("elevenlabs", "sk_bad"), /ElevenLabs said 401/);
    assert.equal(secrets.values.size, 0, "a refused key is not kept");
    await speaker.setKey("elevenlabs", " sk_good ");
    assert.equal(secrets.values.get("voice:elevenlabs"), "sk_good");

    const status = await speaker.status();
    assert.deepEqual(status.providers.map((item) => [item.id, item.key, item.error]), [["elevenlabs", "saved", null], ["inworld", null, null], ["boson", null, null]]);
    assert.ok(status.voices.some((voice) => voice.id === "elevenlabs:v1" && voice.engine === "elevenlabs"));

    assert.equal(await speaker.pick("elevenlabs:v1", "zh"), "elevenlabs:v1");
    assert.equal(await speaker.pick("inworld:Xiaoyin", "zh"), "system:Tingting", "no Inworld key: the Mac's voice");
    assert.deepEqual(await speaker.speak({ text: "好，加上了。", voice: "elevenlabs:v1", locale: "zh" }), WAV);

    failing = true;
    const fallback = (await speaker.speak({ text: "好，加上了。", voice: "elevenlabs:v1", locale: "zh" })).toString();
    assert.match(fallback, /-v Tingting/, "the reply is still said");
    assert.ok(logs.some((line) => /ElevenLabs failed.*429/.test(line)));

    await speaker.removeKey("elevenlabs");
    assert.equal(secrets.values.size, 0);
    assert.equal((await speaker.status()).providers[0]!.key, null);
    // A key in the environment works too, and says so.
    const fromEnv = new Speaker({ secrets: memory(), fetch, env: { ELEVENLABS_API_KEY: "sk_good" }, sayCommand: "/usr/bin/true", modelPresent: () => false });
    assert.equal((await fromEnv.status()).providers[0]!.key, "env");
    fromEnv.close();
    assert.ok(seen.length > 0);
  } finally {
    speaker.close();
  }
});
