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
  /** The language Isocline speaks on every device. Null until a device sets it from its system language. */
  locale: Locale | null;
  /** How the user wants Isocline to address them. Null until they have chosen a name. */
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
  /** Speaking and listening (docs/design/voice.md §3). */
  voice: VoiceSettings;
  /** Who the assistant is: one of the two characters, each with its own name and voice (docs/design/rename-isocline.md §4). */
  character: Character;
  /** What the assistant is called; null: the character's own name. The user's to change (Bruce calls his Alfred). */
  assistantName: string | null;
}
/** The two directions of the fourth dimension: Ana (a woman's voice) and Kata (a man's). */
export const CHARACTERS = ["ana", "kata"] as const;
export type Character = (typeof CHARACTERS)[number];
export const CHARACTER_NAMES: Record<Character, string> = { ana: "Ana", kata: "Kata" };
/** The name the assistant goes by: the user's choice, else the character's. */
export const assistantNameOf = (settings: Pick<UserSettings, "character" | "assistantName">): string =>
  settings.assistantName ?? CHARACTER_NAMES[settings.character] ?? CHARACTER_NAMES.ana;
export interface PageLayout { order: string[]; hidden: string[] }
export interface VoiceSettings {
  /** The Mac's figure reads out what it says (the welcome, a result, a question). Replies to quick talk are always
   * read out, unless muted. */
  speakFigure: boolean;
  /** For now: Isocline says nothing out loud anywhere, only shows. */
  muted: boolean;
  /** `system:<name>`, `model:<name>` or `elevenlabs|inworld|boson:<voice id>`; null: the default for the language. */
  voice: string | null;
  /** 0.7–1.5; 1 is the voice's own pace. */
  rate: number;
  /** Words the user says that a speech model may not know (names, terms): given to it with every recording. */
  words: string[];
}
export const MAX_VOICE_WORDS = 40;
const VOICE_DEFAULTS: VoiceSettings = { speakFigure: true, muted: false, voice: null, rate: 1, words: [] };

export class SettingsError extends Error {
  override name = "SettingsError";
}

const DEFAULTS: UserSettings = { locale: null, preferredName: null, model: null, thinking: null, firstRunAt: null, pages: null, voice: VOICE_DEFAULTS, character: "ana", assistantName: null };
/** The Mac's voice, the local model's, or a speech service's (its own voice id). */
const VOICE_ID = /^(system|model|elevenlabs|inworld|boson):[^\n\r]{1,120}$/;
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
  if ("character" in value) {
    if (!CHARACTERS.includes(value.character as Character)) throw new SettingsError(`character must be one of: ${CHARACTERS.join(", ")}`);
    out.character = value.character as Character;
  }
  if ("assistantName" in value) {
    const name = value.assistantName;
    if (name === null) out.assistantName = null;
    else {
      if (typeof name !== "string" || /\p{Cc}/u.test(name)) throw new SettingsError("assistantName must be text without control characters");
      const trimmed = name.trim();
      if (trimmed.length > 40) throw new SettingsError("assistantName is at most 40 characters");
      out.assistantName = trimmed || null;
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
  if ("voice" in value) out.voice = voiceSettings(value.voice);
  return out;
}

/** A whole or partial voice object; what it leaves out keeps its default (updateSettings merges onto the current). */
function voiceSettings(input: unknown): VoiceSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SettingsError("voice is an object");
  const value = input as Record<string, unknown>;
  const unknown = Object.keys(value).filter((key) => !(key in VOICE_DEFAULTS));
  if (unknown.length) throw new SettingsError(`Unknown voice setting: ${unknown.join(", ")}`);
  const out: VoiceSettings = { ...VOICE_DEFAULTS };
  for (const key of ["speakFigure", "muted"] as const) {
    if (key in value) {
      if (typeof value[key] !== "boolean") throw new SettingsError(`voice.${key} is true or false`);
      out[key] = value[key] as boolean;
    }
  }
  if ("voice" in value) {
    if (value.voice !== null && (typeof value.voice !== "string" || !VOICE_ID.test(value.voice))) throw new SettingsError("voice.voice is system:<name>, model:<name> or <service>:<voice id>, or null");
    out.voice = value.voice as string | null;
  }
  if ("rate" in value) {
    if (typeof value.rate !== "number" || !(value.rate >= 0.7 && value.rate <= 1.5)) throw new SettingsError("voice.rate is between 0.7 and 1.5");
    out.rate = Math.round(value.rate * 100) / 100;
  }
  if ("words" in value) {
    const words = value.words;
    if (!Array.isArray(words) || !words.every((word) => typeof word === "string")) throw new SettingsError("voice.words is a list of words");
    const kept = [...new Set((words as string[]).map((word) => word.trim()).filter(Boolean))];
    if (kept.some((word) => word.length > 40 || /\p{Cc}/u.test(word))) throw new SettingsError("a word is at most 40 characters, without control characters");
    if (kept.length > MAX_VOICE_WORDS) throw new SettingsError(`at most ${MAX_VOICE_WORDS} words`);
    out.words = kept;
  }
  return out;
}

export function updateSettings(world: World, patch: Record<string, unknown>, now: number = Date.now()): UserSettings {
  const unknown = Object.keys(patch).filter((key) => !(key in DEFAULTS));
  if (unknown.length) throw new SettingsError(`Unknown setting: ${unknown.join(", ")}`);
  return world.tx((db) => {
    const before = getSettings(world);
    // A voice patch changes only the fields it names.
    const changes = pick(patch.voice && typeof patch.voice === "object" && !Array.isArray(patch.voice) ? { ...patch, voice: { ...before.voice, ...patch.voice } } : patch);
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
