/** Opening Settings on one of its tabs from anywhere (a failed turn, the Today page): kept apart from Settings.tsx,
 * which loads only when Settings is first opened. */
export type SettingsTab = "general" | "voice" | "models" | "accounts" | "skills" | "connectors" | "devices";

/** The tab last looked at, on this device. */
export const SETTINGS_TAB_KEY = "zirma.settings.tab";
export const SETTINGS_TAB_EVENT = "zirma:settings-tab";

export function openSettings(tab: SettingsTab): void {
  try { localStorage.setItem(SETTINGS_TAB_KEY, tab); } catch { /* the open page still hears the event */ }
  window.dispatchEvent(new CustomEvent<SettingsTab>(SETTINGS_TAB_EVENT, { detail: tab }));
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get("p") !== "core.settings") location.hash = "p=core.settings";
}
