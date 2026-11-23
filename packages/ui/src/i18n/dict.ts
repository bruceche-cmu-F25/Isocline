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

export function translate(locale: Locale, key: Key, vars: Record<string, string | number> = {}): string {
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
