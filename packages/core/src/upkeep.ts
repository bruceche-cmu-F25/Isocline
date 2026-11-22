/** Upkeep of the world's file: what would otherwise grow without end, although nothing reads it any more.
 *
 * The event log keeps every row: what happened stays told. Two things in it are bulk rather than record:
 * - what a command printed (a `run.step`'s `output`, up to 8,000 characters each; a busy day of development
 *   sessions writes megabytes of it). After `OUTPUT_DAYS` the output is dropped; the step itself (the command, how
 *   it ended, how long it took) stays.
 * - a command's answer kept for a retry with the same request id (`core_commands`). A retry comes within seconds
 *   or not at all; after `COMMAND_DAYS` the record is dropped.
 */
import { iso } from "./ids.ts";
import type { World } from "./world.ts";

/** How long what a command printed is kept. */
export const OUTPUT_DAYS = 30;
/** How long a command's answer is kept for a retry of it. */
export const COMMAND_DAYS = 30;
const DAY_MS = 86_400_000;

export interface Upkeep { outputs: number; commands: number }

/** One pass. It goes on from where the last one stopped (`core_upkeep.trimmed_seq`), so it reads only the events
 * that have come of age since, however long the log is. */
export function tidyWorld(world: World, options: { now?: number; outputDays?: number; commandDays?: number } = {}): Upkeep {
  const now = options.now ?? Date.now();
  const outputBefore = iso(now - (options.outputDays ?? OUTPUT_DAYS) * DAY_MS);
  const commandBefore = iso(now - (options.commandDays ?? COMMAND_DAYS) * DAY_MS);
  return world.tx((db) => {
    const from = db.prepare("SELECT trimmed_seq FROM core_upkeep WHERE id = 1").get()!.trimmed_seq as number;
    // Everything before the first event still young enough is old enough, whatever a clock did in between.
    const young = db.prepare("SELECT seq FROM core_events WHERE seq > ? AND at >= ? ORDER BY seq LIMIT 1").get(from, outputBefore);
    const upTo = young ? (young.seq as number) - 1 : (db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM core_events").get()!.seq as number);
    let outputs = 0;
    if (upTo > from) {
      outputs = Number(db.prepare(`UPDATE core_events SET payload = json_remove(payload, '$.output')
        WHERE seq > ? AND seq <= ? AND kind = 'run.step' AND json_type(payload, '$.output') IS NOT NULL`).run(from, upTo).changes);
      db.prepare("UPDATE core_upkeep SET trimmed_seq = ? WHERE id = 1").run(upTo);
    }
    const commands = Number(db.prepare("DELETE FROM core_commands WHERE at < ?").run(commandBefore).changes);
    return { outputs, commands };
  });
}
