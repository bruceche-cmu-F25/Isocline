/** Voices from speech services on the web: ElevenLabs, Inworld and Boson AI (docs/design/voice.md §2.1). The user
 * brings their own key, kept in the keychain like the model keys; the text to be read goes to that service, the
 * audio comes back to the home node, and devices play it as they play every other voice.
 *
 * Each adapter does two things: list the voices the key can use, and turn a sentence into a WAV. Field names follow
 * each service's own reference (read 2026-11-23):
 * - ElevenLabs: POST /v1/text-to-speech/{voice_id}?output_format=wav_24000, header `xi-api-key`; voices from
 *   GET /v2/voices. Model `eleven_flash_v2_5`: low latency, reads Chinese.
 * - Inworld: POST /tts/v1/voice, `Authorization: Basic <key>` (the key from the portal is already Base64); the audio
 *   comes back as Base64 in `audioContent`, a WAV with LINEAR16. Voices from GET /voices/v1/voices.
 * - Boson AI: POST /v1/audio/speech (OpenAI-like), Bearer key, model `higgs-tts-3`, `response_format: "wav"`.
 *   The presets are listed in its docs, not by its API (GET /v1/audio/voices lists only the user's own voices).
 *   It has no speed field: pace is an inline tag, as Robin did it.
 */
import { VoiceError } from "./model-process.ts";

export const CLOUD_PROVIDERS = ["elevenlabs", "inworld", "boson"] as const;
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];
export const isCloudProvider = (value: string): value is CloudProvider => (CLOUD_PROVIDERS as readonly string[]).includes(value);

/** A voice a service offers. `lang` is the language it is made for; `any` reads whatever it is given. */
export interface CloudVoice { id: string; name: string; engine: CloudProvider; lang: "zh" | "en" | "any" }

export interface SynthesisRequest {
  text: string;
  /** The service's own voice id. */
  voice: string;
  /** 0.7–1.5. */
  rate: number;
  /** What the text is in, when it is clear. */
  lang: "zh" | "en";
}

type Fetch = typeof fetch;

export interface CloudAdapter {
  id: CloudProvider;
  name: string;
  /** Where the user gets a key. */
  keyUrl: string;
  /** The env variable read when no key was saved. */
  env: string;
  voices(key: string, fetcher: Fetch, signal: AbortSignal): Promise<CloudVoice[]>;
  synthesize(key: string, request: SynthesisRequest, fetcher: Fetch, signal: AbortSignal): Promise<Buffer>;
}

/** At most this much audio back for one request (a few sentences is well under a megabyte). */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/** The service's refusal, without echoing anything of the request. */
async function refused(service: string, response: Response): Promise<never> {
  let detail = "";
  try {
    const body = await response.text();
    const parsed = JSON.parse(body) as { detail?: { message?: unknown } | unknown; message?: unknown; error?: { message?: unknown } | unknown };
    const message = (parsed.detail as { message?: unknown })?.message ?? parsed.message ?? (parsed.error as { message?: unknown })?.message ?? parsed.detail ?? parsed.error;
    if (typeof message === "string") detail = `: ${message.slice(0, 200)}`;
  } catch { /* no readable reason */ }
  const code = response.status === 401 || response.status === 403 ? "unavailable" : "failed";
  throw new VoiceError(code, `${service} said ${response.status}${detail}`);
}

async function audio(service: string, response: Response): Promise<Buffer> {
  if (!response.ok) return refused(service, response);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_AUDIO_BYTES) throw new VoiceError("failed", `${service} sent too much audio`);
  return wavOnly(service, bytes);
}

function wavOnly(service: string, bytes: Buffer): Buffer {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new VoiceError("failed", `${service} did not send a WAV`);
  }
  return bytes;
}

async function json<T>(service: string, response: Response): Promise<T> {
  if (!response.ok) return refused(service, response);
  return await response.json() as T;
}

