import { useState } from "react";
import type { RemoteResponse } from "@isocline/protocol";
import { api } from "./api.ts";
import { t } from "./i18n/index.ts";

/** The same action is available in a locked coding session and in this device's settings. */
export function RequestDevAccess({ pending, onRequested }: {
  pending: boolean;
  onRequested?(remote: Extract<RemoteResponse, { local: false }>): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = async () => {
    setBusy(true);
    setError(null);
    try {
      const remote = await api.requestDevAccess();
      onRequested?.(remote);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  if (pending) return <span className="quiet small" role="status">{t("devices.dev.pending")}</span>;
  return (
    <>
      <button type="button" className="set-button" disabled={busy} onClick={request}>{t("devices.dev.request")}</button>
      {error && <span className="problem small" role="alert">{error}</span>}
    </>
  );
}
