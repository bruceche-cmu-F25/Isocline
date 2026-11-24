/** Background processes in a development session (docs/design/dev-mode.md 4.6, D5): a dev server, a watcher, anything
 * that keeps running after the command that started it. Zirma starts one with its `process_start` tool (asked like
 * any shell command), or the user does from the session's panel on this machine; either can stop it and read what it
 * printed. They run in the session's folder, as the user, in their own process group, so stopping one stops what it
 * started too.
 *
 * They are not in the world: they end when the home node stops, and a list of them is only what this process knows.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { newId } from "@zirma/core";
import { plainLines } from "./terminals.ts";

export interface ProcessInfo {
  id: string;
  /** The command as it was given. */
  command: string;
  /** A short name (the dev server), or the command's start. */
  name: string;
  /** Who started it. */
  by: "alfred" | "user";
  startedAt: string;
  /** Null while it runs. */
  exit: number | null;
  endedAt: string | null;
  /** The first local address it printed (a dev server's), for opening it. */
  url: string | null;
}

export class ProcessError extends Error {
  override name = "ProcessError";
  readonly code: "missing" | "invalid" | "too_many";
  constructor(code: ProcessError["code"], message: string) { super(message); this.code = code; }
}

/** `printed`: how many characters it has printed in all, which says whether there is anything new to read. */
interface Running extends ProcessInfo { session: string; child: ChildProcess | null; output: string; printed: number }

