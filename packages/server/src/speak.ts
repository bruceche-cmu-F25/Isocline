/** Text to speech on the home node (docs/design/voice.md §2). Devices only play what they are sent: a phone needs
 * no voice of its own, and every device sounds the same.
 *
 * Three kinds of voice:
 * - the Mac's own (`say`): nothing to download, a sentence in about half a second; the default, and what is used
 *   whenever a service fails, so a reply is never left unsaid.
 * - a speech service on the web (ElevenLabs, Inworld, Boson AI; speak-cloud.ts) with the user's own key, kept in
 *   the keychain: the best voices, but the text read goes to that service.
 * - a local model (Qwen3-TTS 0.6B on MLX, about 2 GB, downloaded only when the user asks): sounds more like a
 *   person, takes about three seconds to a sentence and about 5 GB while loaded, so it runs in a worker that is
 *   started when wanted and stopped after a while unused, like the speech-to-text one.
 * Both were measured on Isocline's kind of sentences, Chinese with English in it (docs/design/voice.md §6).
 *
 * A voice is named `system:<name>`, `model:<name>`, or `<service>:<the service's voice id>`.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { SecretStore } from "@isocline/core";
import { ModelProcess, VoiceError } from "./model-process.ts";
import { CLOUD_ADAPTERS, CLOUD_PROVIDERS, isCloudProvider, type CloudAdapter, type CloudProvider, type CloudVoice } from "./speak-cloud.ts";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..", "voice", "speak.py");
export const SPEAK_MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit";
export const DEFAULT_SPEAK_MODEL_COMMAND = [
  "uv", "run", "--no-project", "--python", "3.12", "--with", "mlx-audio==0.6.7", "--with", "soundfile", "python", "-I", WORKER, SPEAK_MODEL,
];
/** One request is a sentence or a few; a device splits longer text and asks for it piece by piece. */
export const MAX_SPEAK_CHARS = 600;

export interface VoiceInfo {
  id: string;
  name: string;
  engine: "system" | "model" | CloudProvider;
  /** The language it speaks best; `any`: whatever it is given. */
  lang: "zh" | "en" | "any";
}

/** A speech service, as the Voice settings show it. */
export interface ProviderStatus {
  id: CloudProvider;
  name: string;
  keyUrl: string;
  /** Where its key comes from: saved here, an environment variable, or none yet. */
  key: "saved" | "env" | null;
  /** Why its voices could not be listed (a key it refused, no network). */
  error: string | null;
}

export interface SpeakStatus {
  available: boolean;
  /** Why not, when it is not. */
  reason: string | null;
  voices: VoiceInfo[];
  /** The local model: not downloaded; downloading or loading now; downloaded and stopped; loaded. Null where it
   * cannot run (not a Mac with Apple silicon, or no uv). */
  model: "absent" | "loading" | "ready" | "loaded" | null;
  /** About how much the model takes to download. */
  modelBytes: number;
  providers: ProviderStatus[];
}

/** The model's own voices: the Chinese ones first. */
const MODEL_VOICES: VoiceInfo[] = [
  ...["Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric"].map((name) => ({ id: `model:${name}`, name: name.replace("_", " "), engine: "model" as const, lang: "zh" as const })),
  ...["Ryan", "Aiden"].map((name) => ({ id: `model:${name}`, name, engine: "model" as const, lang: "en" as const })),
];
/** The Mac's novelty voices (bells, whispers, robots): not voices to be told things in. */
const NOVELTY = new Set(["Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Good News", "Jester", "Organ",
  "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox", "Fred", "Junior", "Kathy", "Ralph"]);
/** First choice of system voice for each language, when it is there: Ana speaks in a woman's voice, Kata in a man's
 * (docs/design/rename-isocline.md §4). The rest of a character's list is what to try when the first is missing. */
export type Character = "ana" | "kata";
const PREFERRED_BY: Record<Character, Record<"zh" | "en", string[]>> = {
  ana: { zh: ["Tingting", "Flo (Chinese (China mainland))", "Shelley (Chinese (China mainland))"], en: ["Samantha", "Flo (English (US))", "Shelley (English (US))"] },
  kata: { zh: ["Eddy (Chinese (China mainland))", "Reed (Chinese (China mainland))", "Rocko (Chinese (China mainland))"], en: ["Daniel", "Eddy (English (US))", "Reed (English (US))"] },
};
const PREFERRED: Record<"zh" | "en", string> = { zh: PREFERRED_BY.ana.zh[0]!, en: PREFERRED_BY.ana.en[0]! };

