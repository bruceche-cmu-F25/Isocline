/** Runs an engine in worker processes, so a heavy or crashing model turn never
 * stalls or takes down the home node.
 *
 * Sessions stay warm, as in Pi Web: a worker keeps each conversation's Pi
 * session (and its MCP connections) open between turns, and the next turn of
 * that conversation goes back to the same worker. If that worker is busy with
 * another conversation, it lets go of this one and another worker opens it from
 * its session file; only one worker ever holds a conversation. Workers idle for
 * a while close their sessions properly and exit.
 */
import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { EngineModel, EnginePort, RunTool } from "@zirma/core";
import { composeHistory, type RunJob, type ToParent, type ToWorker } from "./protocol.ts";

export class EngineCrashedError extends Error {
  override name = "EngineCrashedError";
}

export interface WorkerEngineOptions {
  /** The worker module to run. */
  worker: string;
  /** Arguments for the worker (e.g. where sessions live). */
  args?: string[];
  /** A worker idle this long closes its sessions and exits. */
  idleMs?: number;
  /** After asking a worker to stop a run or to exit, how long before it is killed. */
  abortGraceMs?: number;
  log?: (message: string) => void;
}

interface Worker {
  child: ChildProcess;
  busy: boolean;
  idle: NodeJS.Timeout | null;
  alive: boolean;
  /** Conversations whose sessions this worker holds warm. */
  threads: Set<string>;
}

export interface WorkerEngine extends EnginePort {
  /** Closes every worker's sessions and stops them. */
  close(): Promise<void>;
  /** Workers now running (tests, status). */
  size(): number;
  /** Which worker process holds a conversation's warm session, if any (tests). */
  holder(thread: string): number | undefined;
}

