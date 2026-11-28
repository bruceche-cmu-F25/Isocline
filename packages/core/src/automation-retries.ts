/** Trying an automation's firing again when it did not go through (docs/design/automations.md §3).
 *
 * Only a firing that left nothing behind is tried again: no change, no proposal, no call outside. One that did
 * something is never re-run, because that could do the same thing twice. Each try is a run of its own; while another
 * try is coming, the failure is not told (runs.ts asks `heldForRetry` before it makes a notice).
 *
 * Apart from automations.ts and runs.ts, which both need it (and automations.ts imports runs.ts). Reads the database only.
 */
import type { DatabaseSync } from "node:sqlite";

/** How long after a try ends the next one starts; as many tries again as there are waits. */
export const RETRY_AFTER_MS: readonly number[] = [2 * 60_000, 10 * 60_000, 30 * 60_000];
/** This many firings in a row that did not go through are told once, as one notice; later ones are not told. */
export const FAILED_STREAK = 3;
/** Errors another try cannot fix: there is no model to run with, so the user has to connect one. */
const NOT_WORTH_RETRYING = new Set(["engine_unavailable", "unknown_profile"]);

/** The request id of a scheduled firing: the automation and its slot, and for a try again, which one. */
export function slotRequestId(automationId: string, slot: number, attempt = 0): string {
  return `auto:${automationId}:${slot}${attempt ? `:r${attempt}` : ""}`;
}

/** The slot a run was fired for and which try it is (0 the first); null for a run that was not a scheduled firing
 * (the user's own, or "run now"). */
export function scheduledAttempt(requestId: string): { slot: number; attempt: number } | null {
  const match = /^auto:.+:(\d{10,})(?::r(\d+))?$/.exec(requestId);
  return match ? { slot: Number(match[1]), attempt: Number(match[2] ?? 0) } : null;
}

/** Whether a run did anything: an event under it that is not about the run itself. */
export function leftSomething(db: DatabaseSync, runId: string): boolean {
  return !!db.prepare("SELECT 1 FROM core_events WHERE run_id = ? AND kind NOT LIKE 'run.%' LIMIT 1").get(runId);
}

/** Whether a scheduled firing that ended failed or interrupted is to be tried again: it left nothing, it has tries
 * left, the error is one another try can fix, and its automation is still there and on. */
export function heldForRetry(
  db: DatabaseSync, run: { id: string; requestId: string; automationId: string | null }, error?: string | null,
  /** `whenOff`: for the clock, which lets go of a held firing itself once its automation is switched off. */
  options: { whenOff?: boolean } = {},
): boolean {
  if (!run.automationId || (error && NOT_WORTH_RETRYING.has(error))) return false;
  const tried = scheduledAttempt(run.requestId);
  if (!tried || tried.attempt >= RETRY_AFTER_MS.length) return false;
  if (!db.prepare(`SELECT 1 FROM core_automations WHERE id = ?${options.whenOff ? "" : " AND enabled = 1"}`).get(run.automationId)) return false;
  return !leftSomething(db, run.id);
}

/** How many scheduled firings in a row, up to the newest, did not go through: slots, not tries. A run that completed
 * (the user's "run now" too) ends the count; a cancelled or unfinished one is passed over. */
export function failedStreak(db: DatabaseSync, automationId: string): number {
  const rows = db.prepare("SELECT request_id, state FROM core_runs WHERE automation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100").all(automationId);
  const slots = new Set<number>();
  for (const row of rows) {
    if (row.state === "completed") break;
    if (row.state !== "failed" && row.state !== "interrupted") continue;
    const tried = scheduledAttempt(row.request_id as string);
    if (tried) slots.add(tried.slot);
  }
  return slots.size;
}
