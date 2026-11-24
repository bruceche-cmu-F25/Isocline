/** Text to speech on the home node (docs/design/voice.md §2). Devices only play what they are sent: a phone needs
 * no voice of its own, and every device sounds the same.
 *
 * Two kinds of voice:
 * - the Mac's own (`say`): nothing to download, a sentence in about half a second; the default.
 * - a local model (Qwen3-TTS 0.6B on MLX, about 2 GB, downloaded only when the user asks): sounds more like a
 *   person, takes about three seconds to a sentence and about 5 GB while loaded, so it runs in a worker that is
 *   started when wanted and stopped after a while unused, like the speech-to-text one.
 * Both were measured on Isocline's kind of sentences, Chinese with English in it (docs/design/voice.md §6).
 *
 * A voice is named `system:<name>` or `model:<name>`.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ModelProcess, VoiceError } from "./model-process.ts";

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
  engine: "system" | "model";
  /** The language it speaks best. */
  lang: "zh" | "en";
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
  const rank = (voice: VoiceInfo) => (PREFERRED[voice.lang] === voice.name ? 0 : 1);
  return voices.sort((a, b) => a.lang.localeCompare(b.lang) || rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export interface SpeakerOptions {
  /** The model worker (tests pass a fake). Default: Qwen3-TTS through uv. */
  modelCommand?: string[];
  /** How to run the Mac's `say` (tests pass a fake). */
  sayCommand?: string;
  /** Whether the model is on disk. Default: looks in the Hugging Face cache. */
  modelPresent?: () => boolean;
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

  constructor(options: SpeakerOptions = {}) {
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
    return {
      available: !reason, reason, model, modelBytes: 2_000_000_000,
      voices: [...system, ...(present || model === "loaded" ? MODEL_VOICES : [])],
    };
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
      if (engine === "model") {
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
