/** The Pi engine adapter. Pi runs in worker processes (see pool.ts); each
 * conversation keeps a persistent Pi session (see worker.ts). Isocline's tools
 * still run in the home node, under the run's lease.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkerEngine, type WorkerEngine } from "./pool.ts";

export { createWorkerEngine, EngineCrashedError, type WorkerEngine, type WorkerEngineOptions } from "./pool.ts";
export { composeHistory, composePrompt, type ExternalStep, type RunJob, type ToolSpec, type ToParent, type ToWorker } from "./protocol.ts";
export { loadIsoclineMcpConfig, readMcpFile, type LoadedMcpConfig } from "./mcp-config.ts";
export { McpConnectors, McpConnectorError, type McpConnectorsOptions } from "./connectors.ts";
export { MCP_CATALOG, type McpCatalogEntry } from "./mcp-catalog.ts";
export { createMcpVault, type McpVault } from "./mcp-store.ts";
export { Skills, SkillError, setSkillDisabled, type SkillsOptions } from "./skills.ts";

export interface PiEngineOptions {
  /** Working directory for sessions. Nothing is read from it. */
  cwd: string;
  /** Where conversations' sessions live; defaults to `<cwd>/sessions`. */
  sessions?: string;
  /** Where Isocline's `mcp.json` and `skills/` live (the data directory); defaults to `cwd`. */
  config?: string;
  /** Pi's agent directory; defaults to Pi's own (~/.pi/agent). */
  agentDir?: string;
  idleMs?: number;
  log?: (message: string) => void;
}

export function createPiEngine(options: PiEngineOptions): WorkerEngine {
  const args = ["--cwd", options.cwd, "--sessions", options.sessions ?? join(options.cwd, "sessions"), "--config", options.config ?? options.cwd];
  if (options.agentDir) args.push("--agent-dir", options.agentDir);
  return createWorkerEngine({ worker: fileURLToPath(new URL("./worker.ts", import.meta.url)), args, idleMs: options.idleMs, log: options.log });
}
export { createCredentialStore, type CredentialStore, type Credential } from "./credentials.ts";
export { ModelAccounts, ModelSignInError, type ModelAccountsOptions } from "./accounts.ts";
