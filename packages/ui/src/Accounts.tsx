/** Settings → Accounts: Google, connected with one click (docs/design/settings-and-connections.md §3.1).
 *
 * Connecting opens Google's consent page in the system browser (the Mac app sends window.open there; a plain browser
 * may block it, so the waiting card has a link too). Google redirects back to the home node, which keeps the token in
 * the keychain. This page only starts the sign-in and watches it finish. Only on the Mac that holds the credentials.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectFlow, ConnectStart, ConnectionsResponse, GoogleAccount, GoogleCapability, GoogleCheck as Check } from "@alfred/protocol";
import { request as call } from "./api.ts";
import { Logo } from "./brand/Logo.tsx";
import { t, useLocale, type Key } from "./i18n/index.ts";

const CAPS: GoogleCapability[] = ["calRead", "calWrite", "mailRead", "mailModify", "mailSend"];
const capName = (id: GoogleCapability) => t(`settings.cap.${id}` as Key);
const capNote = (id: GoogleCapability) => t(`settings.cap.${id}.note` as Key);
type CheckState = { reading: true } | { error: string } | { result: Check };

const account = (email: string, action: string) => `/api/connections/google/${encodeURIComponent(email)}/${action}`;

/** What happened, kept as data so it is said again in the right language after a switch. */
type Said =
  | { kind: "connected"; email: string; missing: GoogleCapability[] }
  | { kind: "disconnected"; email: string; revoked: boolean };
function say(said: Said): string {
  if (said.kind === "disconnected") return t(said.revoked ? "settings.disconnected" : "settings.disconnected.local", { email: said.email });
  const missing = said.missing.length ? t("settings.notGranted", { caps: said.missing.map(capName).join(t("list.sep")), n: said.missing.length }) : "";
  return `${t("settings.connected", { email: said.email })}${missing ? ` ${missing}` : ""}`;
}

/** A sign-in in progress: which account it is for ("new" for another one), and its link. */
interface Pending { flow: ConnectStart; for: string }

