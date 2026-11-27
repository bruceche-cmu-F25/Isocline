/** What Zirma remembers about its own layer of the notes (notes-two-layers.md 4.4–4.8, 4.13): the text it last wrote
 * to each of its pages (a file that is no longer that was changed elsewhere, and Zirma stops there), the lines the user
 * said no to, the subjects it is not to keep (a page the user deleted or took), its suggestions, and when it last
 * went through the notes. Small tables, read and written inside the callers' transactions. */
import { createHash } from "node:crypto";
import type { Migration, World } from "@zirma/module-kit";

export const LAYER_MIGRATIONS: Migration[] = [{
  id: "note:2",
  sql: `
CREATE TABLE note_kept (
  id TEXT PRIMARY KEY NOT NULL,
  fp TEXT NOT NULL,
  text TEXT NOT NULL,
  at TEXT NOT NULL
) STRICT;
CREATE TABLE note_rejects (
  id INTEGER PRIMARY KEY,
  page TEXT NOT NULL,
  words TEXT NOT NULL,
  sources TEXT NOT NULL DEFAULT '[]',
  at TEXT NOT NULL
) STRICT;
CREATE INDEX note_rejects_page ON note_rejects(page);
CREATE TABLE note_skips (
  name TEXT PRIMARY KEY NOT NULL,
  why TEXT NOT NULL CHECK (why IN ('deleted', 'adopted')),
  at TEXT NOT NULL
) STRICT;
CREATE TABLE note_suggestions (
  id TEXT PRIMARY KEY NOT NULL,
  page TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('edit', 'move', 'remember')),
  find TEXT,
  replace TEXT,
  under TEXT,
  reason TEXT NOT NULL,
  sources TEXT NOT NULL DEFAULT '[]',
  key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'accepted', 'declined', 'stale')),
  at TEXT NOT NULL,
  decided_at TEXT
) STRICT;
CREATE INDEX note_suggestions_page ON note_suggestions(page, state);
CREATE INDEX note_suggestions_key ON note_suggestions(key);
CREATE TABLE note_compile (
  one INTEGER PRIMARY KEY NOT NULL CHECK (one = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  daily TEXT NOT NULL DEFAULT '07:30',
  last_at TEXT,
  last_daily TEXT,
  asked TEXT NOT NULL DEFAULT '[]',
  run TEXT
) STRICT;
CREATE TABLE note_history_2 (
  id TEXT PRIMARY KEY NOT NULL,
  page TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('user', 'alfred')),
  kind TEXT NOT NULL CHECK (kind IN ('edit', 'create', 'rename', 'delete', 'links', 'adopt')),
  summary TEXT NOT NULL DEFAULT '',
  before TEXT,
  after TEXT,
  extra TEXT,
  undone INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO note_history_2 (id, page, at, actor, kind, summary, before, after, extra, undone)
  SELECT id, page, at, actor, kind, summary, before, after, extra, undone FROM note_history ORDER BY rowid;
DROP TABLE note_history;
ALTER TABLE note_history_2 RENAME TO note_history;
CREATE INDEX note_history_page ON note_history(page, at);
`,
}];

const now = () => new Date().toISOString();

/* ── What Zirma last wrote ── */

export function noteKept(world: World, id: string, text: string, fp: string): void {
  world.db.prepare("INSERT INTO note_kept (id, fp, text, at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET fp = excluded.fp, text = excluded.text, at = excluded.at")
    .run(id, fp, text, now());
}

export function keptRow(world: World, id: string): { fp: string; text: string; at: string } | null {
  const row = world.db.prepare("SELECT fp, text, at FROM note_kept WHERE id = ?").get(id);
  return row ? { fp: row.fp as string, text: row.text as string, at: row.at as string } : null;
}

export function moveKept(world: World, from: string, to: string): void {
  world.db.prepare("UPDATE note_kept SET id = ? WHERE id = ?").run(to, from);
}

export function dropKept(world: World, id: string): void {
  world.db.prepare("DELETE FROM note_kept WHERE id = ?").run(id);
}

/* ── Subjects Zirma does not keep ── */

const skipKey = (name: string) => name.trim().toLowerCase();

export function addSkip(world: World, name: string, why: "deleted" | "adopted"): void {
  world.db.prepare("INSERT INTO note_skips (name, why, at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET why = excluded.why, at = excluded.at").run(skipKey(name), why, now());
}

export function removeSkip(world: World, name: string): void {
  world.db.prepare("DELETE FROM note_skips WHERE name = ?").run(skipKey(name));
}

export function isSkipped(world: World, name: string): boolean {
  return !!world.db.prepare("SELECT 1 FROM note_skips WHERE name = ?").get(skipKey(name));
}

/* ── Lines the user said no to ── */

export interface Reject { id: number; page: string; words: string; sources: string[] }

export function addReject(world: World, page: string, words: string, sources: readonly string[]): number {
  const result = world.db.prepare("INSERT INTO note_rejects (page, words, sources, at) VALUES (?, ?, ?, ?)").run(page, words, JSON.stringify(sources), now());
  return Number(result.lastInsertRowid);
}

export function removeReject(world: World, id: number): void {
  world.db.prepare("DELETE FROM note_rejects WHERE id = ?").run(id);
}

export function rejectsOf(world: World, page: string): Reject[] {
  return world.db.prepare("SELECT * FROM note_rejects WHERE page = ?").all(page).map((row) => ({
    id: row.id as number, page: row.page as string, words: row.words as string, sources: JSON.parse(row.sources as string) as string[],
  }));
}

export function moveRejects(world: World, from: string, to: string): void {
  world.db.prepare("UPDATE note_rejects SET page = ? WHERE page = ?").run(to, from);
}

/** Words as compared: no spaces, no punctuation, lower case. */
export function plainWords(text: string): string {
  return text.toLowerCase().replace(/\[\[([^\]|]*)(?:\|[^\]]*)?\]\]/g, "$1").replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** How alike two lines are (0–1): the share of character pairs they have in common. */
export function alike(a: string, b: string): number {
  const x = plainWords(a), y = plainWords(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const pairs = (text: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < text.length - 1; i++) out.set(text.slice(i, i + 2), (out.get(text.slice(i, i + 2)) ?? 0) + 1);
    return out;
  };
  const p = pairs(x), q = pairs(y);
  let shared = 0;
  for (const [pair, n] of p) shared += Math.min(n, q.get(pair) ?? 0);
  return (2 * shared) / (x.length - 1 + y.length - 1);
}

/** Whether a line is one the user already said no to: the same words, or nearly the same from the same place. */
export function isRejected(rejects: readonly Reject[], words: string, sources: readonly string[]): boolean {
  return rejects.some((reject) => {
    const score = alike(reject.words, words);
    if (score === 1) return true;
    if (score < 0.6) return false;
    return !reject.sources.length || reject.sources.some((source) => sources.includes(source));
  });
}

/* ── Keys ── */

export function keyOf(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24);
}
