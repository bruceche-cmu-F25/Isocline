/** Moving an install from before a rename (Alfred → Isocline → Zirma; docs/design/rename-zirma.md §3.2): the world and
 * the logs move from an old folder to the new one, once, when the new one is not there yet. The newest old name that
 * exists wins: a Mac that went through Isocline moves that, one that only ever had Alfred moves Alfred's. Synchronous
 * and without imports beyond node and core's stage rule, so the Mac app can run it before anything opens a file in
 * either place. A world given by ZIRMA_DATA_DIR is the caller's and is left where it is.
 *
 * Production moves its world and the logs folder. Development moves only its world: only Isocline had a development
 * stage, and the logs folder is production's to move (both stages write their logs there).
 */
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { currentStage, dataDirNamed, stageDataDir } from "@zirma/core/stage";

export interface Move { from: string; to: string }

/** Production's folders before the renames, newest first. */
const OLD_PRODUCTION = ["Isocline", "Alfred"];
/** Development's, likewise. */
const OLD_DEVELOPMENT = ["Isocline Dev"];

/** The folders that changed name, old and new, on this platform, in the order to try them: for one new folder, the
 * first old one that exists is moved and the rest are left (the new one exists by then). */
export function renamedFolders(home: string = homedir(), env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): Move[] {
  if (env.ZIRMA_DATA_DIR || env.ISOCLINE_DATA_DIR || env.ALFRED_DATA_DIR) return [];
  const stage = currentStage(env);
  const world = stageDataDir(stage, env, platform, home);
  const moves = (stage === "production" ? OLD_PRODUCTION : OLD_DEVELOPMENT).map((name) => ({ from: dataDirNamed(name, env, platform, home), to: world }));
  if (platform === "darwin" && stage === "production") {
    for (const name of OLD_PRODUCTION) moves.push({ from: join(home, "Library", "Logs", name), to: join(home, "Library", "Logs", "Zirma") });
  }
  return moves;
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
