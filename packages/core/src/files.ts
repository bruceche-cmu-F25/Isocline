/** Files the user hands to Zirma with a message: an image, a PDF, a text file (docs/design/attachments.md).
 *
 * The world keeps what a file is (its name, kind, size, and what was made of it for reading); its bytes are the home
 * node's to keep on disk, under the file's id. A file is uploaded first and then attached to exactly one run, the
 * message it was sent with; one never attached is forgotten after a while. Files are the user's own: nothing here is
 * fetched from anywhere.
 */
import type { DatabaseSync } from "node:sqlite";
import { iso, newId } from "./ids.ts";
import type { World } from "./world.ts";

/** How a file reaches the model: an image is shown to it, a text file is given as text, a PDF as the text in it. */
export const FILE_KINDS = ["image", "text", "pdf"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export interface FileInfo {
  id: string;
  name: string;
  /** Its media type, as the home node made it out from the bytes. */
  type: string;
  kind: FileKind;
  size: number;
  /** A PDF: its page count, and whether text could be read out of it (false: a scan, or no reader on this machine). */
  pages?: number;
  readable?: boolean;
}

export class FileError extends Error {
  override name = "FileError";
  readonly code: "missing" | "invalid" | "taken" | "too_many";
  constructor(code: FileError["code"], message: string) { super(message); this.code = code; }
}

/** How many files one message may carry. */
export const MAX_FILES_PER_RUN = 10;
export const FILE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function toFile(row: Record<string, unknown>): FileInfo {
  const meta = row.meta ? JSON.parse(row.meta as string) as { pages?: number; readable?: boolean } : {};
  return {
    id: row.id as string, name: row.name as string, type: row.type as string, kind: row.kind as FileKind, size: row.size as number,
    ...(meta.pages !== undefined ? { pages: meta.pages } : {}), ...(meta.readable !== undefined ? { readable: meta.readable } : {}),
  };
}

/** A file's name as it is kept and shown: its last path part, without control characters, of a sane length. */
export function fileName(input: string): string {
  const base = input.replace(/[\u0000-\u001f\u007f]/g, "").split(/[\\/]/).at(-1)?.trim() ?? "";
  return (base || "file").slice(0, 200);
}

/** Records a file whose bytes the caller has already put away under `id`. */
export function addFile(world: World, input: { id?: string; name: string; type: string; kind: FileKind; size: number; sha256: string; pages?: number; readable?: boolean }, now: number = Date.now()): FileInfo {
  if (!FILE_KINDS.includes(input.kind)) throw new FileError("invalid", "Unknown kind of file");
  const id = input.id ?? newId();
  const meta = input.pages !== undefined || input.readable !== undefined ? JSON.stringify({ pages: input.pages, readable: input.readable }) : null;
  world.tx((db) => db.prepare("INSERT INTO core_files (id, name, type, kind, size, sha256, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, fileName(input.name), input.type.slice(0, 100), input.kind, input.size, input.sha256, meta, iso(now)));
  return getFile(world, id);
}

export function getFile(world: World, id: string): FileInfo & { conversationId: string | null; runId: string | null } {
  const row = FILE_ID.test(id) ? world.db.prepare("SELECT * FROM core_files WHERE id = ?").get(id) : undefined;
  if (!row) throw new FileError("missing", "No such file");
  return { ...toFile(row), conversationId: (row.conversation_id as string | null) ?? null, runId: (row.run_id as string | null) ?? null };
}

/** Only inside a world transaction: these files go with this run. Each must exist and not be another run's. */
export function attachFiles(db: DatabaseSync, ids: readonly string[], run: { id: string; conversationId: string }): FileInfo[] {
  const unique = [...new Set(ids)];
  if (unique.length > MAX_FILES_PER_RUN) throw new FileError("too_many", `At most ${MAX_FILES_PER_RUN} files go with one message`);
  const files: FileInfo[] = [];
  for (const id of unique) {
    const row = typeof id === "string" && FILE_ID.test(id) ? db.prepare("SELECT * FROM core_files WHERE id = ?").get(id) : undefined;
    if (!row) throw new FileError("missing", "One of the files is no longer there; attach it again");
    if (row.run_id && row.run_id !== run.id) throw new FileError("taken", "A file can go with one message only");
    db.prepare("UPDATE core_files SET run_id = ?, conversation_id = ? WHERE id = ?").run(run.id, run.conversationId, id);
    files.push(toFile(row));
  }
  return files;
}

/** The files sent with each of these runs, by run id, in the order they were attached. */
export function listRunFiles(world: World, runIds: readonly string[]): Record<string, FileInfo[]> {
  const out: Record<string, FileInfo[]> = {};
  if (!runIds.length) return out;
  const rows = world.db.prepare(`SELECT * FROM core_files WHERE run_id IN (${runIds.map(() => "?").join(",")}) ORDER BY rowid`).all(...runIds);
  for (const row of rows) (out[row.run_id as string] ??= []).push(toFile(row));
  return out;
}

/** Files uploaded before `before` and never sent with a message: forgotten here, and returned so their bytes can go. */
export function dropUnattachedFiles(world: World, before: number): string[] {
  return world.tx((db) => {
    const ids = db.prepare("SELECT id FROM core_files WHERE run_id IS NULL AND created_at < ?").all(iso(before)).map((row) => row.id as string);
    for (const id of ids) db.prepare("DELETE FROM core_files WHERE id = ?").run(id);
    return ids;
  });
}
