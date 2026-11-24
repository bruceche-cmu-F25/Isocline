/** A local model kept in a worker process while it is wanted: speech to text (voice.ts) and text to speech
 * (speak.ts) both run one. The process is started on first use (or `warm`), so loading overlaps with whatever the
 * user is doing, and stopped after a while unused, so a model holds memory only while it is in use.
 *
 * Protocol, one JSON object per line:
 *   out  {"ready": true}                        once the model is loaded
 *   in   {"id": "...", ...job}
 *   out  {"id": "...", ...answer}  or  {"id": "...", "error": "..."}
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export class VoiceError extends Error {
  readonly code: "unavailable" | "failed" | "busy";
  constructor(code: VoiceError["code"], message: string) { super(message); this.name = "VoiceError"; this.code = code; }
}

export interface ModelProcessOptions {
  command: string[];
  /** What it is, for the log and for errors ("speech model", "voice model"). */
  label: string;
  /** Stop after this long without use. */
  idleMs: number;
  /** Give up on one job after this long, loading included. */
  timeoutMs: number;
  /** At most this many jobs waiting at once; more are refused as busy. */
  maxPending?: number;
  log?: (message: string) => void;
}

type Pending = { resolve: (answer: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class ModelProcess {
  private readonly options: Required<ModelProcessOptions>;
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private started = false;
  private readonly pending = new Map<string, Pending>();
  /** Jobs that have arrived and are not answered yet, counting one still waiting for the model to load. */
  private working = 0;
  private idle: NodeJS.Timeout | null = null;
  private seq = 0;

  constructor(options: ModelProcessOptions) {
    this.options = { ...options, maxPending: options.maxPending ?? 4, log: options.log ?? (() => {}) };
  }

  /** Whether the model is loaded and answering now. */
  get loaded(): boolean { return this.started; }
  /** Whether it is starting or loaded. */
  get running(): boolean { return !!this.ready; }

  /** Start loading if it is not loaded; returns at once. A failure shows on the next job. Loading counts as work,
   * so a slow first download is not stopped as idle. */
  warm(): void {
    this.working++;
    void this.start().catch(() => {}).finally(() => { this.working--; this.touch(); });
    this.touch();
  }

  /** Runs one job; `before` runs first, inside the count that keeps the process from being stopped as idle. */
  async call(job: Record<string, unknown>, before?: () => Promise<void>): Promise<Record<string, unknown>> {
    if (this.pending.size >= this.options.maxPending) throw new VoiceError("busy", "Still working on earlier requests");
    this.working++;
    try {
      await before?.();
      await this.start();
      const id = String(++this.seq);
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new VoiceError("failed", `The ${this.options.label} took too long`));
        }, this.options.timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        this.child!.stdin.write(JSON.stringify({ ...job, id }) + "\n");
      });
    } finally {
      this.working--;
      this.touch();
    }
  }

  close(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.stop("closed");
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const [command, ...args] = this.options.command;
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    const began = Date.now();
    this.options.log(`voice: loading the ${this.options.label}`);
    this.ready = new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let message: Record<string, unknown>;
        try { message = JSON.parse(line); } catch { return; }
        if (message.ready) {
          this.options.log(`voice: ${this.options.label} ready in ${Date.now() - began} ms`);
          if (this.child === child) this.started = true;
          resolve();
          return;
        }
        const id = typeof message.id === "string" ? message.id : null;
        const waiting = id ? this.pending.get(id) : undefined;
        if (!waiting || !id) return;
        this.pending.delete(id);
        clearTimeout(waiting.timer);
        if (typeof message.error === "string") waiting.reject(new VoiceError("failed", message.error));
        else waiting.resolve(message);
      });
      child.on("error", (error) => reject(new VoiceError("unavailable", `Could not start the ${this.options.label}: ${error.message}`)));
      child.on("exit", (code) => {
        const why = new VoiceError("failed", `The ${this.options.label} stopped (${code ?? "signal"}): ${stderr.trim().split("\n").slice(-2).join(" ")}`);
        reject(why);
        if (this.child === child) this.stop(why);
      });
    });
    // A failed start must not stick: the next job tries again.
    this.ready.catch(() => { if (this.child === child) this.stop("start failed"); });
    return this.ready;
  }

  private stop(reason: string | Error): void {
    const child = this.child;
    this.child = null;
    this.ready = null;
    this.started = false;
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(reason instanceof Error ? reason : new VoiceError("failed", `The ${this.options.label} was stopped (${reason})`));
      this.pending.delete(id);
    }
    if (child && child.exitCode === null) {
      child.kill();
      this.options.log(`voice: ${this.options.label} unloaded (${reason instanceof Error ? reason.message : reason})`);
    }
  }

  /** Each use pushes the stop back. */
  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    // Not while a job is being worked on, even one the model has not been given yet (it is still loading).
    this.idle = setTimeout(() => { if (!this.working) this.stop("idle"); }, this.options.idleMs);
    this.idle.unref();
  }
}
