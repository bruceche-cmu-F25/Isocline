/** Before Google can be connected, this Zirma needs an OAuth client of the user's own: Zirma is open source, and
 * each copy signs in through a Google Cloud project its owner made. Four steps in Google Cloud, then the downloaded
 * file is picked here and the home node keeps it (POST /api/connections/google/client). Nobody has to find a folder.
 */
import { useRef, useState } from "react";
import type { ConnectionsResponse } from "@zirma/protocol";
import { request as call } from "./api.ts";
import { t, type Key } from "./i18n/index.ts";

const STEPS: Array<{ key: Key; links: Array<{ label: Key; href: string }> }> = [
  { key: "gclient.step.project", links: [{ label: "gclient.link.project", href: "https://console.cloud.google.com/projectcreate" }] },
  { key: "gclient.step.apis", links: [
    { label: "gclient.link.calendar", href: "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" },
    { label: "gclient.link.gmail", href: "https://console.cloud.google.com/apis/library/gmail.googleapis.com" },
  ] },
  { key: "gclient.step.consent", links: [{ label: "gclient.link.consent", href: "https://console.cloud.google.com/auth/overview" }] },
  { key: "gclient.step.client", links: [{ label: "gclient.link.client", href: "https://console.cloud.google.com/auth/clients/create" }] },
];

/** What is wrong with a picked file, before it is sent; null when it looks like a Desktop app client. */
export function clientProblem(file: unknown): Key | null {
  if (!file || typeof file !== "object") return "gclient.err.notClient";
  const record = file as Record<string, unknown>;
  if (record.web && !record.installed) return "gclient.err.web";
  const entry = record.installed as { client_id?: unknown; client_secret?: unknown } | undefined;
  if (!entry || typeof entry.client_id !== "string" || !entry.client_id.endsWith(".apps.googleusercontent.com") || typeof entry.client_secret !== "string") {
    return "gclient.err.notClient";
  }
  return null;
}

export function GoogleClientSetup({ onSaved }: { onSaved(next: ConnectionsResponse): void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    let parsed: unknown;
    try { parsed = JSON.parse(await file.text()); } catch { setError(t("gclient.err.notClient")); return; }
    const problem = clientProblem(parsed);
    if (problem) { setError(t(problem)); return; }
    setBusy(true);
    call<ConnectionsResponse>("/api/connections/google/client", { client: parsed })
      .then(onSaved, (reason: Error) => setError(reason.message))
      .finally(() => { setBusy(false); if (input.current) input.current.value = ""; });
  };

  return (
    <div className="gclient">
      <p className="small">{t("gclient.lead")}</p>
      {!open ? (
        <div className="set-actions">
          <button type="button" className="set-button" onClick={() => setOpen(true)}>{t("gclient.start")}</button>
        </div>
      ) : (
        <>
          <ol className="gclient-steps">
            {STEPS.map((step) => (
              <li key={step.key}>
                <span>{t(step.key)}</span>
                <span className="gclient-links">
                  {step.links.map((link) => <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer">{t(link.label)}</a>)}
                </span>
              </li>
            ))}
          </ol>
          <div className="set-actions">
            <button type="button" className="set-button" disabled={busy} onClick={() => input.current?.click()}>{t(busy ? "gclient.saving" : "gclient.pick")}</button>
          </div>
          <input ref={input} type="file" accept=".json,application/json" hidden onChange={(event) => void pick(event.target.files?.[0])} />
        </>
      )}
      {error && <p className="problem small" role="alert">{error}</p>}
    </div>
  );
}
