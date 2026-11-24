import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirFor, portFor } from "@zirma/core";

/** The port of this stage's home node (production 7480, development 7491; core stage.ts). */
export const DEFAULT_PORT = portFor({ ...process.env, ZIRMA_PORT: undefined });

/** Where the world lives: ZIRMA_DATA_DIR, or this stage's own directory (core stage.ts). Never inside the repository. */
export function defaultDataDir(): string {
  return dataDirFor();
}

/** The built interface, next to this package in the workspace (or where ZIRMA_UI_DIR says, to try a build that
 * is not the one in use). */
export function defaultUiDir(): string {
  if (process.env.ZIRMA_UI_DIR) return resolve(process.env.ZIRMA_UI_DIR);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "dist");
}
