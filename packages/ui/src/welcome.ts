import type { AwayDigest } from "@isocline/protocol";
import { getLocale, translate, type Locale } from "./i18n/dict.ts";

function duration(ms: number, locale: Locale): string {
  if (ms < 60_000) return translate(locale, "away.moment");
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return translate(locale, "away.minutes", { n: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 24) return translate(locale, "away.days", { n: Math.floor(hours / 24) });
  return rest ? translate(locale, "away.hoursMinutes", { h: hours, m: rest }) : translate(locale, "away.hours", { n: hours });
}

/** A recap only has a place in the inbox when it reports work or a decision still waiting. */
export function awayUpdate(digest: AwayDigest, locale: Locale, resultName?: string | null): string {
  const say = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(locale, key, vars);
  const parts: string[] = [];
  const { completed, failed, interrupted, results } = digest.runs;
  const name = resultName ?? results?.[0]?.name;
  if (completed) parts.push(completed === 1 && name ? say("welcome.doneOne", { name }) : say("welcome.doneN", { n: completed }));
  if (failed) parts.push(say("welcome.failed", { n: failed }));
  if (interrupted) parts.push(say("welcome.interrupted", { n: interrupted }));
  if (!completed && digest.changes.todo) parts.push(say("welcome.todos", { n: digest.changes.todo }));
  if (digest.waiting) parts.push(say("welcome.waiting", { n: digest.waiting }));
  return parts.join(say("clause.sep"));
}

/** The greeting keeps its away duration, including on a quiet return. */
export function welcomeLines(digest: AwayDigest, name: string | null, locale: Locale = getLocale()): { greeting: string; summary: string } {
  const greeting = name ? translate(locale, "welcome.greetingName", { name }) : translate(locale, "welcome.greeting");
  const away = translate(locale, "welcome.away", { duration: duration(digest.awayMs, locale) });
  const parts = awayUpdate(digest, locale);
  return { greeting, summary: parts ? translate(locale, "welcome.summary", { away, parts }) : translate(locale, "welcome.quiet", { away }) };
}
