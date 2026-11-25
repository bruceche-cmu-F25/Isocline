/** Opening Settings on one of its tabs from anywhere (a failed turn, the Today page): kept apart from Settings.tsx,
 * which loads only when Settings is first opened. Otherwise Settings always opens on General. */
export type SettingsTab = "general" | "voice" | "models" | "accounts" | "skills" | "connectors" | "devices";

export const SETTINGS_TAB_EVENT = "zirma:settings-tab";

/** The tab asked for by the next opening of Settings; used once. */
let requested: SettingsTab | null = null;

/** The tab Settings opens on now: the one asked for, if any, else General. */
export function takeSettingsTab(): SettingsTab {
  const tab = requested ?? "general";
  requested = null;
  return tab;
}

export function openSettings(tab: SettingsTab): void {
  requested = tab;
  // Settings may already be open: it takes the tab from the event instead.
  window.dispatchEvent(new CustomEvent<SettingsTab>(SETTINGS_TAB_EVENT, { detail: tab }));
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get("p") !== "core.settings") location.hash = "p=core.settings";
}
