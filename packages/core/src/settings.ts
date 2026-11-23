/** The user's preferences that are not secrets, held by the home node so every device and everything the node says
 * itself (a proposal's steps, a permission question) agree. Each change is a `settings.changed` event, audited like
 * any other change (docs/design/settings-and-connections.md §3.5). The first field is the language.
 */
import type { DatabaseSync } from "node:sqlite";
import { recordDomainEvent } from "./events.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "./conversations.ts";
import { iso } from "./ids.ts";
import type { World } from "./world.ts";

export const LOCALES = ["zh", "en"] as const;
export type Locale = (typeof LOCALES)[number];

/** Each language's tag, for dates, numbers and what a web page is asked for. Adding a language starts here (and in
 * the UI's dict.ts); every text the node writes itself is a table keyed by Locale, so the compiler lists the rest. */
export const LOCALE_TAGS: Record<Locale, string> = { zh: "zh-CN", en: "en-US" };
export const localeTag = (locale: Locale): string => LOCALE_TAGS[locale];
/** What a web page is asked for, as a browser set to this language would: it, then English. */
export function acceptLanguage(locale: Locale): string {
  const tag = LOCALE_TAGS[locale], base = tag.split("-")[0]!;
  return base === "en" ? `${tag},en;q=0.9` : `${tag},${base};q=0.9,en;q=0.8`;
}

export interface UserSettings {
  /** The language Alfred speaks on every device. Null until a device sets it from its system language. */
  locale: Locale | null;
  /** How the user wants Alfred to address them. Null until they have chosen a name. */
  preferredName: string | null;
  /** The model a conversation uses unless it chose its own (`provider/model`); null: the engine's default. */
  model: string | null;
  /** The thinking level a conversation uses unless it chose its own; null: the model's default. */
  thinking: ThinkingLevel | null;
  /** When the first-run walkthrough was finished or skipped (ISO time). Null: it is still owed, on whichever device opens next. */
  firstRunAt: string | null;
  /** The sidebar's pages as the user arranged them: `order` lists page keys in the order wanted (a page not in it
   * keeps its place after them), `hidden` the ones taken out of the sidebar. Null: as they come. Which pages can be
   * hidden is the app's to say (the Today page and Settings cannot); this only keeps the choice. */
  pages: PageLayout | null;
}
export interface PageLayout { order: string[]; hidden: string[] }

export class SettingsError extends Error {
  override name = "SettingsError";
}

const DEFAULTS: UserSettings = { locale: null, preferredName: null, model: null, thinking: null, firstRunAt: null, pages: null };
const PAGE_KEY = /^[a-z][a-z0-9_-]{0,31}\.[a-z][a-z0-9_-]{0,31}$/;
const MODEL = /^[A-Za-z0-9._-]{1,64}\/[^\s/][^\s]{0,199}$/;

export function getSettings(world: World): UserSettings {
  const rows = world.db.prepare("SELECT key, value FROM core_settings").all();
  const stored = Object.fromEntries(rows.map((row) => [row.key as string, JSON.parse(row.value as string)]));
  return { ...DEFAULTS, ...pick(stored) };
}

/** The language for text the node writes itself; English until the user's devices have said otherwise. */
export function userLocale(world: World): Locale {
  return localeOf(world.db);
}

/** The same, inside a transaction that has only the database. */
export function localeOf(db: DatabaseSync): Locale {
  const row = db.prepare("SELECT value FROM core_settings WHERE key = 'locale'").get();
  const locale = row ? JSON.parse(row.value as string) as unknown : null;
  return LOCALES.includes(locale as Locale) ? locale as Locale : "en";
}

function pick(value: Record<string, unknown>): Partial<UserSettings> {
  const out: Partial<UserSettings> = {};
  if ("locale" in value) {
    if (value.locale !== null && !LOCALES.includes(value.locale as Locale)) throw new SettingsError(`locale must be one of: ${LOCALES.join(", ")}`);
    out.locale = value.locale as Locale | null;
  }
  if ("preferredName" in value) {
    const name = value.preferredName;
    if (name === null) out.preferredName = null;
    else {
      if (typeof name !== "string" || /\p{Cc}/u.test(name)) throw new SettingsError("preferredName must be text without control characters");
      const trimmed = name.trim();
      if (!trimmed || trimmed.length > 80) throw new SettingsError("preferredName must be between 1 and 80 characters");
      out.preferredName = trimmed;
    }
  }
  if ("model" in value) {
    if (value.model !== null && (typeof value.model !== "string" || !MODEL.test(value.model))) throw new SettingsError("model is provider/model, or null");
    out.model = value.model as string | null;
  }
  if ("thinking" in value) {
    if (value.thinking !== null && !THINKING_LEVELS.includes(value.thinking as ThinkingLevel)) throw new SettingsError(`thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
    out.thinking = value.thinking as ThinkingLevel | null;
  }
  if ("firstRunAt" in value) {
    const at = value.firstRunAt;
    if (at !== null && (typeof at !== "string" || at.length > 40 || Number.isNaN(Date.parse(at)))) throw new SettingsError("firstRunAt is a time, or null");
    out.firstRunAt = at === null ? null : new Date(at as string).toISOString();
  }
  if ("pages" in value) {
    const pages = value.pages as Partial<PageLayout> | null;
    const keys = (list: unknown) => Array.isArray(list) && list.length <= 64 && list.every((key) => typeof key === "string" && PAGE_KEY.test(key));
    if (pages !== null && (typeof pages !== "object" || !keys(pages.order) || !keys(pages.hidden))) throw new SettingsError("pages is { order, hidden }, lists of page keys, or null");
    out.pages = pages === null ? null : { order: [...new Set(pages.order!)], hidden: [...new Set(pages.hidden!)] };
  }
  return out;
}

export function updateSettings(world: World, patch: Record<string, unknown>, now: number = Date.now()): UserSettings {
  const unknown = Object.keys(patch).filter((key) => !(key in DEFAULTS));
  if (unknown.length) throw new SettingsError(`Unknown setting: ${unknown.join(", ")}`);
  const changes = pick(patch);
  return world.tx((db) => {
    const before = getSettings(world);
    const changed: Record<string, [unknown, unknown]> = {};
    for (const [key, value] of Object.entries(changes)) {
      if (JSON.stringify(before[key as keyof UserSettings]) === JSON.stringify(value)) continue;
      db.prepare("INSERT INTO core_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
        .run(key, JSON.stringify(value), iso(now));
      changed[key] = [before[key as keyof UserSettings], value];
    }
    if (Object.keys(changed).length) recordDomainEvent(world, { kind: "settings.changed", subject: "settings", payload: { changes: changed }, now });
    return getSettings(world);
  });
}
