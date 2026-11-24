import { useEffect, useRef, useState } from "react";
import type { Run } from "@isocline/protocol";
import { createFigure, drawFigurePose } from "./entity/tesseract.js";
import { t } from "./i18n/index.ts";
import { errorText } from "./receipts.ts";
import { Icon } from "./shell/icons.tsx";
import { openSettings } from "./settingsTab.ts";

/** A turn that fails in view shakes briefly. Reading an old turn paints the same crossed beams at rest. */
export function RunFailure({ run }: { run: Run }) {
  const svg = useRef<SVGSVGElement>(null);
  const [expanded, setExpanded] = useState(false);
  const pending = useRef<string | null>(null);
  const { id, state, outcome } = run;

  useEffect(() => {
    const wasPending = pending.current === id;
    pending.current = state === "failed" ? null : id;
    const mark = svg.current;
    if (state !== "failed" || !mark) return;

    const dark = () => document.documentElement.dataset.scheme === "dark";
    const options = { width: 4.5, dark: dark() };
    let figure = (wasPending || expanded) && !matchMedia("(prefers-reduced-motion: reduce)").matches
      ? createFigure(mark, { ...options, state: "error" }) : null;
    const paint = () => {
      if (figure) figure.setDark(dark());
      else drawFigurePose(mark, "error", { ...options, dark: dark() });
    };
    paint();
    const timer = figure ? window.setTimeout(() => {
      figure?.destroy();
      figure = null;
      paint();
    }, 1500) : undefined;
    const scheme = new MutationObserver(paint);
    scheme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-scheme"] });
    return () => {
      window.clearTimeout(timer);
      scheme.disconnect();
      figure?.destroy();
    };
  }, [id, state, expanded]);

  if (state !== "failed") return null;
  const title = errorText(outcome?.error) || t("run.failed");
  const detail = outcome?.error === "engine_crashed"
    ? t(outcome.receipts?.length ? "run.crashReceipts" : "run.crashNoRetry") : null;
  return (
    <div className="run-failure">
      <svg ref={svg} className="failure-mark" viewBox="0 0 120 120" aria-hidden="true" />
      {detail ? (
        <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
          <summary>{title}<Icon name="down" /></summary>
          <p>{detail}</p>
        </details>
      ) : <p className="failure-title">{title}</p>}
      {outcome?.error === "engine_unavailable" && (
        <button type="button" className="failure-act" onClick={() => openSettings("models")}>{t("run.connectModel")}</button>
      )}
    </div>
  );
}
