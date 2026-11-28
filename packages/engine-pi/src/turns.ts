/** Where in a conversation's Pi session each turn ended, so a regenerated or edited turn, or a switched version,
 * goes on from the right place (docs/design/chat-regenerate.md §4.5). Pi keeps a session as a tree in one file;
 * moving to an earlier entry and prompting grows a new branch there and leaves the old one as it was.
 *
 * The record is a small file beside the session folder (not in it, so Pi never mistakes it for a session): which
 * session file it is about, and for each turn (by the core's run id) the entry it ended at. A new session file
 * starts a new record. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface TurnRecord {
  /** The session file these entries are in. */
  file: string;
  /** Run id → the session's leaf entry when that turn ended. */
  ends: Record<string, string>;
}

/** What to do with the session before a turn. */
export type Place =
  | { kind: "stay" }
  /** Move to this entry (the end of the turn this one goes on from). */
  | { kind: "go"; to: string }
  /** Start a new session file: the turn goes on from somewhere this session cannot reach. The core's history of
   * the versions in use is given to it instead, as for a conversation older than its session. */
  | { kind: "fresh" };

export function placeFor(input: {
  /** EngineRequest.after; undefined from a home node that does not send it. */
  after: string | null | undefined;
  branched: boolean;
  /** The session has nothing in it yet. */
  empty: boolean;
  leaf: string | null;
  record: TurnRecord | null;
}): Place {
  const { after, branched, empty, leaf, record } = input;
  if (after === undefined || empty) return { kind: "stay" };
  // Again from the conversation's first turn: a new session has exactly what is before it, which is nothing.
  if (after === null) return { kind: "fresh" };
  const end = record?.ends[after];
  if (end) return end === leaf ? { kind: "stay" } : { kind: "go", to: end };
  // Not recorded (a turn from before this record, or one that never ended here): where the session is, is right
  // only if this turn simply follows the last one.
  return branched ? { kind: "fresh" } : { kind: "stay" };
}

export function readRecord(path: string, file: string | undefined): TurnRecord | null {
  if (!file) return null;
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as TurnRecord;
    return record.file === file && record.ends && typeof record.ends === "object" ? record : null;
  } catch {
    return null;
  }
}

/** Notes where a turn ended. Written whole to a temporary file and moved into place, so a crash leaves the old one. */
export function recordEnd(path: string, file: string, turn: string, leaf: string): void {
  const record = readRecord(path, file) ?? { file, ends: {} };
  record.ends[turn] = leaf;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(record));
  renameSync(`${path}.tmp`, path);
}