/** `setup`: inside the first run (shell/FirstRun.tsx), only connecting; `onConfigured` hears how many accounts there are. */
export function Accounts({ setup, onConfigured }: { setup?: boolean; onConfigured?(n: number): void } = {}) {
  const locale = useLocale();
  const [data, setData] = useState<ConnectionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<Said | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  // What a new connection asks for: reading by default; changing and sending only if ticked now (or switched on later).
  const [pick, setPick] = useState<GoogleCapability[]>(["calRead", "mailRead"]);
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(() => call<ConnectionsResponse>("/api/connections").then(setData, (reason: Error) => setError(reason.message)), []);
  useEffect(() => { void load(); }, [load]);

  // Watch the sign-in until Google sends the browser back (or the user gives up).
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      call<ConnectFlow>(`/api/connections/flows/${pending.flow.id}`).then((flow) => {
        if (!alive.current || flow.status === "waiting") return;
        setPending(null);
        if (flow.status === "done") setSaid({ kind: "connected", email: flow.account, missing: flow.missing });
        else if (flow.status === "failed") setError(t("settings.failed", { error: flow.error }));
        void load();
      }, () => { setPending(null); void load(); });
    }, 1000);
    return () => clearInterval(timer);
  }, [pending, load]);

  const connect = (capabilities: GoogleCapability[], email?: string) => {
    setError(null);
    setSaid(null);
    call<{ flow: ConnectStart }>("/api/connections/google/connect", { capabilities, ...(email ? { account: email } : {}) }).then(({ flow }) => {
      setPending({ flow, for: email ?? "new" });
      const opened = window.open(flow.url, "_blank");
      if (opened) opened.opener = null;
    }, (reason: Error) => setError(reason.message));
  };
  const cancel = () => {
    if (!pending) return;
    void call(`/api/connections/flows/${pending.flow.id}/cancel`, {}).finally(() => setPending(null));
  };
  const toggle = (item: GoogleAccount, cap: GoogleCapability) => {
    if (item.capabilities.includes(cap)) call(account(item.email, "disable"), { capability: cap }).then(load, (reason: Error) => setError(reason.message));
    else connect([cap], item.email);
  };
  const check = (email: string) => {
    setChecks((current) => ({ ...current, [email]: { reading: true } }));
    call<Check>(account(email, "check")).then(
      (result) => setChecks((current) => ({ ...current, [email]: { result } })),
      (reason: Error) => { setChecks((current) => ({ ...current, [email]: { error: reason.message } })); void load(); },
    );
  };
  const disconnect = (email: string) => {
    setConfirming(null);
    call<{ revoked: boolean }>(account(email, "disconnect"), {}).then(({ revoked }) => {
      setSaid({ kind: "disconnected", email, revoked });
      void load();
    }, (reason: Error) => setError(reason.message));
  };

  const checkLines = (state: CheckState): string[] => {
    if ("reading" in state) return [t("settings.check.reading")];
    if ("error" in state) return [t("settings.check.failed", { error: state.error })];
    const lines = [
      ...(state.result.calendar !== undefined ? [`✓ ${t("settings.check.calendar", { n: state.result.calendar })}`] : []),
      ...(state.result.gmail !== undefined ? [`✓ ${t("settings.check.gmail", { n: state.result.gmail.toLocaleString(locale === "zh" ? "zh-CN" : "en-US") })}`] : []),
    ];
    return lines.length ? lines : [t("settings.check.none")];
  };

  const waitingCard = (where: string) => pending?.for === where && (
    <div className="set-flow">
      <div className="set-flow-head"><span className="pulse" />{t("settings.flow.waiting")}</div>
      <div className="set-actions">
        <a className="set-button" href={pending.flow.url} target="_blank" rel="noopener noreferrer">{t("settings.flow.open")}</a>
        <button type="button" className="set-button ghost" onClick={cancel}>{t("common.cancel")}</button>
      </div>
    </div>
  );

  const google = data?.google;
  const accounts = google ? google.accounts.length : null;
  useEffect(() => { if (accounts !== null) onConfigured?.(accounts); }, [accounts]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="set-section">
      {!setup && <h2>{t("settings.accounts")}</h2>}
      {!setup && <p className="quiet">{t("settings.accounts.sub")}</p>}
      {error && <p className="problem small" role="alert">{error}</p>}
      {said && <p className="set-message" role="status">{say(said)}</p>}

      {!setup && google?.accounts.map((item) => (
        <div className="set-rows" key={item.email}>
          <div className="set-row has-logo">
            <span className="set-logo" data-k="gray"><Logo name="google" /></span>
            <span className="set-name">{item.email}</span>
            <span className="set-note">{t("settings.googleAccount")}</span>
            <span className="set-end">
              {item.broken
                ? <span className="set-status need">{t("settings.status.reconnect")}</span>
                : <span className="set-status on">{t("settings.status.connected")}</span>}
              {item.broken
                ? <button type="button" className="set-button" onClick={() => connect(item.capabilities, item.email)}>{t("settings.reconnect")}</button>
                : <button type="button" className="set-button ghost" onClick={() => check(item.email)}>{t("settings.try")}</button>}
              <button type="button" className="set-button ghost" onClick={() => setConfirming(item.email)}>{t("settings.disconnect")}</button>
            </span>
          </div>
          {confirming === item.email && (
            <div className="set-flow">
              {t("settings.disconnect.confirm")}
              <div className="set-actions">
                <button type="button" className="set-button" onClick={() => disconnect(item.email)}>{t("settings.disconnect")}</button>
                <button type="button" className="set-button ghost" onClick={() => setConfirming(null)}>{t("common.cancel")}</button>
              </div>
            </div>
          )}
          {checks[item.email] && <div className="set-check small">{checkLines(checks[item.email]).map((line) => <div key={line}>{line}</div>)}</div>}
          {waitingCard(item.email)}
          {CAPS.map((cap) => {
            const on = item.capabilities.includes(cap);
            return (
              <div className="set-row sub has-logo" key={cap}>
                <Logo name={cap.startsWith("cal") ? "google-calendar" : "gmail"} />
                <span className="set-name">{capName(cap)}</span>
                <span className="set-note">{capNote(cap)}</span>
                <span className="set-end">
                  <button type="button" className="set-switch" role="switch" aria-checked={on} aria-label={capName(cap)}
                    disabled={!!pending || item.broken} onClick={() => toggle(item, cap)} />
                </span>
              </div>
            );
          })}
        </div>
      ))}

      <div className="set-hero">
        <div className="set-hero-head">
          <span className="set-logo" data-k="gray"><Logo name="google" /></span>
          <div>
            <b>{google?.accounts.length ? t("settings.google.another") : "Google"}</b>
            <p className="quiet small">{t("settings.google.blurb")}</p>
          </div>
        </div>
        {google && !google.client.configured ? (
          <p className="problem small">{t("settings.google.noClient")}</p>
        ) : pending?.for === "new" ? waitingCard("new") : (
          <>
            <div className="chips set-chips">
              {CAPS.map((cap) => (
                <button type="button" key={cap} className="chip" aria-pressed={pick.includes(cap)}
                  onClick={() => setPick((current) => (current.includes(cap) ? current.filter((item) => item !== cap) : CAPS.filter((item) => item === cap || current.includes(item))))}>{capName(cap)}</button>
              ))}
            </div>
            <div className="set-actions">
              <button type="button" className="set-button" disabled={!google || !!pending || pick.length === 0}
                onClick={() => connect(pick)}>{t("settings.google.connect")}</button>
            </div>
          </>
        )}
        <p className="quiet small">{t("settings.google.privacy")}</p>
      </div>
    </section>
  );
}
