/** Areas: the parts of life things belong to. A shared kernel for every module that sorts things this way (todos,
 * link topics), so one area means the same thing everywhere and keeps the same colour.
 *
 * The user's own list (docs/design/user-defined.md §2): seven samples are written in when the world is made, and from
 * then on they are the user's like any other, renamed, recoloured, moved or removed. A sample keeps no name of its own
 * until the user gives it one, so it reads in the user's language. One the user removed is not written back.
 * Things store the id, so a name can change without touching them.
 */
import { recordDomainEvent } from "./events.ts";
import { iso, newId } from "./ids.ts";
import { userLocale, type Locale } from "./settings.ts";
import type { World } from "./world.ts";

/** Colour slots in tokens.css (`data-k`), in the order checked for colour-blind separation; gray last. */
export const AREA_COLOURS = ["blue", "green", "violet", "orange", "teal", "yellow", "pink", "gray"] as const;
export type AreaColour = (typeof AREA_COLOURS)[number];

export interface Area {
  id: string;
  /** In the user's language for a sample they have not renamed. */
  name: string;
  /** Colour slot in tokens.css (`data-k`). */
  k: AreaColour;
  /** Written in as a sample and not renamed since: its name follows the language. */
  sample: boolean;
}

/** The samples' names. Their ids are what things already store. */
export const SAMPLE_AREAS: ReadonlyArray<{ id: string; name: Record<Locale, string>; k: AreaColour }> = [
  { id: "work", name: { zh: "工作", en: "Work" }, k: "blue" },
  { id: "life", name: { zh: "生活", en: "Life" }, k: "green" },
  { id: "learn", name: { zh: "学习", en: "Learning" }, k: "violet" },
  { id: "travel", name: { zh: "出行", en: "Travel" }, k: "orange" },
  { id: "health", name: { zh: "健康", en: "Health" }, k: "teal" },
  { id: "money", name: { zh: "财务", en: "Money" }, k: "yellow" },
  { id: "people", name: { zh: "家人朋友", en: "People" }, k: "pink" },
];

export const AREA_MIGRATION_SQL = `
CREATE TABLE core_areas (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  name TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND ${40}),
  k TEXT NOT NULL CHECK (k IN (${AREA_COLOURS.map((k) => `'${k}'`).join(", ")})),
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
${SAMPLE_AREAS.map((area, index) => `INSERT INTO core_areas (id, name, k, position, created_at) VALUES ('${area.id}', NULL, '${area.k}', ${index}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));`).join("\n")}
`;

export class AreaError extends Error {
  override name = "AreaError";
  readonly code: "missing" | "invalid" | "taken";
  constructor(code: "missing" | "invalid" | "taken", message: string) {
    super(message);
    this.code = code;
  }
}

const MAX_NAME = 40;
const sampleName = (id: string, locale: Locale) => SAMPLE_AREAS.find((area) => area.id === id)?.name[locale];

function toArea(row: Record<string, unknown>, locale: Locale): Area {
  const id = row.id as string, own = row.name as string | null;
  return { id, name: own ?? sampleName(id, locale) ?? id, k: row.k as AreaColour, sample: own === null };
}

/** The user's areas in their order. */
export function listAreas(world: World, locale: Locale = userLocale(world)): Area[] {
  return world.db.prepare("SELECT * FROM core_areas ORDER BY position, rowid").all().map((row) => toArea(row, locale));
}

export function isArea(world: World, id: string): boolean {
  return !!world.db.prepare("SELECT 1 FROM core_areas WHERE id = ?").get(id);
}

export function areaName(world: World, id: string | undefined, locale: Locale = userLocale(world)): string | undefined {
  if (!id) return undefined;
  const row = world.db.prepare("SELECT * FROM core_areas WHERE id = ?").get(id);
  return row ? toArea(row, locale).name : undefined;
}

/** "work (Work), …": the areas as a run is told them, so it uses ids that exist. */
export function describeAreas(world: World): string {
  return listAreas(world).map((area) => `${area.id} (${area.name})`).join(", ") || "none";
}

/** The refusal a module gives for an area that is not one of the user's. */
export function unknownArea(world: World): string {
  return `area must be one of: ${listAreas(world).map((area) => area.id).join(", ") || "(the user has no areas)"}`;
}

function getRow(world: World, id: string): Record<string, unknown> {
  const row = world.db.prepare("SELECT * FROM core_areas WHERE id = ?").get(id);
  if (!row) throw new AreaError("missing", "No such area");
  return row;
}

