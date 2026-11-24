/** Chinese and English for everything a person reads. Pure (no React, no DOM needed), so the Mac app's main
 * process uses it too. The language is the user's setting on the home node; until a device has set it, each device
 * follows its system language.
 *
 *   {name}           filled from `vars`
 *   {n|one|other}    English plurals: `one` when vars.n is 1, else `other` (which may itself contain {n})
 */
import { en } from "./en.ts";
import { zh } from "./zh.ts";

export type Locale = "zh" | "en";
export type Key = keyof typeof zh;
export const LOCALES: readonly Locale[] = ["zh", "en"];
/** Each language's tag (dates, numbers, the page's `lang`) and its name, short and whole, in itself. */
export const LOCALE_INFO: Record<Locale, { tag: string; short: string; name: string }> = {
  zh: { tag: "zh-CN", short: "中文", name: "中文" },
  en: { tag: "en-US", short: "EN", name: "English" },
};
export const localeTag = (locale: Locale): string => LOCALE_INFO[locale].tag;
/** The language after this one, for a switch that steps through them. */
export const nextLocale = (locale: Locale): Locale => LOCALES[(LOCALES.indexOf(locale) + 1) % LOCALES.length]!;
const DICTS: Record<Locale, Record<Key, string>> = { zh, en };

export function detectLocale(language: string | undefined = typeof navigator === "undefined" ? undefined : navigator.language): Locale {
  return language && /^zh\b/i.test(language) ? "zh" : "en";
}

/** The product's name: what the app is called, on every device and in every language. */
export const PRODUCT = "Zirma";

/* The assistant's name, as the user set it (UserSettings.assistant, docs/design/rename-isocline.md §3.2): every
 * sentence in which the assistant speaks or acts says `{assistant}`, and this fills it. A device sets it from the home
 * node's settings; until then it is the default character's. */
let assistant = "Ana";
export const getAssistant = (): string => assistant;
/** The two characters' own names (core settings CHARACTER_NAMES); used when the user has not renamed the assistant. */
export const CHARACTER_NAMES = { ana: "Ana", kata: "Kata" } as const;
export const assistantNameFor = (settings: { character?: "ana" | "kata"; assistantName?: string | null } | null | undefined): string =>
  settings?.assistantName || CHARACTER_NAMES[settings?.character ?? "ana"] || CHARACTER_NAMES.ana;
/** Pages re-render with the state the name came in, so nobody needs telling. */
export function setAssistant(name: string): void {
  if (name) assistant = name;
}

export function translate(locale: Locale, key: Key, vars: Record<string, string | number> = {}): string {
  vars = { assistant, ...vars };
  const template = DICTS[locale][key] ?? DICTS.en[key] ?? key;
  return template
    .replace(/\{(\w+)\|([^|{}]*)\|((?:[^{}]|\{\w+\})*)\}/g, (_, name: string, one: string, other: string) => (Number(vars[name]) === 1 ? one : other))
    .replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/* The language this program speaks now. */
let current: Locale = detectLocale();
const listeners = new Set<() => void>();

/** In a page, tell the browser which language it is (fonts, screen readers); the Mac app's main process has none. */
function markPage(locale: Locale): void {
  const page = (globalThis as { document?: { documentElement: { lang: string } } }).document;
  if (page) page.documentElement.lang = localeTag(locale);
}
markPage(current);

export const getLocale = (): Locale => current;
export function setLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  markPage(locale);
  for (const listener of listeners) listener();
}
export function onLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** In the current language. */
export const t = (key: Key, vars?: Record<string, string | number>): string => translate(current, key, vars);
/** For dates and numbers in the current language. */
export const intlLocale = (): string => localeTag(current);
