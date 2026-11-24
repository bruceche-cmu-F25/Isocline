/** Settings → Devices (docs/research/remote-access.md). On the Mac: one switch that has Tailscale Serve reach Zirma,
 * the address, pairing with a QR code, and the device list. On another device: just itself, and a way to disconnect.
 */
import { Fragment, useEffect, useState } from "react";
import { encode } from "uqr";
import type { DeviceInfo, PairingCode, RemoteResponse } from "@zirma/protocol";
import { WebLockSetting } from "./WebLockSetting.tsx";
import { api } from "./api.ts";
import { DevAccessApproval } from "./DevAccessApproval.tsx";
import { RequestDevAccess } from "./RequestDevAccess.tsx";
import { Logo } from "./brand/Logo.tsx";
import { intlLocale, t, type Key } from "./i18n/index.ts";
import { disablePush, enablePush, pushSupport } from "./push.ts";

type Local = Extract<RemoteResponse, { local: true }>;

/** Tailscale's download page picks the right store for the device that opens it (App Store, Play, Mac, Windows). */
const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";
const DownloadLink = () => <a className="dev-link" href={TAILSCALE_DOWNLOAD} target="_blank" rel="noopener noreferrer">{t("devices.ts.install")} ↗</a>;

/** The QR code as plain SVG squares (nothing injected as HTML). */
function Qr({ text }: { text: string }) {
  const { data, size } = encode(text, { border: 2 });
  const cells: string[] = [];
  data.forEach((row, y) => row.forEach((dark, x) => { if (dark) cells.push(`M${x} ${y}h1v1h-1z`); }));
  return (
    <svg className="dev-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={text} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={cells.join("")} fill="#111" />
    </svg>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString(intlLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function DeviceRow({ device, onRevoke, onDev }: { device: DeviceInfo; onRevoke?: () => void; onDev?: (enabled: boolean) => void }) {
  const [confirming, setConfirming] = useState(false);
  const dev = !!device.scopes?.includes("dev");
  return (
    <>
      <div className="set-row">
        <span className="set-name">{device.name}</span>
        <span className="set-note">
          {t(`devices.kind.${device.kind}` as Key)} · {device.lastSeenAt ? t("devices.seen", { when: when(device.lastSeenAt) }) : t("devices.never")}
          {device.via ? ` · ${device.via}` : ""}
          {device.push ? ` · ${t("push.on")}` : ""}
        </span>
        {onRevoke && (
          <span className="set-end">
            <button type="button" className="set-button ghost" onClick={() => setConfirming(true)}>{t("devices.revoke")}</button>
          </span>
        )}
      </div>
      {onDev && (
        <div className="set-row sub">
          <span className="set-name">{t("devices.dev")}</span>
          <span className="set-note">{t("devices.dev.note")}</span>
          <span className="set-end">
            <button type="button" className="set-switch" role="switch" aria-checked={dev} aria-label={t("devices.dev.label", { name: device.name })} onClick={() => onDev(!dev)} />
          </span>
        </div>
      )}
      {confirming && onRevoke && (
        <div className="set-flow">
          {t("devices.revoke.confirm")}
          <div className="set-actions">
            <button type="button" className="set-button" onClick={() => { setConfirming(false); onRevoke(); }}>{t("devices.revoke")}</button>
            <button type="button" className="set-button ghost" onClick={() => setConfirming(false)}>{t("common.cancel")}</button>
          </div>
        </div>
      )}
    </>
  );
}

function CopyAddress({ url, label, primary = false }: { url: string; label: string; primary?: boolean }) {
  const [status, setStatus] = useState<"ready" | "copied" | "manual">("ready");
  useEffect(() => {
    if (status !== "copied") return;
    const timer = setTimeout(() => setStatus("ready"), 1500);
    return () => clearTimeout(timer);
  }, [status]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setStatus("copied");
    } catch {
      setStatus("manual");
    }
  };

  if (status === "manual") {
    return <label className="quiet small">{t("devices.manualCopy")} <input type="text" readOnly value={url}
      autoFocus onFocus={(event) => event.currentTarget.select()} /></label>;
  }
  return <button type="button" className={primary ? "set-button" : "set-button ghost"} onClick={() => void copy()}>
    {status === "copied" ? t("devices.copied") : label}
  </button>;
}

/** On the Mac. */
function Manage({ remote, onChange, onError }: { remote: Local; onChange(next: RemoteResponse): void; onError(message: string | null): void }) {
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState<PairingCode | null>(null);

  const fail = (reason: Error) => onError(reason.message);
  const reload = () => api.remote().then(onChange, fail);

  // A device that just paired shows up in the list; the code it spent goes away.
  useEffect(() => {
    if (!pairing) return;
    const count = remote.devices.length;
    const timer = setInterval(() => api.remote().then((next) => {
      if (!next.local) return;
      onChange(next);
      if (next.devices.length > count) setPairing(null);
    }, () => {}), 2000);
    const expire = setTimeout(() => setPairing(null), Date.parse(pairing.expiresAt) - Date.now());
    return () => { clearInterval(timer); clearTimeout(expire); };
  }, [pairing]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = () => {
    setBusy(true);
    onError(null);
    setPairing(null);
    api.setRemote(!remote.enabled).then(onChange, fail).finally(() => setBusy(false));
  };
  const newCode = () => { onError(null); api.pairingCode().then(setPairing, fail); };
  const revoke = (id: string) => api.revokeDevice(id).then(onChange, fail);

  const ts = remote.tailscale;
  const minutes = pairing ? Math.max(1, Math.round((Date.parse(pairing.expiresAt) - Date.now()) / 60_000)) : 0;
  return (
    <>
      <div className="set-rows">
        <div className="set-row has-logo">
          <span className="set-logo" data-k="gray"><Logo name="tailscale" /></span>
          <span className="set-name">{t("devices.remote")}</span>
          <span className="set-note">{t("devices.remote.note")} <DownloadLink /></span>
          <span className="set-end">
            {remote.serving && <span className="set-status on">{t("settings.status.connected")}</span>}
            <button type="button" className="set-switch" role="switch" aria-checked={remote.enabled} aria-label={t("devices.remote")}
              disabled={busy || (!remote.enabled && !ts.running)} onClick={toggle} />
          </span>
        </div>

        {!ts.installed && (
          <div className="set-flow">
            {t("devices.ts.missing")}
            <div className="set-actions">
              <a className="set-button" href={TAILSCALE_DOWNLOAD} target="_blank" rel="noopener noreferrer">{t("devices.ts.install")}</a>
              <button type="button" className="set-button ghost" onClick={() => void reload()}>{t("devices.ts.retry")}</button>
            </div>
          </div>
        )}
        {ts.installed && !ts.running && (
          <div className="set-flow">
            {t("devices.ts.loggedOut")}
            <div className="set-actions"><button type="button" className="set-button ghost" onClick={() => void reload()}>{t("devices.ts.retry")}</button></div>
          </div>
        )}
        {remote.enabled && remote.error && <p className="problem small">{remote.error}</p>}

        {remote.serving && remote.url && (
          <div className="set-row sub">
            <span className="set-name">{t("devices.address")}</span>
            <span className="set-note dev-url">{remote.url}</span>
            <span className="set-end">
              <CopyAddress key={remote.url} url={remote.url} label={t("devices.copy")} />
            </span>
          </div>
        )}
      </div>

      {remote.serving && (
        pairing ? (
          <div className="set-hero dev-pair">
            {pairing.url && <Qr text={pairing.url} />}
            <div className="dev-pair-text">
              <ol className="dev-steps">
                <li>{t("devices.pair.step1")} <DownloadLink /></li>
                <li>{t("devices.pair.step2")}</li>
              </ol>
              <div className="dev-code-label quiet small">{t("devices.pair.code")}</div>
              <div className="dev-code">{pairing.code}</div>
              <p className="quiet small">{t("devices.pair.expires", { min: minutes })}</p>
              <div className="set-actions">
                {pairing.url && <CopyAddress key={pairing.url} url={pairing.url} label={t("devices.pair.copyLink")} primary />}
                <button type="button" className="set-button ghost" onClick={newCode}>{t("devices.pair.new")}</button>
                <button type="button" className="set-button ghost" onClick={() => setPairing(null)}>{t("common.close")}</button>
              </div>
            </div>
          </div>
        ) : (
          <div className="set-actions"><button type="button" className="set-button" onClick={newCode}>{t("devices.pair")}</button></div>
        )
      )}

      {typeof remote.webLockEnabled === "boolean" && <WebLockSetting enabled={remote.webLockEnabled} onChange={onChange} />}

      <h3 className="set-sub">{t("devices.list")}</h3>
      <div className="set-rows">
        <div className="set-row">
          <span className="set-name">{t("devices.thisMac")}</span>
          <span className="set-note">{t("devices.thisMac.note")}</span>
        </div>
        {remote.devices.map((device) => (
          <Fragment key={device.id}>
            <DeviceRow device={device} onRevoke={() => void revoke(device.id)}
              onDev={device.devAccessRequested ? undefined : (enabled) => void api.deviceScope(device.id, { scope: "dev", enabled }).then(onChange, fail)} />
            {device.devAccessRequested && <DevAccessApproval device={device} onDecision={onChange} />}
          </Fragment>
        ))}
        {!remote.devices.length && <p className="quiet small dev-none">{t("devices.none")}</p>}
      </div>
      {remote.devices.length > 0 && <p className="quiet small">{t("devices.scope")}</p>}
    </>
  );
}

/** On another device. */
/** Push notifications on this device: a notice nobody takes within seconds (you are away from the Mac) comes here. */
function Notifications({ device }: { device: DeviceInfo }) {
  const [on, setOn] = useState(!!device.push);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const support = pushSupport();
  const toggle = () => {
    setBusy(true);
    setSaid(null);
    (on ? disablePush() : enablePush()).then(
      () => setOn(!on),
      (reason: Error) => setSaid(reason.message === "denied" ? t("push.denied") : t("push.failed", { error: reason.message })),
    ).finally(() => setBusy(false));
  };
  const test = () => {
    setSaid(null);
    api.pushTest().then((result) => setSaid(result.accepted ? t("push.sent") : t("push.notSent")), (reason: Error) => setSaid(reason.message));
  };
  return (
    <>
      <div className="set-row">
        <span className="set-name">{t("push.title")}</span>
        <span className="set-note">{support === "homeScreen" ? t("push.homeScreen") : support === "unsupported" ? t("push.unsupported") : support === "denied" && !on ? t("push.denied") : t("push.note")}</span>
        <span className="set-end">
          {on && support === "ok" && <button type="button" className="set-button ghost" onClick={test}>{t("push.test")}</button>}
          <button type="button" className="set-switch" role="switch" aria-checked={on} aria-label={t("push.title")}
            disabled={busy || (!on && support !== "ok")} onClick={toggle} />
        </span>
      </div>
      {said && <p className="set-message" role="status">{said}</p>}
    </>
  );
}

function Self({ device, onChange }: { device: DeviceInfo; onChange(next: RemoteResponse): void }) {
  const [confirming, setConfirming] = useState(false);
  const forget = () => disablePush().catch(() => {}).then(() => api.forgetDevice()).finally(() => location.reload());
  return (
    <>
      <p className="quiet small">{t("devices.self.note")}</p>
      <div className="set-rows">
        <DeviceRow device={device} />
        <div className="set-row device-access">
          <span className="set-name">{t("devices.dev")}</span>
          <span className="set-note">{t("devices.dev.note")}</span>
          <div className="set-end">
            {device.scopes?.includes("dev") ? <span className="set-status on">{t("devices.dev.allowed")}</span>
              : device.devAccessRequested === undefined ? <span className="quiet small">{t("dev.needsScope")}</span>
              : <RequestDevAccess pending={device.devAccessRequested} onRequested={onChange} />}
          </div>
        </div>
        <Notifications device={device} />
      </div>
      {confirming ? (
        <div className="set-flow">
          {t("devices.forget.confirm")}
          <div className="set-actions">
            <button type="button" className="set-button" onClick={() => void forget()}>{t("devices.forget")}</button>
            <button type="button" className="set-button ghost" onClick={() => setConfirming(false)}>{t("common.cancel")}</button>
          </div>
        </div>
      ) : (
        <div className="set-actions"><button type="button" className="set-button ghost" onClick={() => setConfirming(true)}>{t("devices.forget")}</button></div>
      )}
    </>
  );
}

export function Devices({ remote, onChange }: { remote: RemoteResponse | null; onChange(next: RemoteResponse): void }) {
  const [error, setError] = useState<string | null>(null);
  if (!remote) return null;
  return (
    <section className="set-section">
      <h2>{remote.local ? t("devices.title") : t("devices.self")}</h2>
      {remote.local && <p className="quiet">{t("devices.sub")}</p>}
      {error && <p className="problem small" role="alert">{error}</p>}
      {remote.local ? <Manage remote={remote} onChange={onChange} onError={setError} /> : <Self device={remote.device} onChange={onChange} />}
    </section>
  );
}
