/** Preferences: what the user has said about how they like things done ("answer in short lines", "my week starts on
 * Monday", "never book meetings before 10"). ARCHITECTURE.md §8 calls it `USER.md`: written down as it is said, by the
 * user in Settings or by Zirma when the user tells it something lasting, and always visible, changeable and
 * removable there (docs/design/user-defined.md §8). Zirma reads all of it, with the name the user wants to be called,
 * at the start of every run.
 *
 * One row a preference, in the user's own words. Each change is an event, so who wrote what, and when, stays known.
 */
import { recordDomainEvent } from "./events.ts";
import { iso, newId } from "./ids.ts";
import { getSettings } from "./settings.ts";
import type { World } from "./world.ts";

export const MAX_PREFERENCE = 300;
export const MAX_PREFERENCES = 60;

export interface Preference {
  id: string;
  text: string;
  /** Who wrote it down: the user in Settings, or Zirma from something the user said. */
  by: "user" | "alfred";
  createdAt: string;
  updatedAt: string;
}

export const PREFERENCE_MIGRATION_SQL = `
CREATE TABLE core_preferences (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND ${MAX_PREFERENCE}),
  by TEXT NOT NULL CHECK (by IN ('user', 'alfred')),
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
`;

export class PreferenceError extends Error {
  override name = "PreferenceError";
  readonly code: "missing" | "invalid" | "full";
  constructor(code: "missing" | "invalid" | "full", message: string) {
    super(message);
    this.code = code;
  }
}

function toPreference(row: Record<string, unknown>): Preference {
  return { id: row.id as string, text: row.text as string, by: row.by as Preference["by"], createdAt: row.created_at as string, updatedAt: row.updated_at as string };
}

function cleanText(value: unknown): string {
  if (typeof value !== "string") throw new PreferenceError("invalid", "A preference is text");
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.length > MAX_PREFERENCE || /\p{Cc}/u.test(text)) throw new PreferenceError("invalid", `A preference is 1 to ${MAX_PREFERENCE} characters of plain text`);
  return text;
}

export function listPreferences(world: World): Preference[] {
  return world.db.prepare("SELECT * FROM core_preferences ORDER BY position, created_at").all().map(toPreference);
}

export function addPreference(world: World, input: { text: unknown; by?: Preference["by"] }): Preference {
  const text = cleanText(input.text);
  const by = input.by === "alfred" ? "alfred" : "user";
  return world.tx(() => {
    const same = listPreferences(world).find((preference) => preference.text.toLowerCase() === text.toLowerCase());
    if (same) return same;
    const count = world.db.prepare("SELECT count(*) AS n, coalesce(max(position), -1) AS last FROM core_preferences").get() as { n: number; last: number };
    if (count.n >= MAX_PREFERENCES) throw new PreferenceError("full", `There are already ${MAX_PREFERENCES} preferences; remove one first`);
    const now = iso(Date.now());
    const id = newId();
    world.db.prepare("INSERT INTO core_preferences (id, text, by, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, text, by, count.last + 1, now, now);
    recordDomainEvent(world, { kind: "preference.added", subject: `preference:${id}`, payload: { text, by } });
    return toPreference(world.db.prepare("SELECT * FROM core_preferences WHERE id = ?").get(id)!);
  });
}

function existing(world: World, id: string): Preference {
  const row = world.db.prepare("SELECT * FROM core_preferences WHERE id = ?").get(id);
  if (!row) throw new PreferenceError("missing", "No such preference");
  return toPreference(row);
}

/** Changed by hand: from then on it is the user's words. */
export function updatePreference(world: World, id: string, text: unknown): Preference {
  const next = cleanText(text);
  return world.tx(() => {
    const before = existing(world, id);
    if (before.text === next) return before;
    world.db.prepare("UPDATE core_preferences SET text = ?, by = 'user', updated_at = ? WHERE id = ?").run(next, iso(Date.now()), id);
    recordDomainEvent(world, { kind: "preference.updated", subject: `preference:${id}`, payload: { text: next, was: before.text } });
    return existing(world, id);
  });
}

export function removePreference(world: World, id: string, by: Preference["by"] = "user"): Preference {
  return world.tx(() => {
    const before = existing(world, id);
    world.db.prepare("DELETE FROM core_preferences WHERE id = ?").run(id);
    recordDomainEvent(world, { kind: "preference.removed", subject: `preference:${id}`, payload: { text: before.text, by } });
    return before;
  });
}

/** What Zirma is told at the start of a run: the name the user goes by, and every preference, as the user's own
 * words. Empty when there is nothing to say. */
export function describePreferences(world: World): string {
  const name = getSettings(world).preferredName;
  const preferences = listPreferences(world);
  const lines = [
    ...(name ? [`The user wants to be called ${JSON.stringify(name)}.`] : []),
    ...(preferences.length ? [
      "What the user has said about how they like things (follow these unless they say otherwise now; ids in brackets, for preference_remove):",
      ...preferences.map((preference) => `- [${preference.id}] ${preference.text}`),
    ] : []),
  ];
  return lines.join("\n");
}
