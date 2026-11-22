import { useEffect, useState } from "react";
import type { Automation, Run } from "@alfred/protocol";
import { api } from "./api.ts";
import { automationTitle, editionDate, editionTitle, hhmm } from "./automationText.ts";
import { t } from "./i18n/index.ts";
import { resultStatus, RunResult } from "./RunResult.tsx";

/** History is paged by the automation's runs, independently of the shared conversation's manual turns. */
export function AutomationHistory({ automation, recent, onOpenConversation }: {
  automation: Automation; recent: Run[]; onOpenConversation(conversationId: string, runId?: string): void;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [page, setPage] = useState<{ before?: string }>({});
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setBusy(true);
    setError(null);
    api.automationRuns(automation.id, page.before).then((result) => {
      if (!current) return;
      setRuns((past) => page.before ? [...past, ...result.runs] : result.runs);
      setNext(result.nextCursor);
    }).catch((reason: Error) => { if (current) setError(reason.message); })
      .finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [automation.id, page]);

  // The live snapshot supplies runs that have started or finished since this page loaded.
  const byId = new Map(runs.map((run) => [run.id, run]));
  for (const run of recent) {
    if (run.automationId !== automation.id) continue;
    if (byId.has(run.id) || run.id === automation.lastRunId || (runs[0] && run.createdAt > runs[0].createdAt)) byId.set(run.id, run);
  }
  const ordered = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const current = (selected && byId.get(selected)) || ordered[0];
  const name = automationTitle(automation);
  return <section className="automation-history" aria-label={t("auto.history")}>
    <div className="history-editions">
      <h3>{t("auto.history")}</h3>
      <ul>{ordered.map((run) => <li key={run.id}>
        <button type="button" aria-current={current?.id === run.id ? "true" : undefined} onClick={() => setSelected(run.id)}>
          <time dateTime={run.createdAt}>{editionDate(run.createdAt)} · {hhmm(new Date(run.createdAt))}</time>
          {run.state !== "completed" && <span>{resultStatus(run.state)}</span>}
        </button>
      </li>)}</ul>
      {busy ? <p className="quiet small" role="status">{t("auto.loading")}</p>
        : error ? <p className="problem small" role="alert">{error} <button type="button" className="link" onClick={() => setPage({ ...page })}>{t("archive.retry")}</button></p>
        : next ? <button type="button" className="link" onClick={() => setPage({ before: next })}>{t("auto.older")}</button>
        : !current && <p className="quiet small">{t("auto.never")}</p>}
    </div>
    {current && <article className="history-result">
      <h3>{editionTitle(name, current.createdAt)}</h3>
      <RunResult runId={current.id} run={current} morningBrief={automation.template === "brief"} />
      <button type="button" className="link" onClick={() => onOpenConversation(current.conversationId, current.id)}>{t("inbox.openConversation")}</button>
    </article>}
  </section>;
}
