import { recordDomainEvent, type World } from "@alfred/core";
import type { SiteIcon } from "./fetch.ts";

export const COVER_MIGRATION = {
  id: "link:4",
  sql: `CREATE TABLE link_covers (
    clip_id TEXT PRIMARY KEY NOT NULL REFERENCES link_items(id) ON DELETE CASCADE,
    duration_seconds INTEGER CHECK (duration_seconds BETWEEN 1 AND 604800),
    type TEXT, bytes BLOB CHECK (length(bytes) <= 524288), checked_at INTEGER NOT NULL
  ) STRICT;`,
};

// Cache covers for the newest 128 clips that have one worth showing: videos, and Xiaohongshu notes, whose cover is
// the note's own first picture (other posts and articles mostly publish a site banner). At 512 KiB per image this
// caps cover data at 64 MiB.
const newestCovered = "SELECT id FROM link_items WHERE kind = 'clip' AND (type = 'video' OR platform = 'xiaohongshu') ORDER BY saved_at DESC, rowid DESC LIMIT 128";
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

export function getCover(world: World, id: string): SiteIcon | null {
  const row = world.db.prepare("SELECT type, bytes FROM link_covers WHERE clip_id = ? AND bytes IS NOT NULL").get(id);
  return row ? { type: row.type as string, bytes: row.bytes as Uint8Array } : null;
}
