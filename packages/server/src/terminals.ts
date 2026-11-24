/** The user's own terminal in a development session (docs/design/dev-terminal-browser.md): a real shell, opened in
 * the session's project folder, on the home node's machine.
 *
 * It is the user's, with everything their account can do, so only the home node's own machine may open or type into
 * one (http.ts refuses other devices). Zirma never types into it: what Zirma runs goes through its own tool, shown
 * and allowed command by command. Zirma may read what the terminal last printed (`tail`), to see an error the user
 * is looking at.
 *
 * One terminal per session. It keeps running while the page is closed (a dev server started in it stays up) and
 * ends when the user closes it, when its shell exits, or when the home node stops. What it printed last is kept, so
 * a page that comes back sees where things stand.
 */
import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";

/** The part of node-pty this uses. */
interface Pty {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
interface PtyModule { spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): Pty }

export type TerminalEvent = { type: "output"; data: string; offset: number } | { type: "exit"; code: number };

export class TerminalError extends Error {
  override name = "TerminalError";
  readonly code: "unavailable" | "missing" | "invalid" | "too_many";
  constructor(code: TerminalError["code"], message: string) { super(message); this.code = code; }
}

interface Open {
  pty: Pty;
  cwd: string;
  /** The last of what it printed, and how many characters it has printed in all (where `backlog` ends). */
  backlog: string;
  offset: number;
  exit: number | null;
  listeners: Set<(event: TerminalEvent) => void>;
}

const MAX_BACKLOG = 256 * 1024;
const MAX_TERMINALS = 8;
const MAX_INPUT = 64 * 1024;
const size = (value: unknown, fallback: number, max: number) => (typeof value === "number" && Number.isInteger(value) && value >= 2 && value <= max ? value : fallback);

/** What a terminal printed, as plain lines: without colours and cursor moves, and with a line that was redrawn in
 * place (a progress bar) as it last stood. */