export function createWorkerEngine(options: WorkerEngineOptions): WorkerEngine {
  const idleMs = options.idleMs ?? 10 * 60_000;
  const abortGraceMs = options.abortGraceMs ?? 5000;
  const workers = new Set<Worker>();
  const owner = new Map<string, Worker>();
  /** The run in flight per conversation, for steering. */
  const running = new Map<string, { worker: Worker; run: string }>();

  const send = (worker: Worker, message: ToWorker) => { if (worker.alive && worker.child.connected) worker.child.send(message); };

  const spawn = (): Worker => {
    // The same runtime as the home node (Node, or the Mac app's binary running as Node).
    const child = fork(options.worker, options.args ?? [], {
      execPath: process.execPath, execArgv: [], serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"], env: process.env,
    });
    const worker: Worker = { child, busy: false, idle: null, alive: true, threads: new Set() };
    child.on("exit", (code, signal) => {
      worker.alive = false;
      workers.delete(worker);
      if (worker.idle) clearTimeout(worker.idle);
      for (const thread of worker.threads) if (owner.get(thread) === worker) owner.delete(thread);
      if (worker.busy) options.log?.(`engine worker exited during a run (${signal ?? `code ${code}`})`);
    });
    workers.add(worker);
    return worker;
  };

  /** Asks a worker to close its sessions and exit; kills it if it does not. */
  const stop = (worker: Worker) => new Promise<void>((resolve) => {
    if (!worker.alive) return resolve();
    const timer = setTimeout(() => worker.child.kill("SIGKILL"), abortGraceMs);
    worker.child.once("exit", () => { clearTimeout(timer); resolve(); });
    send(worker, { type: "shutdown" });
    if (!worker.child.connected) worker.child.kill();
  });

  const acquire = (thread: string): Worker => {
    const held = owner.get(thread);
    let worker: Worker | undefined;
    if (held?.alive && !held.busy) worker = held;
    else {
      if (held?.alive) {
        // Its holder is busy with another conversation: it lets go, another opens it from disk.
        send(held, { type: "release", thread });
        held.threads.delete(thread);
      }
      owner.delete(thread);
      worker = [...workers].filter((candidate) => candidate.alive && !candidate.busy).sort((a, b) => a.threads.size - b.threads.size)[0] ?? spawn();
    }
    if (worker.idle) clearTimeout(worker.idle);
    worker.idle = null;
    worker.busy = true;
    worker.threads.add(thread);
    owner.set(thread, worker);
    return worker;
  };

  const release = (worker: Worker) => {
    worker.busy = false;
    if (!worker.alive) return;
    worker.idle = setTimeout(() => void stop(worker), idleMs);
    worker.idle.unref();
  };

  /** One request to a worker that answers by id (models). */
  const ask = <T>(build: (id: string) => ToWorker, match: (message: ToParent, id: string) => T | undefined, ms: number): Promise<T> => {
    const worker = [...workers].find((candidate) => candidate.alive) ?? (() => { const fresh = spawn(); release(fresh); return fresh; })();
    const id = randomBytes(6).toString("hex");
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { worker.child.off("message", onMessage); reject(new Error("The engine did not answer")); }, ms);
      const onMessage = (message: ToParent) => {
        const value = match(message, id);
        if (value === undefined) return;
        clearTimeout(timer);
        worker.child.off("message", onMessage);
        resolve(value);
      };
      worker.child.on("message", onMessage);
      send(worker, build(id));
    });
  };

  return {
    size: () => workers.size,
    holder: (thread) => owner.get(thread)?.child.pid,
    async close() {
      await Promise.all([...workers].map(stop));
      workers.clear();
      owner.clear();
    },

    async models(): Promise<EngineModel[]> {
      const result = await ask(
        (id) => ({ type: "models", id }),
        (message, id) => (message.type === "models_result" && message.id === id ? message : undefined),
        20_000,
      );
      if (result.error) throw new Error(result.error);
      return result.models;
    },

    async steer(thread, text) {
      const current = running.get(thread);
      if (!current?.worker.alive) return false;
      const { worker, run } = current;
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { worker.child.off("message", onMessage); resolve(false); }, 5000);
        const onMessage = (message: ToParent) => {
          if (message.type !== "steered" || message.run !== run) return;
          clearTimeout(timer);
          worker.child.off("message", onMessage);
          resolve(message.ok);
        };
        worker.child.on("message", onMessage);
        send(worker, { type: "steer", run, text });
      });
    },

    submit(request, signal) {
      signal.throwIfAborted();
      const run = randomBytes(6).toString("hex");
      const tools = new Map<string, RunTool>(request.tools.map((tool) => [tool.name, tool]));
      const job: RunJob = {
        thread: request.thread,
        instructions: request.instructions,
        prompt: { today: request.today, ...(request.now ? { now: request.now } : {}), timezone: request.timezone, goal: request.goal, context: request.context },
        history: composeHistory(request),
        tools: request.tools.map((tool) => ({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters })),
        ...(request.model ? { model: request.model } : {}),
        ...(request.thinking ? { thinking: request.thinking } : {}),
        ...(request.speed ? { speed: request.speed } : {}),
        ...(request.locale ? { locale: request.locale } : {}),
        ...(request.workspace ? { workspace: request.workspace } : {}),
        ...(request.attachments?.length ? { attachments: request.attachments } : {}),
        ...(request.turn ? { turn: request.turn } : {}),
        ...(request.after !== undefined ? { after: request.after } : {}),
        ...(request.branched ? { branched: true } : {}),
      };
      const worker = acquire(request.thread);
      running.set(request.thread, { worker, run });
      const to = (message: ToWorker) => send(worker, message);

      return new Promise<{ reply: string }>((resolve, reject) => {
        let settled = false;
        let killTimer: NodeJS.Timeout | null = null;
        const finish = (outcome: () => void) => {
          if (settled) return;
          settled = true;
          worker.child.off("message", onMessage);
          worker.child.off("exit", onExit);
          signal.removeEventListener("abort", onAbort);
          if (killTimer) clearTimeout(killTimer);
          if (running.get(request.thread)?.run === run) running.delete(request.thread);
          release(worker);
          outcome();
        };
        const onMessage = (message: ToParent) => {
          // Buffered IPC can arrive between SIGKILL and exit. Only exit may settle this run now,
          // otherwise a late reply would release the dying worker for the next turn.
          if (worker.child.killed || !("run" in message) || message.run !== run) return;
          if (message.type === "text") request.onText?.(message.text);
          else if (message.type === "usage") request.onUsage?.(message.usage);
          else if (message.type === "done") finish(() => resolve({ reply: message.reply }));
          else if (message.type === "error") finish(() => reject(Object.assign(new Error(message.message), message.code ? { name: message.code } : {})));
          else if (message.type === "step") request.external.step(message.step);
          else if (message.type === "receipt") request.external.receipt({ tool: message.tool, label: message.label, about: message.about });
          else if (message.type === "changed") request.external.changed?.(message.file);
          else if (message.type === "allow") {
            // Anything but an explicit yes, including a failure to ask, is a no.
            request.external.allow(message.question, { detail: message.detail, inProject: message.inProject, command: message.command })
              .catch(() => "deny" as const)
              .then((answer) => to({ type: "allow_result", run, call: message.call, allowed: answer === "allow" || answer === "always" }));
          } else if (message.type === "tool") {
            const tool = tools.get(message.name);
            if (!tool) { to({ type: "tool_result", run, call: message.call, ok: false, error: `Unknown tool ${message.name}` }); return; }
            // Runs here, in the home node: steps, permission and the run's lease apply.
            Promise.resolve()
              .then(() => tool.execute(message.params, signal))
              .then((text) => to({ type: "tool_result", run, call: message.call, ok: true, text: String(text) }))
              .catch((error: unknown) => to({ type: "tool_result", run, call: message.call, ok: false, error: error instanceof Error ? error.message : String(error) }));
          }
        };
        const onExit = () => finish(() => reject(signal.aborted ? signal.reason ?? new Error("aborted") : new EngineCrashedError("The engine process exited during the run")));
        const onAbort = () => {
          to({ type: "abort", run });
          // A worker that does not stop is killed; its run ends as aborted, not crashed.
          killTimer = setTimeout(() => worker.child.kill("SIGKILL"), abortGraceMs);
        };
        worker.child.on("message", onMessage);
        worker.child.on("exit", onExit);
        signal.addEventListener("abort", onAbort, { once: true });
        to({ type: "run", run, job });
      });
    },
  };
}
