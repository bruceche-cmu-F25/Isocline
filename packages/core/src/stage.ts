/** Development and production never share anything: not the world, not the port, not the launchd agent, not the
 * keychain. Production is the installed Isocline.app; anything run from the source tree is development unless it
 * says otherwise with ISOCLINE_ENV=production. So a mistake in development lands in an empty world with no real
 * accounts, never in the user's.
 *
 * Overrides still work inside a stage: ISOCLINE_DATA_DIR, ISOCLINE_PORT, ISOCLINE_KEYCHAIN_SERVICE. A development run
 * may not point them at production's (checkStage).
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Stage = "production" | "development";

interface StageNames { folder: string; port: number; keychain: string; agent: string }
const NAMES: Record<Stage, StageNames> = {
  production: { folder: "Isocline", port: 7480, keychain: "Isocline", agent: "isocline.home-node" },
  development: { folder: "Isocline Dev", port: 7491, keychain: "Isocline Dev", agent: "isocline.home-node.dev" },
};

export function currentStage(env: NodeJS.ProcessEnv = process.env): Stage {
  return env.ISOCLINE_ENV === "production" ? "production" : "development";
}

/** The stage's own data directory, ignoring ISOCLINE_DATA_DIR. */
export function stageDataDir(stage: Stage, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, home: string = homedir()): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", NAMES[stage].folder);
  const base = env.XDG_DATA_HOME || join(home, ".local", "share");
  return join(base, stage === "production" ? "isocline" : "isocline-dev");
}

/** Where the world lives: ISOCLINE_DATA_DIR, or the stage's own directory. Never inside the repository. */
export function dataDirFor(env: NodeJS.ProcessEnv = process.env): string {
  return env.ISOCLINE_DATA_DIR ? resolve(env.ISOCLINE_DATA_DIR) : stageDataDir(currentStage(env), env);
}

export function portFor(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.ISOCLINE_PORT) || NAMES[currentStage(env)].port;
}

export function keychainServiceFor(env: NodeJS.ProcessEnv = process.env): string {
  return env.ISOCLINE_KEYCHAIN_SERVICE || NAMES[currentStage(env)].keychain;
}

/** The launchd agent of the stage's own world (a world elsewhere gets its own agent, see the Mac app). */
export function agentLabelFor(env: NodeJS.ProcessEnv = process.env): string {
  return NAMES[currentStage(env)].agent;
}

/** Why this development run would touch production's world or secrets, or null when it would not. */
export function checkStage(dataDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (currentStage(env) === "production") return null;
  if (resolve(dataDir) === stageDataDir("production", env)) {
    return `${dataDir} is the real world, and this is a development run. Open Isocline.app for it, or set ISOCLINE_ENV=production if this really is the installed node.`;
  }
  if (keychainServiceFor(env) === NAMES.production.keychain) {
    return `The keychain service "${NAMES.production.keychain}" holds the real accounts, and this is a development run.`;
  }
  return null;
}
