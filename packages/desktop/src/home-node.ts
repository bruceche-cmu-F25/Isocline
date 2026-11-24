/** Keeps the home node running as a launchd user agent, independent of this
 * app: closing windows or quitting the app never stops Isocline's work, and the
 * node starts again at login. The app's own runtime runs it (Electron as
 * Node), so nothing else needs to be installed.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HomeNodeConfig {
  label: string;
  /** The agent this world ran under before the rename (Alfred → Isocline): retired before this one starts. */
  legacyLabel: string;
  port: number;
  /** Absent: the home node's default (~/Library/Application Support/Isocline). */
  dataDir?: string;
  /** The executable that runs the node (this app's binary, as Node). */
  runtime: string;
  /** packages/server/src/cli.ts */
  cli: string;
  logFile: string;
  /** Passed through to the node, e.g. ISOCLINE_AWAY_MINUTES. */
  env: Record<string, string>;
}

export const DEFAULT_PORT = 7480;

export function homeNodeConfig(options: { runtime: string; cli: string; env: NodeJS.ProcessEnv }): HomeNodeConfig {
  const dataDir = options.env.ISOCLINE_DATA_DIR || undefined;
  // A non-default data directory gets its own agent, so a development world never replaces the real one.
  const label = dataDir ? `isocline.home-node.${createHash("sha256").update(dataDir).digest("hex").slice(0, 8)}` : "isocline.home-node";
  const env: Record<string, string> = {};
  if (options.env.ISOCLINE_AWAY_MINUTES) env.ISOCLINE_AWAY_MINUTES = options.env.ISOCLINE_AWAY_MINUTES;
  return {
    label,
    legacyLabel: label.replace(/^isocline\./, "alfred."),
    port: Number(options.env.ISOCLINE_PORT) || DEFAULT_PORT,
    dataDir,
    runtime: options.runtime,
    cli: options.cli,
    logFile: join(homedir(), "Library", "Logs", "Isocline", `${label}.log`),
    env,
  };
}

const plistPath = (label: string) => join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const domain = () => `gui/${process.getuid!()}`;

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function plistFor(config: HomeNodeConfig): string {
  const args = [config.runtime, config.cli, "serve", "--port", String(config.port), ...(config.dataDir ? ["--data-dir", config.dataDir] : [])];
  const env = { ELECTRON_RUN_AS_NODE: "1", PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin", ...config.env };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(config.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([key, value]) => `    <key>${xml(key)}</key><string>${xml(value)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(config.logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(config.logFile)}</string>
</dict>
</plist>
`;
}

/** Stops and removes the agent this world ran under before the rename (`alfred.home-node`), so the new one is the
 * only home node on it. Synchronous: the Mac app calls it before it moves the old folders (rename.ts) and before
 * anything opens a file in them. Waits briefly for the old node to let go; its lock file would stop the new one
 * anyway if it had not. Returns whether there was one. */
export function retireLegacyAgent(config: HomeNodeConfig): boolean {
  const path = plistPath(config.legacyLabel);
  const loaded = launchctl("print", `${domain()}/${config.legacyLabel}`).ok;
  if (!loaded && !existsSync(path)) return false;
  if (loaded) launchctl("bootout", `${domain()}/${config.legacyLabel}`);
  rmSync(path, { force: true });
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; waited < 10_000 && launchctl("print", `${domain()}/${config.legacyLabel}`).ok; waited += 200) Atomics.wait(pause, 0, 0, 200);
  return true;
}

/** Whether an Isocline home node answers on the port. */
export async function healthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/state?modules=0`, { signal: AbortSignal.timeout(1500) });
    return response.ok && (await response.json() as { protocol?: number }).protocol === 1;
  } catch {
    return false;
  }
}

function launchctl(...args: string[]): { ok: boolean; output: string } {
  try {
    return { ok: true, output: execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    return { ok: false, output: String((error as { stderr?: string }).stderr ?? error) };
  }
}

export const isLoaded = (config: HomeNodeConfig) => launchctl("print", `${domain()}/${config.label}`).ok;

async function waitUntil(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return check();
}

export type HomeNodeMode = "launchd" | "external";

/** Makes sure a home node answers. Uses one that is already running (for
 * example `npm start`) rather than starting a second on the same world.
 */
export async function ensureHomeNode(config: HomeNodeConfig): Promise<HomeNodeMode> {
  const plist = plistFor(config);
  const path = plistPath(config.label);
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (await healthy(config.port)) {
    if (!isLoaded(config)) return "external";
    // A changed plist (the app moved) takes effect at the node's next start, not mid-run.
    if (current !== plist) writeFileSync(path, plist, { mode: 0o644 });
    return "launchd";
  }
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(join(homedir(), "Library", "Logs", "Isocline"), { recursive: true });
  writeFileSync(path, plist, { mode: 0o644 });
  if (isLoaded(config)) launchctl("bootout", `${domain()}/${config.label}`);
  const loaded = launchctl("bootstrap", domain(), path);
  if (!loaded.ok) throw new Error(`launchctl could not start the home node: ${loaded.output.trim()}`);
  if (!(await waitUntil(() => healthy(config.port), 20_000))) {
    throw new Error(`The home node did not start. See its log: ${config.logFile}`);
  }
  return "launchd";
}

/** Stops the node and keeps it stopped until the next ensure or login. */
export function stopHomeNode(config: HomeNodeConfig): void {
  launchctl("bootout", `${domain()}/${config.label}`);
}

export async function restartHomeNode(config: HomeNodeConfig): Promise<void> {
  if (isLoaded(config)) {
    launchctl("kickstart", "-k", `${domain()}/${config.label}`);
    await waitUntil(() => healthy(config.port), 20_000);
  } else {
    await ensureHomeNode(config);
  }
}
