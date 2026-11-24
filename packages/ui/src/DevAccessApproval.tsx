import { useState } from "react";
import type { DeviceInfo, RemoteResponse } from "@isocline/protocol";
import { api } from "./api.ts";
import { t } from "./i18n/index.ts";

/** The home node shows the same decision in the workspace and beside the requesting device in Settings. */
export function DevAccessApproval({ device, onDecision }: {
  device: Pick<DeviceInfo, "id" | "name">;
  onDecision(response: RemoteResponse): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function decide(allow: boolean) {
    setBusy(true);
    setError("");
    try {
      onDecision(await api.deviceScope(device.id, { scope: "dev", enabled: allow, onlyIfRequested: true }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="set-flow dev-approval">
      <strong>{t("dev.accessRequest", { name: device.name })}</strong>
      <p>{t("dev.accessScope")}</p>
      <div className="set-actions">
        <button type="button" className="set-button" disabled={busy} onClick={() => void decide(true)}>{t("dev.allowDevice")}</button>
        <button type="button" className="set-button ghost" disabled={busy} onClick={() => void decide(false)}>{t("common.deny")}</button>
      </div>
      {error && <p className="problem small" role="alert">{error}</p>}
    </div>
  );
}
