/** Development and production never share anything: not the world, not the port, not the launchd agent, not the
 * keychain. Production is the installed Zirma.app; anything run from the source tree is development unless it
 * says otherwise with ZIRMA_ENV=production. So a mistake in development lands in an empty world with no real
 * accounts, never in the user's.
 *
 * Overrides still work inside a stage: ZIRMA_DATA_DIR, ZIRMA_PORT, ZIRMA_KEYCHAIN_SERVICE. A development run
 * may not point them at production's (checkStage).
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Stage = "production" | "development";

/** Production's names before the renames (legacy.ts keeps the same list; repeated here so stage.ts imports nothing). */
const OLD_PRODUCTION = ["Isocline", "Alfred"];

interface StageNames { folder: string; port: number; keychain: string; agent: string }
const NAMES: Record<Stage, StageNames> = {
  production: { folder: "Zirma", port: 7480, keychain: "Zirma", agent: "zirma.home-node" },
  development: { folder: "Zirma Dev", port: 7491, keychain: "Zirma Dev", agent: "zirma.home-node.dev" },
};

export function currentStage(env: NodeJS.ProcessEnv = process.env): Stage {
  return env.ZIRMA_ENV === "production" ? "production" : "development";
}

/** The stage's own data directory, ignoring ZIRMA_DATA_DIR. */
export function stageDataDir(stage: Stage, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, home: string = homedir()): string {
  return dataDirNamed(NAMES[stage].folder, env, platform, home);
}

/** The data directory a product folder name stands for on this platform: "Zirma Dev" is `…/Application Support/Zirma Dev`
 * on a Mac and `$XDG_DATA_HOME/zirma-dev` elsewhere. Also used for the folders' earlier names (server rename.ts). */
export function dataDirNamed(folder: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, home: string = homedir()): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", folder);
  const base = env.XDG_DATA_HOME || join(home, ".local", "share");
  return join(base, folder.toLowerCase().replace(/ /g, "-"));
}

/** Where the world lives: ZIRMA_DATA_DIR, or the stage's own directory. Never inside the repository. */
export function dataDirFor(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZIRMA_DATA_DIR ? resolve(env.ZIRMA_DATA_DIR) : stageDataDir(currentStage(env), env);
}

export function portFor(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.ZIRMA_PORT) || NAMES[currentStage(env)].port;
}

export function keychainServiceFor(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZIRMA_KEYCHAIN_SERVICE || NAMES[currentStage(env)].keychain;
}

/** The launchd agent of the stage's own world (a world elsewhere gets its own agent, see the Mac app). */
export function agentLabelFor(env: NodeJS.ProcessEnv = process.env): string {
  return NAMES[currentStage(env)].agent;
}

/** Why this development run would touch production's world or secrets, or null when it would not. */
export function checkStage(dataDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (currentStage(env) === "production") return null;
  // Production's world and keychain under the product's earlier names (legacy.ts) are just as real.
  if (OLD_PRODUCTION.some((name) => resolve(dataDirNamed(name, env)) === resolve(dataDir))) {
    return `${dataDir} is the real world under an earlier name, and this is a development run.`;
  }
  if (OLD_PRODUCTION.includes(keychainServiceFor(env))) {
    return `The keychain service "${keychainServiceFor(env)}" holds the real accounts under an earlier name, and this is a development run.`;
  }
  if (resolve(dataDir) === stageDataDir("production", env)) {
    return `${dataDir} is the real world, and this is a development run. Open Zirma.app for it, or set ZIRMA_ENV=production if this really is the installed node.`;
  }
  if (keychainServiceFor(env) === NAMES.production.keychain) {
    return `The keychain service "${NAMES.production.keychain}" holds the real accounts, and this is a development run.`;
  }
  return null;
}
