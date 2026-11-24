import { useEffect, useState } from "react";
import type { Run, RunState } from "@zirma/protocol";
import { api } from "./api.ts";
import { SectionsResult } from "./Sections.tsx";
import { Markdown } from "./Markdown.tsx";
import { t, type Key } from "./i18n/index.ts";
import { RunFailure } from "./RunFailure.tsx";

const stateLabel: Record<RunState, Key> = {
  queued: "run.queued", running: "run.running", cancelling: "run.cancelling",
  waiting_permission: "auto.waiting", waiting_input: "auto.waiting", completed: "auto.completed",
  failed: "auto.failed", cancelled: "auto.cancelled", interrupted: "auto.interrupted",
};
export const resultStatus = (state: RunState) => t(stateLabel[state]);

/** The full persisted reply, also for a notice older than the recent runs in /state. */
/** `sections`: drawn in sections (an automation with `layout: sections`). */
export function RunResult({ runId, run, preview, reading = false, sections = false }: { runId: string; run?: Run; preview?: string; reading?: boolean; sections?: boolean }) {
  const [fetched, setFetched] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const supplied = run?.outcome?.replyTruncated ? undefined : run;
  useEffect(() => {
    if (supplied) return;
    let current = true;
    setError(null);
    api.run(runId).then(({ run }) => { if (current) setFetched(run); })
      .catch((reason: Error) => { if (current) setError(reason.message); });
    return () => { current = false; };
  }, [runId, supplied, attempt]);
  const className = reading ? "run-reading inbox-result-reading" : "run-reading";
  const result = supplied ?? (fetched?.id === runId ? fetched : null);
  if (!result) return <div className={className}>
    {preview && <p>{preview}</p>}
    {error ? <p className="problem small" role="alert">{error} <button className="link" type="button" onClick={() => setAttempt(attempt + 1)}>{t("archive.retry")}</button></p>
      : <p className="quiet small" role="status">{t("auto.loading")}</p>}
  </div>;
  const reply = result.outcome?.reply;
  if (sections && result.state === "completed") return <SectionsResult key={result.id} run={result} />;
  return <div className={className}>
    {reply && <Markdown text={reply} reading={reading} />}
    <RunFailure key={result.id} run={result} />
    {result.state !== "completed" && result.state !== "failed" && <p className={result.state === "interrupted" ? "problem" : "quiet"} role="status">
      {result.state === "interrupted" ? t("run.interrupted") : resultStatus(result.state)}
    </p>}
    {result.state === "completed" && !reply && <p className="quiet">{t("auto.emptyResult")}</p>}
  </div>;
}
