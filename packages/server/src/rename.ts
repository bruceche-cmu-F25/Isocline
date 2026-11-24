/** Moving an install from before the rename (Alfred → Isocline, docs/design/rename-isocline.md §3.3): the world and
 * the logs move from the old folders to the new ones, once, when the new ones are not there yet. Synchronous and
 * without imports beyond node, so the Mac app can run it before anything opens a file in either place. A world given
 * by ISOCLINE_DATA_DIR (a development world) is the caller's and is left where it is.
 */
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Move { from: string; to: string }

/** The folders that changed name, old and new, on this platform. */
export function renamedFolders(home: string = homedir(), env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): Move[] {
  if (env.ISOCLINE_DATA_DIR || env.ALFRED_DATA_DIR) return [];
  if (platform === "darwin") {
    return [
      { from: join(home, "Library", "Application Support", "Alfred"), to: join(home, "Library", "Application Support", "Isocline") },
      { from: join(home, "Library", "Logs", "Alfred"), to: join(home, "Library", "Logs", "Isocline") },
    ];
  }
  const data = env.XDG_DATA_HOME || join(home, ".local", "share");
  return [{ from: join(data, "alfred"), to: join(data, "isocline") }];
}

/** Moves each old folder to its new name if the new one does not exist yet; returns what moved. A folder that cannot
 * be moved (another disk, no permission) is left and reported, and the app starts fresh beside it. */
export function moveRenamedFolders(moves: Move[] = renamedFolders(), log?: (message: string) => void): Move[] {
  const moved: Move[] = [];
  for (const move of moves) {
    if (!existsSync(move.from) || existsSync(move.to)) continue;
    try {
      mkdirSync(dirname(move.to), { recursive: true });
      renameSync(move.from, move.to);
      moved.push(move);
      log?.(`moved ${move.from} to ${move.to}`);
    } catch (error) {
      log?.(`could not move ${move.from} to ${move.to}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return moved;
}
