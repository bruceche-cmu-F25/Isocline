/** Speech to text on the home node. Every device only records; the words are worked out here, so a phone needs no
 * model, keys never leave this machine, and every device gets the same quality.
 *
 * The model (Qwen3-ASR 0.6B on MLX, see docs/research/voice-input.md §6.1) runs in a worker process that is started
 * when someone starts talking (`warm`), so loading overlaps with the speaking, and stopped after a while unused:
 * it holds about 1.5 GB while loaded and nothing otherwise.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ModelProcess, VoiceError } from "./model-process.ts";

export { VoiceError };

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..", "voice", "transcribe.py");
export const DEFAULT_VOICE_COMMAND = [
  "uv", "run", "--no-project", "--python", "3.12", "--with", "mlx-qwen3-asr==0.4.4", "python", "-I", WORKER, "Qwen/Qwen3-ASR-0.6B",
];
/** Five minutes of 16 kHz 16-bit mono, and a little. */
export const MAX_VOICE_BYTES = 10 * 1024 * 1024;

export interface Transcript { text: string; ms: number }

export interface TranscriberOptions {
  /** The worker to run (tests pass a fake). Default: Qwen3-ASR through uv. */
  command?: string[];
  /** Unload after this long without use. Default 10 minutes. */
  idleMs?: number;
  /** Give up on one recording after this long (loading included). Default 2 minutes. */
  timeoutMs?: number;
  log?: (message: string) => void;
}

export class Transcriber {
  private readonly command: string[];
  private readonly model: ModelProcess;
  private dir: Promise<string> | null = null;
  private seq = 0;
  private reason: Promise<string | null> | null = null;

  constructor(options: TranscriberOptions = {}) {
    this.command = options.command ?? DEFAULT_VOICE_COMMAND;
    this.model = new ModelProcess({
      command: this.command, label: "speech model", idleMs: options.idleMs ?? 10 * 60_000, timeoutMs: options.timeoutMs ?? 120_000, log: options.log,
    });
  }

  /** Why voice cannot work on this machine, or null when it can. */
  unavailable(): Promise<string | null> {
    this.reason ??= (async () => {
      if (this.command !== DEFAULT_VOICE_COMMAND) return null;
      if (process.platform !== "darwin" || process.arch !== "arm64") return "Voice input needs a Mac with Apple silicon";
      const found = await promisify(execFile)("which", ["uv"]).then(() => true, () => false);
      return found ? null : "Voice input needs uv (brew install uv)";
    })();
    return this.reason;
  }

  /** Whether the model is loaded, or loading, now. */
  get loaded(): boolean { return this.model.running; }

  /** Start loading the model if it is not loaded; returns at once. */
  warm(): void {
    void this.unavailable().then((why) => { if (!why) this.model.warm(); });
  }

  /** `context`: words the speaker is likely to use (names, terms), which helps the model spell them. */
  async transcribe(wav: Buffer, context = ""): Promise<Transcript> {
    const why = await this.unavailable();
    if (why) throw new VoiceError("unavailable", why);
    this.dir ??= mkdtemp(join(tmpdir(), "zirma-voice-"));
    const file = join(await this.dir, `${++this.seq}.wav`);
    try {
      const answer = await this.model.call({ wav: file, context }, () => writeFile(file, wav));
      return { text: typeof answer.text === "string" ? answer.text : "", ms: typeof answer.ms === "number" ? answer.ms : 0 };
    } finally {
      await rm(file, { force: true });
    }
  }

  close(): void {
    this.model.close();
    const dir = this.dir;
    this.dir = null;
    void dir?.then((path) => rm(path, { recursive: true, force: true })).catch(() => {});
  }
}