export function plainLines(text: string): string[] {
  const clean = text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")       // window titles and the like
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")                      // colours, cursor moves, clears
    .replace(/\u001b[@-Z\\-_]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return clean.split("\n").map((line) => {
    const parts = line.replace(/\r+$/, "").split("\r");
    return parts[parts.length - 1].replace(/\s+$/, "");
  });
}

export class Terminals {
  readonly #open = new Map<string, Open>();
  readonly #log?: (message: string) => void;
  #pty: PtyModule | null | undefined;
  readonly #spawn?: PtyModule["spawn"];

  /** `spawn`: how a shell is started, for tests; node-pty otherwise. */
  constructor(options: { log?: (message: string) => void; spawn?: PtyModule["spawn"] } = {}) {
    this.#log = options.log;
    this.#spawn = options.spawn;
  }

  /** node-pty is loaded when the first terminal is asked for: a machine where it does not load still runs Zirma. */
  #module(): PtyModule {
    if (this.#spawn) return { spawn: this.#spawn };
    if (this.#pty === undefined) {
      try { this.#pty = createRequire(import.meta.url)("node-pty") as PtyModule; } catch (error) {
        this.#pty = null;
        this.#log?.(`terminal unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!this.#pty) throw new TerminalError("unavailable", "The terminal could not be loaded on this machine");
    return this.#pty;
  }

  has(id: string): boolean { return this.#open.has(id); }

  /** Opens the session's terminal in `cwd`, or answers the one already open. */
  open(id: string, cwd: string, dimensions: { cols?: unknown; rows?: unknown } = {}): { cwd: string; exited: boolean; offset: number } {
    const existing = this.#open.get(id);
    if (existing && existing.exit === null) return { cwd: existing.cwd, exited: false, offset: existing.offset };
    if (existing) this.#open.delete(id);
    if (this.#open.size >= MAX_TERMINALS) throw new TerminalError("too_many", "Too many terminals are open; close one first");
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new TerminalError("invalid", "The session's folder is not there");
    const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/zsh";
    const env: Record<string, string> = {};
    // The user's own environment, without what is only Zirma's.
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/^(ZIRMA_|ISOCLINE_|ALFRED_|ELECTRON_)/.test(key)) env[key] = value;
    Object.assign(env, { TERM: "xterm-256color", COLORTERM: "truecolor", ...(env.LANG || env.LC_ALL ? {} : { LANG: "en_US.UTF-8" }) });
    // A login shell: the home node may have been started by the system with a bare PATH; the user's profile sets theirs.
    const pty = this.#module().spawn(shell, ["-l"], { name: "xterm-256color", cols: size(dimensions.cols, 100, 500), rows: size(dimensions.rows, 28, 300), cwd, env });
    const record: Open = { pty, cwd, backlog: "", offset: 0, exit: null, listeners: new Set() };
    pty.onData((data) => {
      record.offset += data.length;
      record.backlog = (record.backlog + data).slice(-MAX_BACKLOG);
      for (const listener of record.listeners) listener({ type: "output", data, offset: record.offset });
    });
    pty.onExit(({ exitCode }) => {
      record.exit = exitCode;
      for (const listener of record.listeners) listener({ type: "exit", code: exitCode });
    });
    this.#open.set(id, record);
    return { cwd, exited: false, offset: 0 };
  }

  #get(id: string): Open {
    const record = this.#open.get(id);
    if (!record) throw new TerminalError("missing", "No terminal is open in this session");
    return record;
  }

  /** Follows the terminal. First what it printed after `from` (all that is kept, if that is too far back), then
   * what it prints from now on. Returns how to stop following. */
  follow(id: string, from: number, listener: (event: TerminalEvent) => void): () => void {
    const record = this.#get(id);
    const kept = record.offset - record.backlog.length;
    const missed = record.backlog.slice(Math.max(0, Math.min(record.backlog.length, from - kept)));
    if (missed) listener({ type: "output", data: missed, offset: record.offset });
    if (record.exit !== null) listener({ type: "exit", code: record.exit });
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  write(id: string, data: string): void {
    const record = this.#get(id);
    if (typeof data !== "string" || data.length > MAX_INPUT) throw new TerminalError("invalid", "Too much input at once");
    if (record.exit === null) record.pty.write(data);
  }

  resize(id: string, cols: unknown, rows: unknown): void {
    const record = this.#get(id);
    if (record.exit === null) record.pty.resize(size(cols, 100, 500), size(rows, 28, 300));
  }

  /** The last lines the terminal printed, as plain text; null when the session has no terminal. */
  tail(id: string, lines: number): string | null {
    const record = this.#open.get(id);
    if (!record) return null;
    const all = plainLines(record.backlog);
    while (all.length && !all[all.length - 1]) all.pop();
    return all.slice(-Math.max(1, Math.min(lines, 400))).join("\n");
  }

  close(id: string): void {
    const record = this.#open.get(id);
    if (!record) return;
    this.#open.delete(id);
    if (record.exit === null) { try { record.pty.kill(); } catch { /* already gone */ } }
    for (const listener of record.listeners) listener({ type: "exit", code: record.exit ?? -1 });
    record.listeners.clear();
  }

  /** A worktree may be removed immediately afterwards, so wait for the real PTY exit. */
  async closeForArchive(id: string): Promise<void> {
    const record = this.#open.get(id);
    if (!record) return;
    if (record.exit === null) {
      await new Promise<void>((resolve, reject) => {
        const force = setTimeout(() => { try { record.pty.kill("SIGKILL"); } catch { /* exiting */ } }, 3000);
        const timeout = setTimeout(() => reject(new TerminalError("invalid", "The terminal is still stopping. Try archiving again.")), 5000);
        record.pty.onExit(() => { clearTimeout(force); clearTimeout(timeout); resolve(); });
        try { record.pty.kill(); } catch { /* wait for the exit event */ }
      });
    }
    this.close(id);
  }

  closeAll(): void { for (const id of [...this.#open.keys()]) this.close(id); }
}
