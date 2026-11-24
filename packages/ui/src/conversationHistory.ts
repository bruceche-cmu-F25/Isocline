import type { ConversationDetail } from "@isocline/protocol";

/** Historical pages may include a pending turn the reader already saw. Keep the refreshed version of that
 * turn and its activity; refreshing live data must likewise leave the reader's oldest cursor in place. */
export function mergeHistory(current: ConversationDetail, page: ConversationDetail, older: boolean): ConversationDetail {
  const [base, preferred] = older ? [page, current] : [current, page];
  const byId = new Map(base.runs.map((run) => [run.id, run]));
  for (const run of preferred.runs) byId.set(run.id, run);
  return {
    conversation: preferred.conversation,
    runs: [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.historyOrder ?? 0) - (b.historyOrder ?? 0)),
    receipts: { ...base.receipts, ...preferred.receipts },
    activity: { ...base.activity, ...preferred.activity },
    files: { ...base.files, ...preferred.files },
    nextCursor: older ? page.nextCursor : current.nextCursor,
  };
}
