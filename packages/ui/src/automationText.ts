/** How automations are worded, in the current language: their names, schedules and times. Pure, so the inbox's read
 * model and the pages share it. */
import type { Automation, Schedule } from "@zirma/protocol";
import { intlLocale, t, type Key } from "./i18n/index.ts";

export const pad = (n: number) => String(n).padStart(2, "0");
export const hhmm = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** An automation's name in the current language: the user's, or the template's. */
export const automationTitle = (automation: Pick<Automation, "name" | "template">): string =>
  automation.name ?? (automation.template ? t(`auto.tpl.${automation.template}` as Key) : "");

/** "Every day at 07:30", "Weekdays at 09:00", "Mo, We at 18:00". */
export function scheduleText(schedule: Schedule): string {
  const at = schedule.at;
  const days = schedule.days.join(",");
  if (days === "1,2,3,4,5,6,7") return t("auto.every", { at });
  if (days === "1,2,3,4,5") return t("auto.workdays", { at });
  if (days === "6,7") return t("auto.weekends", { at });
  const names = t("auto.dayNames").split(",");
  return t("auto.someDays", { days: schedule.days.map((day) => names[day - 1]).join(t("auto.daySep")), at });
}

/** "today 07:30", "tomorrow 07:30", "Fri 07:30", or a date further out. */
export function whenText(iso: string, now: number = Date.now()): string {
  const date = new Date(iso);
  const midnight = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((midnight(date) - midnight(new Date(now))) / 86_400_000);
  const at = hhmm(date);
  if (days === 0) return t("auto.today", { at });
  if (days === 1) return t("auto.tomorrow", { at });
  if (Math.abs(days) < 7) return t("auto.dayAt", { day: t("todo.weekdays").split(",")[date.getDay()], at });
  return t("auto.dayAt", { day: `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, at });
}

/** Keep an edition's calendar date visible even when the inbox is opened another day. */
export function editionDate(at: string): string {
  return new Date(at).toLocaleDateString(intlLocale(), { year: "numeric", month: "short", day: "numeric" });
}

export const editionTitle = (name: string, at: string) => t("auto.edition", { name, date: editionDate(at) });