const MAX_OUTPUT = 256 * 1024;
const PER_SESSION = 8;
const IN_ALL = 24;
/** Ended ones kept per session, to read why they stopped. */
const KEEP_ENDED = 6;
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[a-z0-9-]+\.localhost)(?::\d{2,5})?(?:\/[^\s'"]*)?/i;

/** A process's name from its command: what it runs, without the path. */
export function nameOf(command: string): string {
  const words = command.trim().split(/\s+/);
  const first = (words[0] ?? "").split("/").pop() ?? "";
  // A runner is named with what it runs: its first word that is not a flag (`python3 -u -m http.server` → http.server).
  const rest = words.slice(1).filter((word) => !word.startsWith("-"));
  const runner = /^(npm|pnpm|yarn|bun|npx|node|python3?|uv|cargo|go|make|deno)$/.test(first) && rest[0] ? `${first} ${rest[0] === "run" && rest[1] ? `run ${rest[1]}` : rest[0]}` : first;
  return runner.slice(0, 40) || "process";
}

export class Processes {
  readonly #all = new Map<string, Running>();
  readonly #listeners = new Set<(session: string) => void>();

  /** Called when a session's processes change (one started, printed an address, or ended). */
  onChange(listener: (session: string) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #changed(session: string) { for (const listener of this.#listeners) { try { listener(session); } catch { /* a listener's own trouble */ } } }

  start(session: string, input: { command: string; cwd: string; name?: string; by: "alfred" | "user" }): ProcessInfo {
    const command = input.command.trim();
    if (!command || command.length > 2000) throw new ProcessError("invalid", "A command is 1–2000 characters");
    if (!existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) throw new ProcessError("invalid", "The session's folder is not there");
    const mine = [...this.#all.values()].filter((entry) => entry.session === session);
    if (mine.filter((entry) => entry.exit === null).length >= PER_SESSION || [...this.#all.values()].filter((entry) => entry.exit === null).length >= IN_ALL) {
      throw new ProcessError("too_many", "Too many processes are running; stop one first");
    }
    // Ended ones beyond the few kept are forgotten.
    const ended = mine.filter((entry) => entry.exit !== null);
    for (const old of ended.slice(0, Math.max(0, ended.length - KEEP_ENDED + 1))) this.#all.delete(old.id);

    const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/zsh";
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/^(ZIRMA_|ISOCLINE_|ALFRED_|ELECTRON_)/.test(key)) env[key] = value;
    // No terminal to answer a prompt; colours are left to the tool (most turn them off without a terminal).
    Object.assign(env, { CI: env.CI ?? "", FORCE_COLOR: "0", BROWSER: "none" });
    // A login shell for the user's PATH (the home node may have a bare one), detached into its own process group.
    const child = spawn(shell, ["-lc", command], { cwd: input.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const entry: Running = {
      id: newId(), session, command, name: (input.name?.trim() || nameOf(command)).slice(0, 60), by: input.by,
      startedAt: new Date().toISOString(), exit: null, endedAt: null, url: null, child, output: "", printed: 0,
    };
    const take = (chunk: Buffer) => {
      entry.printed += chunk.length;
      entry.output = (entry.output + chunk.toString("utf8")).slice(-MAX_OUTPUT);
      if (!entry.url) {
        const found = LOCAL_URL.exec(plainLines(chunk.toString("utf8")).join("\n"));
        // Listening on every address (0.0.0.0, [::]) is opened as this machine.
        if (found) { entry.url = found[0].replace(/\/\/(?:0\.0\.0\.0|\[::\])/, "//localhost").replace(/[.,;)]+$/, ""); this.#changed(session); }
      }
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const end = (code: number) => {
      if (entry.exit !== null) return;
      entry.exit = code;
      entry.endedAt = new Date().toISOString();
      entry.child = null;
      this.#changed(session);
    };
    child.on("exit", (code, signal) => end(code ?? (signal ? 128 + (signalNumber(signal) ?? 15) : -1)));
    child.on("error", (error) => { entry.output += `\n${error.message}\n`; entry.printed += error.message.length + 2; end(-1); });
    this.#all.set(entry.id, entry);
    this.#changed(session);
    return info(entry);
  }

  list(session: string): ProcessInfo[] {
    return [...this.#all.values()].filter((entry) => entry.session === session).map(info);
  }

  #get(session: string, id: string): Running {
    const entry = this.#all.get(id);
    if (!entry || entry.session !== session) throw new ProcessError("missing", "No such process in this session");
    return entry;
  }

  /** What it printed last, as plain lines. `seen`: the `printed` the asker's last reading came with; when nothing
   * was printed since, the answer says `unchanged` and carries no text, instead of the same lines again. */
  logs(session: string, id: string, lines = 200, seen?: number): { process: ProcessInfo; text: string; printed: number; unchanged?: true } {
    const entry = this.#get(session, id);
    if (seen === entry.printed) return { process: info(entry), text: "", printed: entry.printed, unchanged: true };
    const all = plainLines(entry.output);
    while (all.length && !all[all.length - 1]) all.pop();
    return { process: info(entry), text: all.slice(-Math.max(1, Math.min(lines, 2000))).join("\n"), printed: entry.printed };
  }

  /** Stops it and what it started (its group): asked to end, then made to after a few seconds. An ended one is
   * forgotten instead. */
  stop(session: string, id: string): void {
    const entry = this.#get(session, id);
    if (entry.exit !== null || !entry.child?.pid) { this.#all.delete(id); this.#changed(session); return; }
    const pid = entry.child.pid;
    kill(pid, "SIGTERM");
    setTimeout(() => { if (entry.exit === null) kill(pid, "SIGKILL"); }, 4000).unref();
  }

  /** Wait for the process groups before their working directory can be removed. */
  async stopSession(session: string): Promise<void> {
    const entries = [...this.#all.values()].filter((entry) => entry.session === session);
    const groups = entries.flatMap((entry) => entry.child?.pid ? [entry.child.pid] : []);
    for (const pid of groups) kill(pid, "SIGTERM");
    let remaining = groups;
    for (let attempt = 0; remaining.length && attempt < 100; attempt++) {
      remaining = remaining.filter((pid) => {
        try { process.kill(-pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
      });
      if (attempt === 60) for (const pid of remaining) kill(pid, "SIGKILL");
      if (remaining.length) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (remaining.length) throw new ProcessError("invalid", "A background process is still stopping. Try archiving again.");
    for (const entry of entries) this.#all.delete(entry.id);
    this.#changed(session);
  }

  stopAll(): void {
    for (const entry of this.#all.values()) if (entry.exit === null && entry.child?.pid) kill(entry.child.pid, "SIGTERM");
    this.#all.clear();
  }
}

function info(entry: Running): ProcessInfo {
  const { id, command, name, by, startedAt, exit, endedAt, url } = entry;
  return { id, command, name, by, startedAt, exit, endedAt, url };
}

/** The whole group the process leads, else the process alone. */
function kill(pid: number, signal: NodeJS.Signals) {
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* already gone */ } }
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
  return ({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>)[signal];
}
