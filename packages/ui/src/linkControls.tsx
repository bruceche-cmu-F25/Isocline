import { useState, type ReactNode } from "react";
import type { LinkOp } from "@zirma/module-links/types";
import { api } from "./api.ts";

export function linkFileUrl(key?: string) {
  return key ? "/api/modules/link/files/" + encodeURIComponent(key) : undefined;
}

/** A site's own icon, kept and served by the home node (never asked of the site from here); `fallback` until it
 * loads, and for good when there is none. */
export function SiteIcon({ icon, fallback }: { icon: string | undefined; fallback: ReactNode }) {
  const [broken, setBroken] = useState(false);
  const src = linkFileUrl(icon);
  if (!icon || broken) return <>{fallback}</>;
  return <img className="lk-icon" src={src} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />;
}

/** Runs a module operation; an `{ error }` answer is shown like a failure. */
export function useOp(onError: (message: string | null) => void) {
  const [busy, setBusy] = useState(false);
  const run = (op: LinkOp, input: unknown, then?: (result: unknown) => void) => {
    setBusy(true);
    onError(null);
    return api.op(op, input).then((response) => {
      const result = response.result as { error?: string } | null;
      if (result && typeof result.error === "string") onError(result.error);
      else then?.(result);
    }).catch((reason: Error) => onError(reason.message)).finally(() => setBusy(false));
  };
  return { busy, run };
}
