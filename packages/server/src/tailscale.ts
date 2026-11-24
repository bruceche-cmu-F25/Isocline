/** The Tailscale already installed on this machine, driven through its CLI (docs/research/remote-access.md, option A).
 * Isocline only ever touches its own HTTPS port in the Serve config; the user's other Serve entries stay as they are.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { TailscaleStatus } from "@isocline/protocol";

/** Runs the CLI; resolves with stdout, rejects with an Error whose message is stderr (tests swap it). */
export type Runner = (args: string[]) => Promise<string>;

const CANDIDATES = [
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

export function findTailscale(): string | null {
  return CANDIDATES.find((path) => existsSync(path)) ?? null;
}

export function cliRunner(binary: string): Runner {
  return (args) => new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().split("\n").slice(0, 3).join(" ")));
      else resolve(stdout);
    });
  });
}

interface StatusJson {
  BackendState?: string;
  Self?: { DNSName?: string; UserID?: number };
  User?: Record<string, { LoginName?: string }>;
}
interface ServeJson {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  TCP?: Record<string, unknown>;
}

export class Tailscale {
  readonly #run: Runner | null;
  constructor(run: Runner | null) { this.#run = run; }

  async status(): Promise<TailscaleStatus> {
    if (!this.#run) return { installed: false, running: false, dnsName: null, owner: null };
    try {
      const status = JSON.parse(await this.#run(["status", "--json"])) as StatusJson;
      const running = status.BackendState === "Running";
      const dnsName = status.Self?.DNSName?.replace(/\.$/, "") || null;
      const owner = status.Self?.UserID !== undefined ? status.User?.[String(status.Self.UserID)]?.LoginName ?? null : null;
      return { installed: true, running, dnsName: running ? dnsName : null, owner };
    } catch (error) {
      return { installed: true, running: false, dnsName: null, owner: null, error: (error as Error).message };
    }
  }

  /** What this machine's Serve sends to port `port`'s root, or null when that port is free. */
  async servedAt(dnsName: string, port: number): Promise<string | null | "other"> {
    const config = JSON.parse((await this.#cli(["serve", "status", "--json"])) || "{}") as ServeJson;
    const web = config.Web?.[`${dnsName}:${port}`];
    if (web) {
      const handlers = Object.entries(web.Handlers ?? {});
      return handlers.length === 1 && handlers[0][0] === "/" && handlers[0][1].Proxy ? handlers[0][1].Proxy : "other";
    }
    return config.TCP?.[String(port)] ? "other" : null;
  }

  /** Points HTTPS port `port` (tailnet only) at `target`, in the background so it survives this process. */
  async serve(port: number, target: string): Promise<void> {
    await this.#cli(["serve", "--bg", `--https=${port}`, target]);
  }

  async unserve(port: number): Promise<void> {
    await this.#cli(["serve", `--https=${port}`, "off"]);
  }

  #cli(args: string[]): Promise<string> {
    if (!this.#run) return Promise.reject(new Error("Tailscale is not installed"));
    return this.#run(args);
  }
}
