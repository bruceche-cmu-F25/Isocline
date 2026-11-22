import { createContext, useContext, useState, type ReactNode } from "react";
import { api } from "./api.ts";

/** The sample page uses the same components with its own operation and file endpoints. */
export const LinkLibrary = createContext({
  op: api.op,
  files: "/api/modules/link/files/",
});

export function useLinkFile(key?: string) {
  const { files } = useContext(LinkLibrary);
  return key ? files + encodeURIComponent(key) : undefined;
}

/** A site's own icon, kept and served by the home node (never asked of the site from here); `fallback` until it
 * loads, and for good when there is none. */
export function SiteIcon({ icon, fallback }: { icon: string | undefined; fallback: ReactNode }) {
  const [broken, setBroken] = useState(false);
  const src = useLinkFile(icon);
  if (!icon || broken) return <>{fallback}</>;
  return <img className="lk-icon" src={src} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />;
}

/** Runs a module operation; an `{ error }` answer is shown like a failure. */
export function useOp(onError: (message: string | null) => void) {
  const library = useContext(LinkLibrary);
  const [busy, setBusy] = useState(false);
  const run = (op: string, input: unknown, then?: (result: unknown) => void) => {
    setBusy(true);
    onError(null);
    return library.op(op, input).then((response) => {
      const result = response.result as { error?: string } | null;
      if (result && typeof result.error === "string") onError(result.error);
      else then?.(result);
    }).catch((reason: Error) => onError(reason.message)).finally(() => setBusy(false));
  };
  return { busy, run };
}
