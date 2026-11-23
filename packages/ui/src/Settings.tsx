/** Settings, one tab per kind of thing (docs/design/settings-and-connections.md §3.7; the tabs after pi-web's
 * settings panel, github.com/agegr/pi-web, MIT): General, Models, Accounts, Skills, Connectors, Devices.
 *
 * Paired devices can view subscription usage. Credentials, skills and connectors are managed on the home node. A tab
 * that was opened stays mounted while the page is, so a sign-in that is waiting for the browser is not lost by
 * looking at another tab. The tab last looked at is where the page opens next time, on this device.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { RemoteResponse, StateResponse } from "@alfred/protocol";
import { api, ApiError } from "./api.ts";
import type { Alfred } from "./useAlfred.ts";
import { Accounts } from "./Accounts.tsx";
import { Connectors } from "./Connectors.tsx";
import { Devices } from "./Devices.tsx";
import { General, type GeneralProps } from "./General.tsx";
import { Areas } from "./Areas.tsx";
import { Preferences } from "./Preferences.tsx";
import { PagesSetting } from "./PagesSetting.tsx";
import { ModelSettings } from "./ModelSettings.tsx";
import { SubscriptionUsage } from "./SubscriptionUsage.tsx";
import { Skills } from "./Skills.tsx";
import { t, useLocale, type Key } from "./i18n/index.ts";
import { Icon, type IconName } from "./shell/icons.tsx";
import "./settings.css";

type Tab = "general" | "models" | "accounts" | "skills" | "connectors" | "devices";
/** `home`: only where Alfred runs. */
const TABS: Array<{ id: Tab; icon: IconName; home?: true }> = [
  { id: "general", icon: "gear" },
  { id: "models", icon: "model" },
  { id: "accounts", icon: "person", home: true },
  { id: "skills", icon: "layers", home: true },
  { id: "connectors", icon: "plug", home: true },
  { id: "devices", icon: "phone" },
];
const KEY = "alfred.settings.tab";
const saved = (): Tab => { try { const value = localStorage.getItem(KEY); return TABS.some((tab) => tab.id === value) ? value as Tab : "general"; } catch { return "general"; } };

export function Settings({ name, saveName, dockOptions, onEvent, state }: GeneralProps & Pick<Alfred, "onEvent"> & { state: StateResponse }) {
  useLocale();
  /** Null until known; an older home node without remote access answers 404, which is treated as the Mac. */
  const [remote, setRemote] = useState<RemoteResponse | null | "old" | "unavailable">(null);
  const [tab, setTab] = useState<Tab>(saved);
  const [opened, setOpened] = useState<ReadonlySet<Tab>>(() => new Set([tab]));
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let latest = 0;
    const reload = () => {
      const request = ++latest;
      api.remote().then((next) => { if (request === latest) setRemote(next); }, (error) => {
        if (request === latest) setRemote((last) => last ?? (error instanceof ApiError && error.status === 404 ? "old" : "unavailable"));
      });
    };
    const stop = onEvent((event) => { if (event.kind.startsWith("device.")) reload(); });
    reload();
    return () => { ++latest; stop(); };
  }, [onEvent]);

  const device = typeof remote === "object" ? remote : null;
  const local = remote === "old" || device?.local === true;
  const tabs = TABS.filter((item) => (local || !item.home) && (item.id !== "devices" || remote !== "old"));
  // A tab that is the Mac's, remembered from there, is not this device's to show.
  const shown = tabs.some((item) => item.id === tab) ? tab : "general";
  // In a narrow column the row of tabs scrolls sideways: the one that is open is brought into sight.
  useEffect(() => { list.current?.querySelector(`#set-tab-${shown}`)?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [shown, tabs.length]);
  const open = (next: Tab) => {
    setTab(next);
    setOpened((current) => new Set(current).add(next));
    try { localStorage.setItem(KEY, next); } catch { /* opens on General next time */ }
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = tabs[(tabs.findIndex((item) => item.id === shown) + step + tabs.length) % tabs.length].id;
    open(next);
    list.current?.querySelector<HTMLButtonElement>(`#set-tab-${next}`)?.focus();
  };
  const pane = (id: Tab, content: ReactNode) => (opened.has(id) || shown === id) && tabs.some((item) => item.id === id) && (
    <div className="set-pane" role="tabpanel" id={`set-pane-${id}`} aria-labelledby={`set-tab-${id}`} hidden={shown !== id}>{content}</div>
  );

  return (
    <div className="settings">
      <div className="set-tabs" role="tablist" aria-label={t("page.settings")} ref={list} onKeyDown={onKey}>
        {tabs.map((item) => (
          <button type="button" key={item.id} id={`set-tab-${item.id}`} className="set-tab" role="tab" aria-selected={shown === item.id} aria-controls={`set-pane-${item.id}`}
            tabIndex={shown === item.id ? 0 : -1} onClick={() => open(item.id)}>
            <Icon name={item.icon} />{t(`settings.tab.${item.id}` as Key)}
          </button>
        ))}
      </div>
      {pane("general", <><General name={name} saveName={saveName} dockOptions={dockOptions} /><Preferences state={state} /><Areas state={state} /><PagesSetting state={state} /></>)}
      {pane("models", local ? <ModelSettings /> : remote === null
        ? <p className="quiet" role="status">{t("models.usage.checking")}</p>
        : <SubscriptionUsage />)}
      {pane("accounts", <Accounts />)}
      {pane("skills", <Skills />)}
      {pane("connectors", <Connectors />)}
      {pane("devices", <Devices remote={device} onChange={setRemote} />)}
    </div>
  );
}