function cleanName(world: World, value: unknown, except?: string): string {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > MAX_NAME) throw new AreaError("invalid", `An area's name is 1 to ${MAX_NAME} characters`);
  const same = (other: string) => other.toLowerCase() === name.toLowerCase();
  // Not the name of another area, in whichever language it is read.
  for (const row of world.db.prepare("SELECT * FROM core_areas").all()) {
    if (row.id === except) continue;
    const names = row.name !== null ? [row.name as string] : Object.values(SAMPLE_AREAS.find((area) => area.id === row.id)?.name ?? {});
    if (names.some(same)) throw new AreaError("taken", "There is already an area by that name");
  }
  return name;
}

function cleanColour(value: unknown): AreaColour {
  if (!AREA_COLOURS.includes(value as AreaColour)) throw new AreaError("invalid", `colour must be one of: ${AREA_COLOURS.join(", ")}`);
  return value as AreaColour;
}

/** The colour a new area gets: the one fewest areas have, in the palette's order (gray only when asked for). */
function freeColour(world: World): AreaColour {
  const used = new Map<string, number>();
  for (const row of world.db.prepare("SELECT k FROM core_areas").all()) used.set(row.k as string, (used.get(row.k as string) ?? 0) + 1);
  return AREA_COLOURS.filter((k) => k !== "gray").reduce((best, k) => ((used.get(k) ?? 0) < (used.get(best) ?? 0) ? k : best), "blue" as AreaColour);
}

export function addArea(world: World, input: { name: unknown; k?: unknown }, now: number = Date.now()): Area {
  return world.tx(() => {
    const name = cleanName(world, input.name);
    const k = input.k === undefined ? freeColour(world) : cleanColour(input.k);
    const id = newId();
    const position = world.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM core_areas").get()!.next as number;
    world.db.prepare("INSERT INTO core_areas (id, name, k, position, created_at) VALUES (?, ?, ?, ?, ?)").run(id, name, k, position, iso(now));
    recordDomainEvent(world, { kind: "area.created", subject: `area:${id}`, payload: { name, k }, now });
    return toArea(getRow(world, id), userLocale(world));
  });
}

export function updateArea(world: World, id: string, patch: { name?: unknown; k?: unknown }, now: number = Date.now()): Area {
  return world.tx(() => {
    const before = toArea(getRow(world, id), userLocale(world));
    const changes: Record<string, unknown> = {};
    if (patch.name !== undefined) {
      const name = cleanName(world, patch.name, id);
      if (name !== before.name || before.sample) changes.name = name;
    }
    if (patch.k !== undefined) {
      const k = cleanColour(patch.k);
      if (k !== before.k) changes.k = k;
    }
    if (!Object.keys(changes).length) return before;
    world.db.prepare("UPDATE core_areas SET name = COALESCE(?, name), k = COALESCE(?, k) WHERE id = ?").run((changes.name as string) ?? null, (changes.k as string) ?? null, id);
    recordDomainEvent(world, { kind: "area.updated", subject: `area:${id}`, payload: { changes, was: { name: before.name, k: before.k } }, now });
    return toArea(getRow(world, id), userLocale(world));
  });
}

/** Puts an area at `index` in the list (clamped); the others keep their order. */
export function moveArea(world: World, id: string, index: number, now: number = Date.now()): Area[] {
  return world.tx(() => {
    getRow(world, id);
    if (!Number.isInteger(index)) throw new AreaError("invalid", "index is a whole number");
    const ids = (world.db.prepare("SELECT id FROM core_areas ORDER BY position, rowid").all() as Array<{ id: string }>).map((row) => row.id);
    const from = ids.indexOf(id);
    const to = Math.max(0, Math.min(ids.length - 1, index));
    if (from === to) return listAreas(world);
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    const set = world.db.prepare("UPDATE core_areas SET position = ? WHERE id = ?");
    ids.forEach((each, position) => set.run(position, each));
    recordDomainEvent(world, { kind: "area.moved", subject: `area:${id}`, payload: { from, to }, now });
    return listAreas(world);
  });
}

/** Takes an area off the list. What was in it is the modules' to move (module-kit `removeArea` does both, in one
 * transaction): to `moveTo`, or to no area. */
export function deleteAreaRow(world: World, id: string, moveTo: string | null, now: number = Date.now()): Area {
  const area = toArea(getRow(world, id), userLocale(world));
  if (moveTo !== null && (moveTo === id || !isArea(world, moveTo))) throw new AreaError("invalid", "Move its things to another of the user's areas, or to none");
  world.db.prepare("DELETE FROM core_areas WHERE id = ?").run(id);
  recordDomainEvent(world, { kind: "area.removed", subject: `area:${id}`, payload: { name: area.name, k: area.k, moveTo }, now });
  return area;
}