export const elevenlabs: CloudAdapter = {
  id: "elevenlabs", name: "ElevenLabs", keyUrl: "https://elevenlabs.io/app/settings/api-keys", env: "ELEVENLABS_API_KEY",
  async voices(key, fetcher, signal) {
    const found: CloudVoice[] = [];
    let token: string | null = null;
    // The user's own voices and the shared ones in their library; a few pages at most.
    for (let page = 0; page < 5; page++) {
      const url = new URL("https://api.elevenlabs.io/v2/voices");
      url.searchParams.set("page_size", "100");
      url.searchParams.set("include_total_count", "false");
      if (token) url.searchParams.set("next_page_token", token);
      const body = await json<{ voices: Array<{ voice_id: string; name: string; labels?: Record<string, string>; verified_languages?: Array<{ language?: string }> }>; has_more?: boolean; next_page_token?: string | null }>(
        "ElevenLabs", await fetcher(url, { headers: { "xi-api-key": key }, signal }));
      for (const voice of body.voices ?? []) {
        const languages = [voice.labels?.language, ...(voice.verified_languages ?? []).map((item) => item.language)].filter(Boolean).map((item) => item!.toLowerCase());
        const lang = languages.some((item) => item.startsWith("zh") || item.includes("chinese") || item.includes("mandarin")) ? "zh"
          : languages.length && languages.every((item) => item.startsWith("en")) ? "en" : "any";
        found.push({ id: `elevenlabs:${voice.voice_id}`, name: voice.name, engine: "elevenlabs", lang });
      }
      if (!body.has_more || !body.next_page_token) break;
      token = body.next_page_token;
    }
    return found;
  },
  async synthesize(key, request, fetcher, signal) {
    const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(request.voice)}`);
    url.searchParams.set("output_format", "wav_24000");
    return audio("ElevenLabs", await fetcher(url, {
      method: "POST", signal,
      headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/wav" },
      // Its speed goes from 0.7 to 1.2.
      body: JSON.stringify({ text: request.text, model_id: "eleven_flash_v2_5", voice_settings: { speed: Math.min(1.2, Math.max(0.7, request.rate)) } }),
    }));
  },
};

export const inworld: CloudAdapter = {
  id: "inworld", name: "Inworld", keyUrl: "https://platform.inworld.ai/", env: "INWORLD_API_KEY",
  async voices(key, fetcher, signal) {
    const url = new URL("https://api.inworld.ai/voices/v1/voices");
    url.searchParams.set("filter", `lang_code = "zh" OR lang_code = "en"`);
    url.searchParams.set("pageSize", "500");
    const body = await json<{ voices?: Array<{ voiceId: string; displayName?: string; languageCode?: string; langCode?: string }> }>(
      "Inworld", await fetcher(url, { headers: { Authorization: `Basic ${key}` }, signal }));
    return (body.voices ?? []).map((voice) => {
      const code = (voice.languageCode ?? voice.langCode ?? "").toLowerCase();
      return { id: `inworld:${voice.voiceId}`, name: voice.displayName || voice.voiceId, engine: "inworld" as const, lang: code.startsWith("zh") ? "zh" as const : code.startsWith("en") ? "en" as const : "any" as const };
    });
  },
  async synthesize(key, request, fetcher, signal) {
    const response = await fetcher("https://api.inworld.ai/tts/v1/voice", {
      method: "POST", signal,
      headers: { Authorization: `Basic ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: request.text, voiceId: request.voice, modelId: "inworld-tts-2", language: request.lang === "zh" ? "zh-CN" : "en-US",
        audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 24000, speakingRate: request.rate },
      }),
    });
    const body = await json<{ audioContent?: string }>("Inworld", response);
    if (typeof body.audioContent !== "string") throw new VoiceError("failed", "Inworld sent no audio");
    if (body.audioContent.length > MAX_AUDIO_BYTES * 1.4) throw new VoiceError("failed", "Inworld sent too much audio");
    return wavOnly("Inworld", Buffer.from(body.audioContent, "base64"));
  },
};

/** Boson's presets (its docs' voices page): American English voices, but the model reads Chinese in them too. */
const BOSON_PRESETS = ["chloe", "eleanor", "nora", "jake", "marcus", "oliver"];

export const boson: CloudAdapter = {
  id: "boson", name: "Boson AI", keyUrl: "https://www.boson.ai/workspace/api-key", env: "BOSON_API_KEY",
  async voices(key, fetcher, signal) {
    const presets: CloudVoice[] = BOSON_PRESETS.map((name) => ({ id: `boson:${name}`, name: name[0]!.toUpperCase() + name.slice(1), engine: "boson", lang: "any" }));
    // The user's own voices (made from a recording); the presets are not in this list.
    const body = await json<{ data?: Array<{ voice_id: string; title?: string }> }>(
      "Boson AI", await fetcher("https://api.boson.ai/v1/audio/voices", { headers: { Authorization: `Bearer ${key}` }, signal }));
    return [...presets, ...(body.data ?? []).map((voice) => ({ id: `boson:${voice.voice_id}`, name: voice.title || voice.voice_id, engine: "boson" as const, lang: "any" as const }))];
  },
  async synthesize(key, request, fetcher, signal) {
    // No speed field: a pace tag at the start, as its docs and Robin did.
    const pace = request.rate <= 0.9 ? "<|prosody:speed_slow|>" : request.rate >= 1.15 ? "<|prosody:speed_fast|>" : "";
    return audio("Boson AI", await fetcher("https://api.boson.ai/v1/audio/speech", {
      method: "POST", signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "higgs-tts-3", input: `${pace}${request.text}`, voice: request.voice, response_format: "wav", stream: false }),
    }));
  },
};

export const CLOUD_ADAPTERS: Record<CloudProvider, CloudAdapter> = { elevenlabs, inworld, boson };
