import { recordDomainEvent, type World } from "@zirma/module-kit";
import type { SiteIcon } from "./fetch.ts";

export const COVER_MIGRATION = {
  id: "link:4",
  sql: `CREATE TABLE link_covers (
    clip_id TEXT PRIMARY KEY NOT NULL REFERENCES link_items(id) ON DELETE CASCADE,
    duration_seconds INTEGER CHECK (duration_seconds BETWEEN 1 AND 604800),
    type TEXT, bytes BLOB CHECK (length(bytes) <= 524288), checked_at INTEGER NOT NULL
  ) STRICT;`,
};

// Covers for the newest 1000 clips that have one worth showing: videos, and Xiaohongshu notes, whose cover is the
// note's own first picture (other posts and articles mostly publish a site banner). A cover is kept at the size it
// is drawn (fetch.ts shrinkCover), tens of kilobytes, so a thousand come to a few tens of MB.
const newestCovered = "SELECT id FROM link_items WHERE kind = 'clip' AND (type = 'video' OR platform = 'xiaohongshu') ORDER BY saved_at DESC, rowid DESC LIMIT 1000";
/** Covers kept before they were shrunk weigh more than this; a shrunk one does not. */
const LARGE = 120 * 1024;
const retryAfterMs = 7 * 86_400_000;

export function pendingCovers(world: World): Array<{ id: string; url: string }> {
  return world.tx((db) => {
    db.prepare(`DELETE FROM link_covers WHERE clip_id NOT IN (${newestCovered})`).run();
    return db.prepare(`SELECT i.id, i.url FROM link_items i LEFT JOIN link_covers c ON c.clip_id = i.id
      WHERE i.id IN (${newestCovered}) AND i.fetch != 'pending'
      AND c.bytes IS NULL AND (c.checked_at IS NULL OR c.checked_at < ?)
      ORDER BY i.saved_at DESC, i.rowid DESC LIMIT 4`).all(Date.now() - retryAfterMs) as Array<{ id: string; url: string }>;
  });
}

export function recordCover(world: World, id: string, cover: SiteIcon | null, durationSeconds?: number): void {
  world.tx((db) => {
    const duration = durationSeconds && Number.isSafeInteger(durationSeconds) && durationSeconds > 0 && durationSeconds <= 604800 ? durationSeconds : null;
    const result = db.prepare(`INSERT INTO link_covers (clip_id, type, bytes, duration_seconds, checked_at)
      SELECT id, ?, ?, ?, ? FROM link_items WHERE id = ? AND id IN (${newestCovered})
      ON CONFLICT(clip_id) DO UPDATE SET type = excluded.type, bytes = excluded.bytes, duration_seconds = COALESCE(excluded.duration_seconds, link_covers.duration_seconds), checked_at = excluded.checked_at
      WHERE link_covers.bytes IS NULL`).run(cover?.type ?? null, cover?.bytes ?? null, duration, Date.now(), id);
    if ((cover || duration) && result.changes) recordDomainEvent(world, { kind: "link.cover", subject: "link:covers", payload: { id } });
  });
}

/** Covers stored at the size the site sent them, a few at a time, largest first. `tried`: ones already shrunk
 * that are still large (a picture that does not compress), left as they are. */
export function largeCovers(world: World, tried: ReadonlySet<string>, limit = 8): Array<{ id: string; cover: SiteIcon }> {
  const ids = (world.db.prepare("SELECT clip_id FROM link_covers WHERE length(bytes) > ? ORDER BY length(bytes) DESC").all(LARGE) as Array<{ clip_id: string }>)
    .map((row) => row.clip_id).filter((id) => !tried.has(id)).slice(0, limit);
  return ids.map((id) => {
    const row = world.db.prepare("SELECT type, bytes FROM link_covers WHERE clip_id = ?").get(id)!;
    return { id, cover: { type: row.type as string, bytes: row.bytes as Uint8Array } };
  });
}

/** A stored cover, shrunk; null when it could not be read, which drops it until the page is looked at again. */
export function replaceCover(world: World, id: string, cover: SiteIcon | null): void {
  world.tx((db) => db.prepare("UPDATE link_covers SET type = ?, bytes = ?, checked_at = ? WHERE clip_id = ?").run(cover?.type ?? null, cover ? Buffer.from(cover.bytes) : null, Date.now(), id));
}

export function getCover(world: World, id: string): SiteIcon | null {
  const row = world.db.prepare("SELECT type, bytes FROM link_covers WHERE clip_id = ? AND bytes IS NOT NULL").get(id);
  return row ? { type: row.type as string, bytes: row.bytes as Uint8Array } : null;
}
