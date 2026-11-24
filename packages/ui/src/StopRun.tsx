import { useState } from "react";
import type { Run } from "@isocline/protocol";
import { api } from "./api.ts";
import { t } from "./i18n/index.ts";

/** A conversation has at most one leased run. Before it starts, the oldest queued turn is next. */
export function stoppableRun(runs: readonly Run[]): Run | undefined {
  let queued: Run | undefined;
  for (const run of runs) {
    if (run.state === "running" || run.state === "cancelling" || run.state === "waiting_input" || run.state === "waiting_permission") return run;
    if (run.state === "queued" && (!queued || run.createdAt < queued.createdAt)) queued = run;
  }
  return queued;
}

export function StopRun({ run, onError }: { run: Run; onError(message: string | null): void }) {
  const [requested, setRequested] = useState(false);
  const stopping = requested || run.state === "cancelling";
  const label = t(stopping ? "run.cancelling" : "composer.stop");
  const stop = async () => {
    if (stopping) return;
    setRequested(true);
    onError(null);
    try {
      await api.cancel(run.id);
    } catch (reason) {
      setRequested(false);
      onError((reason as Error).message);
    }
  };
  return (
    <button type="button" className="send composer-stop" data-stopping={stopping || undefined}
      disabled={stopping} aria-label={label} title={label} onClick={stop}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor" stroke="none" /></svg>
    </button>
  );
}
