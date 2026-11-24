/** Shown on a device that reached the home node through Tailscale but is not paired (docs/research/remote-access.md).
 * The QR code on the Mac links here with `?pair=<code>`, so scanning pairs at once; otherwise the code is typed.
 * The home node answers with the device token in an HttpOnly cookie, so this page never sees it.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { DeviceKind } from "@zirma/protocol";
import { api } from "./api.ts";
import { Figure } from "./shell/Figure.tsx";
import { t } from "./i18n/index.ts";
import "./settings.css";
import { Wordmark } from "./Wordmark.tsx";

/** A name and kind the user would recognise in the Mac's device list. */
function thisDevice(): { name: string; kind: DeviceKind } {
  const agent = navigator.userAgent;
  if (/iPhone/.test(agent)) return { name: "iPhone", kind: "phone" };
  if (/iPad/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)) return { name: "iPad", kind: "browser" };
  if (/Android/.test(agent)) return { name: /Mobile/.test(agent) ? "Android" : "Android tablet", kind: /Mobile/.test(agent) ? "phone" : "browser" };
  if (/Macintosh/.test(agent)) return { name: "Mac", kind: "browser" };
  if (/Windows/.test(agent)) return { name: "Windows", kind: "browser" };
  return { name: "Browser", kind: "browser" };
}

export function Pair({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tried = useRef(false);

  const pair = (value: string) => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    const device = thisDevice();
    api.pair(value, device.name, device.kind).then(() => {
      // Drop the spent code from the address (and from the home screen's start page).
      history.replaceState(null, "", location.pathname);
      onPaired();
    }, (reason: Error) => { setBusy(false); setError(reason.message); });
  };

  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    const fromLink = new URLSearchParams(location.search).get("pair");
    if (fromLink) { setCode(fromLink); pair(fromLink); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (event: FormEvent) => { event.preventDefault(); pair(code); };

  return (
    <main className="boot pair">
      <Figure state={busy ? "flow" : error ? "error" : "hello"} size={88} />
      <Wordmark />
      <h1 className="pair-title">{t("pair.title")}</h1>
      <p className="quiet">{t("pair.sub")}</p>
      <p className="quiet small pair-how">{t("pair.how")}</p>
      <form className="pair-form" onSubmit={submit}>
        <input className="pair-code" value={code} onChange={(event) => setCode(event.target.value)} aria-label={t("pair.code")}
          placeholder="ABCD-EFGH" autoCapitalize="characters" autoComplete="one-time-code" autoCorrect="off" spellCheck={false} maxLength={12} disabled={busy} />
        <button type="submit" className="set-button" disabled={busy || !code.trim()}>{busy ? t("pair.working") : t("pair.submit")}</button>
      </form>
      {error && <p className="problem small" role="alert">{error}</p>}
    </main>
  );
}
