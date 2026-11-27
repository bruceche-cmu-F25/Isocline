/** Filing links on their own (docs/design/links-autofile.md): the switch on the Links page, which links wait to be
 * filed, and the user's corrections kept as examples. The pass that files them reads these; it is not here yet (§8 A2).
 *
 * Who filed a link is kept on it (`filed_by`): the user (a click, a bookmark folder) or Zirma (in a chat, or on its
 * own). A link with no category and no one who filed it is one nobody has decided about; one with no category that
 * the user filed is one they want left there. Only the first kind is ever filed on its own.
 */
import { localDate, recordDomainEvent, type Migration, type World } from "@zirma/module-kit";
import type { AutoFileState } from "./types.ts";

export type FiledBy = "user" | "zirma";

/** Links filed on their own in a day, at most (§2). Asking for it on the page does not count. */
export const AUTO_FILE_PER_DAY = 50;
/** The user's corrections kept as examples (§3). */
export const MAX_FIXES = 30;

export const AUTO_FILE_MIGRATION: Migration = {
  id: "link:9",
  sql: `
ALTER TABLE link_items ADD COLUMN filed_by TEXT CHECK (filed_by IS NULL OR filed_by IN ('user', 'zirma'));
ALTER TABLE link_items ADD COLUMN file_queue INTEGER NOT NULL DEFAULT 0 CHECK (file_queue IN (0, 1));
UPDATE link_items SET filed_by = 'user' WHERE topic_id IS NOT NULL;
CREATE INDEX link_items_file_queue ON link_items(saved_at) WHERE file_queue = 1;
ALTER TABLE link_topics ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'zirma'));
ALTER TABLE link_topics ADD COLUMN touched INTEGER NOT NULL DEFAULT 1 CHECK (touched IN (0, 1));
CREATE TABLE link_fixes (
  seq INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  site TEXT NOT NULL DEFAULT '',
  from_path TEXT,
  to_path TEXT,
  at TEXT NOT NULL
) STRICT;
CREATE TABLE link_autofile (
  one INTEGER PRIMARY KEY CHECK (one = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  day TEXT,
  count INTEGER NOT NULL DEFAULT 0,
  run TEXT
) STRICT;
INSERT INTO link_autofile (one) VALUES (1);
`,
};

export function autoFileOn(world: World): boolean {
  return world.db.prepare("SELECT enabled FROM link_autofile WHERE one = 1").get()?.enabled === 1;
}

export function autoFileState(world: World, now: Date = new Date()): AutoFileState {
  const row = world.db.prepare("SELECT enabled, day, count FROM link_autofile WHERE one = 1").get();
  return { enabled: row?.enabled === 1, today: row?.day === localDate(now) ? row.count as number : 0, perDay: AUTO_FILE_PER_DAY };
}

/** Turns filing on its own on or off. Off, nothing waits any more: a link saved while it was on and not yet filed
 * stays where it is, and turning it on again does not reach back for it. */
export function setAutoFile(world: World, enabled: boolean): AutoFileState {
  return world.tx((db) => {
    if (autoFileOn(world) !== enabled) {
      db.prepare("UPDATE link_autofile SET enabled = ? WHERE one = 1").run(enabled ? 1 : 0);
      if (!enabled) db.prepare("UPDATE link_items SET file_queue = 0 WHERE file_queue = 1").run();
      recordDomainEvent(world, { kind: "link.autofile_set", subject: "link:autofile", payload: { enabled } });
    }
    return autoFileState(world);
  });
}

/** What a link newly kept without a category starts with: waiting to be filed, if filing on its own is on. */
export const queueFlag = (world: World): 0 | 1 => (autoFileOn(world) ? 1 : 0);

/** Links waiting to be filed on their own, oldest first: kept while it was on, with no category, filed by no one,
 * and (a saved thing) its page looked up, or given up on, so its title and description are there to go by. */
export function waitingToFile(world: World, limit = 20): Array<{ id: string; kind: "place" | "clip" }> {
  if (!autoFileOn(world)) return [];
  return world.db.prepare(`SELECT id, kind FROM link_items WHERE file_queue = 1 AND topic_id IS NULL AND filed_by IS NULL
    AND (kind = 'place' OR fetch != 'pending') ORDER BY saved_at, rowid LIMIT ?`).all(limit)
    .map((row) => ({ id: row.id as string, kind: row.kind as "place" | "clip" }));
}

/** How many links are waiting, their pages looked up or not. */
export function waitingCount(world: World): number {
  return world.db.prepare("SELECT count(*) AS n FROM link_items WHERE file_queue = 1 AND topic_id IS NULL AND filed_by IS NULL").get()!.n as number;
}

export interface Fix { title: string; site: string; from?: string; to?: string; at: string }

/** The user moved a link Zirma had filed: kept as an example for the next time (only the latest MAX_FIXES). */
export function recordFix(world: World, fix: { itemId: string; title: string; site: string; from?: string; to?: string }): void {
  const db = world.db;
  db.prepare("INSERT INTO link_fixes (item_id, title, site, from_path, to_path, at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(fix.itemId, fix.title.slice(0, 300) || "?", fix.site.slice(0, 120), fix.from ?? null, fix.to ?? null, new Date().toISOString());
  db.prepare("DELETE FROM link_fixes WHERE seq NOT IN (SELECT seq FROM link_fixes ORDER BY seq DESC LIMIT ?)").run(MAX_FIXES);
}

/** Newest first. */
export function listFixes(world: World): Fix[] {
  return world.db.prepare("SELECT * FROM link_fixes ORDER BY seq DESC").all().map((row) => ({
    title: row.title as string, site: row.site as string, at: row.at as string,
    ...(row.from_path ? { from: row.from_path as string } : {}), ...(row.to_path ? { to: row.to_path as string } : {}),
  }));
}