/** `say -v '?'` lines: `Tingting             zh_CN    # 你好！我叫婷婷。` or `Eddy (Chinese (China mainland)) zh_CN    # …`. */
export function parseSystemVoices(listing: string): VoiceInfo[] {
  const voices: VoiceInfo[] = [];
  for (const line of listing.split("\n")) {
    const match = /^(.+?)\s+([a-z]{2,3})_([A-Za-z0-9]+)\s+#/.exec(line);
    if (!match) continue;
    const [, name, language, region] = match;
    if (NOVELTY.has(name!)) continue;
    // Mainland Chinese and the English ones; the app speaks those two.
    if (language === "zh" && region === "CN") voices.push({ id: `system:${name}`, name: name!, engine: "system", lang: "zh" });
    else if (language === "en") voices.push({ id: `system:${name}`, name: name!, engine: "system", lang: "en" });
  }
  // The preferred voice first in its language, then by name.
  const rank = (voice: VoiceInfo) => (voice.lang !== "any" && PREFERRED[voice.lang] === voice.name ? 0 : 1);
  return voices.sort((a, b) => a.lang.localeCompare(b.lang) || rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export interface SpeakerOptions {
  /** The model worker (tests pass a fake). Default: Qwen3-TTS through uv. */
  modelCommand?: string[];
  /** How to run the Mac's `say` (tests pass a fake). */
  sayCommand?: string;
  /** Whether the model is on disk. Default: looks in the Hugging Face cache. */
  modelPresent?: () => boolean;
  /** Where the services' keys are kept (`voice:<service>`). Without one, no service can be used. */
  secrets?: SecretStore;
  /** For the services (tests pass a fake). */
  fetch?: typeof fetch;
  /** Read for a service's key when none was saved (ELEVENLABS_API_KEY, INWORLD_API_KEY, BOSON_API_KEY). */
  env?: Record<string, string | undefined>;
  /** Stop the model after this long without use. Default 10 minutes. */
  idleMs?: number;
  /** Give up on one request after this long, loading included. Default 2 minutes. */
  timeoutMs?: number;
  log?: (message: string) => void;
}

export interface SpeakRequest {
  text: string;
  /** `system:<name>` or `model:<name>`; null or unknown: the default for the language. */
  voice?: string | null;
  /** 0.7–1.5; 1 is the voice's own pace. */
  rate?: number;
  /** The app's language: the default voice for text in neither Chinese nor a Latin script. */
  locale: "zh" | "en";
  /** Whose voice the default is: Ana's (a woman's) or Kata's (a man's). */
  character?: Character;
}

/** Where Hugging Face keeps a model, if it has it. */
function modelOnDisk(repo: string): boolean {
  const hub = process.env.HF_HUB_CACHE ?? join(process.env.HF_HOME ?? join(homedir(), ".cache", "huggingface"), "hub");
  const snapshots = join(hub, `models--${repo.replace("/", "--")}`, "snapshots");
  try {
    return readdirSync(snapshots).some((snapshot) => existsSync(join(snapshots, snapshot, "model.safetensors")) || existsSync(join(snapshots, snapshot, "model.safetensors.index.json")));
  } catch {
    return false;
  }
}

export class Speaker {
  private readonly modelCommand: string[];
  private readonly say: string;
  private readonly modelPresent: () => boolean;
  private readonly model: ModelProcess;
  /** Set while the model is being got ready on the user's word. */
  private installing: Promise<void> | null = null;
  private dir: Promise<string> | null = null;
  private seq = 0;
  private systemVoices: Promise<VoiceInfo[]> | null = null;
  private reason: Promise<string | null> | null = null;
  private modelReason: Promise<string | null> | null = null;
  private readonly log: (message: string) => void;
  private readonly secrets: SecretStore | undefined;
  private readonly fetcher: typeof fetch;
  private readonly env: Record<string, string | undefined>;
  /** Each service's voices, for the key they were listed with, kept a while. */
  private readonly cloudVoices = new Map<CloudProvider, { key: string; at: number; voices: CloudVoice[]; error: string | null }>();

  constructor(options: SpeakerOptions = {}) {
    this.secrets = options.secrets;
    this.fetcher = options.fetch ?? fetch;
    this.env = options.env ?? process.env;
    this.modelCommand = options.modelCommand ?? DEFAULT_SPEAK_MODEL_COMMAND;
    this.say = options.sayCommand ?? "/usr/bin/say";
    this.modelPresent = options.modelPresent ?? (() => modelOnDisk(SPEAK_MODEL));
    this.log = options.log ?? (() => {});
    this.model = new ModelProcess({
      command: this.modelCommand, label: "voice model", idleMs: options.idleMs ?? 10 * 60_000,
      timeoutMs: options.timeoutMs ?? 120_000, maxPending: 6, log: this.log,
    });
  }

  /** Why nothing can be spoken here, or null. */
  unavailable(): Promise<string | null> {
    this.reason ??= (async () => (existsSync(this.say) ? null : "Speaking needs a Mac (the system's say command)"))();
    return this.reason;
  }

  private modelUnavailable(): Promise<string | null> {
    this.modelReason ??= (async () => {
      if (this.modelCommand !== DEFAULT_SPEAK_MODEL_COMMAND) return null;
      if (process.platform !== "darwin" || process.arch !== "arm64") return "The voice model needs a Mac with Apple silicon";
      const found = await promisify(execFile)("which", ["uv"]).then(() => true, () => false);
      return found ? null : "The voice model needs uv (brew install uv)";
    })();
    return this.modelReason;
  }

  async status(): Promise<SpeakStatus> {
    const reason = await this.unavailable();
    const system = reason ? [] : await this.voicesOfSystem();
    const modelReason = await this.modelUnavailable();
    const present = !modelReason && this.modelPresent();
    const model = modelReason ? null : this.model.loaded ? "loaded" : this.installing || this.model.running ? "loading" : present ? "ready" : "absent";
    const providers: ProviderStatus[] = [];
    const cloud: VoiceInfo[] = [];
    for (const id of CLOUD_PROVIDERS) {
      const adapter = CLOUD_ADAPTERS[id];
      const key = await this.key(id);
      const listed = key ? await this.listCloud(id, key.value) : null;
      providers.push({ id, name: adapter.name, keyUrl: adapter.keyUrl, key: key?.source ?? null, error: listed?.error ?? null });
      cloud.push(...(listed?.voices ?? []));
    }
    return {
      available: !reason, reason, model, modelBytes: 2_000_000_000, providers,
      voices: [...system, ...(present || model === "loaded" ? MODEL_VOICES : []), ...cloud],
    };
  }

  /** Saves a service's key, once the service has taken it (it lists its voices with it). */
  async setKey(provider: CloudProvider, key: string): Promise<void> {
    if (!this.secrets) throw new VoiceError("unavailable", "Keys cannot be kept on this node");
    const trimmed = key.trim();
    if (!trimmed || trimmed.length > 500 || /\s/.test(trimmed)) throw new VoiceError("failed", "That does not look like a key");
    this.cloudVoices.delete(provider);
    const listed = await this.listCloud(provider, trimmed, true);
    if (listed.error) {
      this.cloudVoices.delete(provider);
      // Said in the log too (never the key): the page may be closed before the user reads it.
      this.log(`voice: ${CLOUD_ADAPTERS[provider].name} did not take the key: ${listed.error}`);
      throw new VoiceError("unavailable", listed.error);
    }
    await this.secrets.set(`voice:${provider}`, trimmed);
    this.log(`voice: ${CLOUD_ADAPTERS[provider].name} connected`);
  }

  async removeKey(provider: CloudProvider): Promise<void> {
    await this.secrets?.delete(`voice:${provider}`);
    this.cloudVoices.delete(provider);
  }

  private async key(provider: CloudProvider): Promise<{ value: string; source: "saved" | "env" } | null> {
    const saved = await this.secrets?.get(`voice:${provider}`).catch(() => undefined);
    if (saved) return { value: saved, source: "saved" };
    const env = this.env[CLOUD_ADAPTERS[provider].env];
    return env ? { value: env, source: "env" } : null;
  }

  /** A service's voices, listed again after ten minutes or with another key. */
  private async listCloud(provider: CloudProvider, key: string, fresh = false): Promise<{ voices: CloudVoice[]; error: string | null }> {
    const known = this.cloudVoices.get(provider);
    if (!fresh && known && known.key === key && Date.now() - known.at < 10 * 60_000) return known;
    let entry: { key: string; at: number; voices: CloudVoice[]; error: string | null };
    try {
      entry = { key, at: Date.now(), voices: await CLOUD_ADAPTERS[provider].voices(key, this.fetcher, AbortSignal.timeout(15_000)), error: null };
    } catch (error) {
      // A failure is listed again sooner: the network may be back in a minute.
      entry = { key, at: Date.now() - 9 * 60_000, voices: [], error: error instanceof Error ? error.message : String(error) };
    }
    this.cloudVoices.set(provider, entry);
    return entry;
  }

  /** Download (if need be) and load the model; returns at once. */
  install(): void {
    if (this.installing || this.model.running) return;
    this.installing = this.modelUnavailable().then(async (why) => {
      if (why) throw new VoiceError("unavailable", why);
      this.log("voice: getting the voice model ready");
      this.model.warm();
    }).catch((error) => this.log(`voice: ${error instanceof Error ? error.message : error}`))
      .finally(() => { this.installing = null; });
  }

  /** Start loading the model when the chosen voice is one of its; returns at once. */
  warm(voice: string | null | undefined): void {
    if (voice?.startsWith("model:") && this.modelPresent()) this.install();
  }

  /** The voice that will be used: the one asked for if it is here, else the language's default. */
  async pick(voice: string | null | undefined, locale: "zh" | "en", character: Character = "ana"): Promise<string> {
    // A service's voice is used while its key is there; the service says whether the voice exists.
    const service = voice ? voice.slice(0, voice.indexOf(":")) : "";
    if (voice && isCloudProvider(service) && voice.length > service.length + 1 && await this.key(service)) return voice;
    if (voice?.startsWith("model:") && MODEL_VOICES.some((known) => known.id === voice) && this.modelPresent()) return voice;
    const system = await this.voicesOfSystem();
    if (voice && system.some((known) => known.id === voice)) return voice;
    const own = system.filter((known) => known.lang === locale);
    const wanted = PREFERRED_BY[character][locale];
    const fallback = wanted.map((name) => own.find((known) => known.name === name)).find(Boolean) ?? own[0] ?? system[0];
    if (!fallback) throw new VoiceError("unavailable", "No voice to speak with");
    return fallback.id;
  }

  /** The words as 16-bit PCM WAV. */
  async speak(request: SpeakRequest): Promise<Buffer> {
    const why = await this.unavailable();
    if (why) throw new VoiceError("unavailable", why);
    const text = request.text.replace(/\s+/g, " ").trim();
    if (!text) throw new VoiceError("failed", "Nothing to say");
    if (text.length > MAX_SPEAK_CHARS) throw new VoiceError("failed", `At most ${MAX_SPEAK_CHARS} characters at a time`);
    const rate = Math.min(1.5, Math.max(0.7, request.rate ?? 1));
    // With no voice of the user's choosing, the text's own language picks: an English app still reads Chinese in a
    // Chinese voice.
    const language = /\p{Script=Han}/u.test(text) ? "zh" : /\p{Script=Latin}/u.test(text) ? "en" : request.locale;
    const voice = await this.pick(request.voice, language, request.character);
    this.dir ??= mkdtemp(join(tmpdir(), "isocline-speak-"));
    const out = join(await this.dir, `${++this.seq}.wav`);
    try {
      const [engine, name] = [voice.slice(0, voice.indexOf(":")), voice.slice(voice.indexOf(":") + 1)];
      if (isCloudProvider(engine)) {
        try {
          return await this.speakCloud(CLOUD_ADAPTERS[engine], { text, voice: name, rate, lang: language === "zh" ? "zh" : "en" });
        } catch (error) {
          // A service that fails (no credit, no network) does not leave a reply unsaid: the Mac's voice reads it.
          this.log(`voice: ${CLOUD_ADAPTERS[engine].name} failed, the system voice reads it: ${error instanceof Error ? error.message : error}`);
          await this.sayTo(out, (await this.pick(null, language, request.character)).slice("system:".length), text, rate);
        }
      } else if (engine === "model") {
        const lang = /\p{Script=Han}/u.test(text) ? "Chinese" : "English";
        await this.model.call({ text, voice: name, speed: rate, lang, out });
      } else {
        await this.sayTo(out, name, text, rate);
      }
      return await readFile(out);
    } finally {
      await rm(out, { force: true });
    }
  }

  private async speakCloud(adapter: CloudAdapter, request: { text: string; voice: string; rate: number; lang: "zh" | "en" }): Promise<Buffer> {
    const key = await this.key(adapter.id);
    if (!key) throw new VoiceError("unavailable", `No ${adapter.name} key`);
    return adapter.synthesize(key.value, request, this.fetcher, AbortSignal.timeout(20_000));
  }

  close(): void {
    this.model.close();
    const dir = this.dir;
    this.dir = null;
    void dir?.then((path) => rm(path, { recursive: true, force: true })).catch(() => {});
  }

  private voicesOfSystem(): Promise<VoiceInfo[]> {
    this.systemVoices ??= promisify(execFile)(this.say, ["-v", "?"]).then(({ stdout }) => parseSystemVoices(stdout), () => []);
    return this.systemVoices;
  }

  /** The text goes in on stdin: it may start with a dash, and it is the user's. */
  private sayTo(out: string, voice: string, text: string, rate: number): Promise<void> {
    // The system voices speak at about 180 words a minute.
    const args = ["-v", voice, "--file-format=WAVE", "--data-format=LEI16@24000", "-o", out, ...(rate !== 1 ? ["-r", String(Math.round(180 * rate))] : []), "-f", "-"];
    return new Promise((resolve, reject) => {
      const child = spawn(this.say, args, { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      const timer = setTimeout(() => { child.kill(); reject(new VoiceError("failed", "Speaking took too long")); }, 30_000);
      child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-500); });
      child.on("error", (error) => { clearTimeout(timer); reject(new VoiceError("unavailable", `Could not speak: ${error.message}`)); });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(); else reject(new VoiceError("failed", `Could not speak (${code}): ${stderr.trim()}`));
      });
      child.stdin.end(text);
    });
  }
}
