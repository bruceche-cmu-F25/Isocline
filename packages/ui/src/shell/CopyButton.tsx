import { useEffect, useState } from "react";
import { t } from "../i18n/index.ts";
import { Icon } from "./icons.tsx";

/** Copies `text`; for a moment the icon is a tick and the label says it was copied (or, where the browser refuses,
 * to select the text by hand). */
export function CopyButton({ text, label, className, showLabel }: { text: () => string; label: string; className?: string; showLabel?: boolean }) {
  const [done, setDone] = useState<"copied" | "manual" | null>(null);
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(null), done === "copied" ? 1600 : 4000);
    return () => window.clearTimeout(timer);
  }, [done]);
  const said = done === "copied" ? t("conv.copied") : done === "manual" ? t("conv.copyManually") : label;
  return (
    <button type="button" className={`copy-btn${className ? ` ${className}` : ""}`} data-done={done ?? undefined} aria-label={said} title={said}
      onClick={(event) => {
        event.stopPropagation();
        navigator.clipboard.writeText(text()).then(() => setDone("copied"), () => setDone("manual"));
      }}>
      <Icon name={done === "copied" ? "check" : "copy"} />
      {showLabel
        ? <span role="status">{done === "copied" ? t("conv.copied") : label}</span>
        : <span className="sr-only" role="status">{done ? said : ""}</span>}
    </button>
  );
}
