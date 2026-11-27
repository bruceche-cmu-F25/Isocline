/** The world's side of reminders: what has been told, telling what `planReminders` says, and taking back what went
 * out of date before anyone saw it (docs/design/reminders.md §3, §4).
 *
 * A reminder is a notice of kind `reminder`, next to a `reminder.due` event. The notices are the record of what was
 * told: their payload lists the keys of the things they are about, so no other table is needed.
 */
import { appendEvent } from "./events.ts";
import { iso } from "./ids.ts";
import { createNotice } from "./notices.ts";
import type { ReminderBatch } from "./reminders.ts";
import type { World } from "./world.ts";

/** How far back what was told is looked up. Longer than any thing stays to be told (an hour's notice of a todo, a
 * day's look at mail), so a thing is never told twice. */
const TOLD_WITHIN_MS = 3 * 24 * 60 * 60_000;

/** The keys of everything told (or on its way) lately. */
export function remindersTold(world: World, now: number = Date.now()): Set<string> {
  const rows = world.db.prepare(`SELECT DISTINCT key.value AS key FROM core_notices, json_each(core_notices.payload, '$.keys') AS key
    WHERE core_notices.kind = 'reminder' AND core_notices.created_at >= ?`).all(iso(now - TOLD_WITHIN_MS)) as { key: string }[];
  return new Set(rows.map((row) => row.key));
}

/** Makes a notice of each batch, and withdraws undelivered reminders about nothing in `current`. Returns how many
 * were made and withdrawn. */
export function tellReminders(world: World, batches: readonly ReminderBatch[], current: ReadonlySet<string>, now: number = Date.now()): { told: number; withdrawn: number } {
  return world.tx((db) => {
    const open = db.prepare(`SELECT id, payload FROM core_notices WHERE kind = 'reminder' AND state IN ('pending', 'claimed')`).all() as { id: string; payload: string }[];
    let withdrawn = 0;
    for (const row of open) {
      const keys = (JSON.parse(row.payload) as { keys?: string[] }).keys ?? [];
      if (keys.some((key) => current.has(key))) continue;
      db.prepare("UPDATE core_notices SET state = 'expired', claimed_by = NULL, claim_until = NULL, updated_at = ? WHERE id = ?").run(iso(now), row.id);
      withdrawn++;
    }
    let told = 0;
    for (const batch of batches) {
      const ttlMs = batch.expiresAt - now;
      if (ttlMs <= 0) continue;
      const first = batch.items[0];
      const payload = { keys: batch.keys, items: batch.items };
      const event = appendEvent(db, { kind: "reminder.due", subject: `${first.source === "event" ? "calendar" : first.source}:${first.id}`, actor: "system", runId: null, now, payload });
      createNotice(db, { eventSeq: event.seq, kind: "reminder", payload, ttlMs, now });
      told++;
    }
    return { told, withdrawn };
  });
}
