import { useState, type FormEvent } from "react";
import type { RemoteResponse } from "@isocline/protocol";
import { api } from "./api.ts";
import { t } from "./i18n/index.ts";

/** Only the home Mac can enable, reset or remove the remote-browser password. */
export function WebLockSetting({ enabled, onChange }: { enabled: boolean; onChange(next: RemoteResponse): void }) {
  const [editing, setEditing] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const close = () => {
    setEditing(false);
    setPassword("");
    setConfirmation("");
    setError("");
  };
  const save = async (enable: boolean) => {
    setBusy(true);
    setError("");
    try {
      onChange(await api.setWebLock(enable, enable ? password : undefined));
      close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("webLock.unavailable"));
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const length = [...password].length;
    if (length < 12 || length > 128) return setError(t("webLock.length"));
    if (password !== confirmation) return setError(t("webLock.mismatch"));
    void save(true);
  };
  return <div className="set-rows">
    <div className="set-row">
      <span className="set-name">{t("webLock.setting")}</span>
      <span className="set-note">{t("webLock.note")}</span>
      <span className="set-end">
        {enabled && !editing && <button type="button" className="set-button ghost" onClick={() => setEditing(true)}>{t("webLock.change")}</button>}
        <button type="button" className="set-switch" role="switch" aria-label={t("webLock.setting")} aria-checked={enabled}
          disabled={busy} onClick={() => enabled ? void save(false) : editing ? close() : setEditing(true)} />
      </span>
    </div>
    {editing && <form className="set-flow web-password-form" onSubmit={submit}>
      <label>{t("webLock.password")}
        <input className="model-input" type="password" autoComplete="new-password" required disabled={busy}
          value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      <label>{t("webLock.confirm")}
        <input className="model-input" type="password" autoComplete="new-password" required disabled={busy}
          value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
      </label>
      <p className="quiet small">{t("webLock.length")} {t("webLock.relock")}</p>
      <div className="set-actions">
        <button type="submit" className="set-button" disabled={busy}>{t(enabled ? "webLock.save" : "webLock.enable")}</button>
        <button type="button" className="set-button ghost" disabled={busy} onClick={close}>{t("common.cancel")}</button>
      </div>
    </form>}
    {error && <p className="problem small" role="alert">{error}</p>}
  </div>;
}
