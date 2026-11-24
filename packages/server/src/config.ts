import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PORT = 7480;

/** Where the world lives. Never inside the repository. */
export function defaultDataDir(): string {
  if (process.env.ISOCLINE_DATA_DIR) return resolve(process.env.ISOCLINE_DATA_DIR);
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Isocline");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "isocline");
}

/** The built interface, next to this package in the workspace (or where ISOCLINE_UI_DIR says, to try a build that
 * is not the one in use). */
export function defaultUiDir(): string {
  if (process.env.ISOCLINE_UI_DIR) return resolve(process.env.ISOCLINE_UI_DIR);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "dist");
}
