/** Asking from the bar under the page (shell/AskBar.tsx): which conversation the words go to, and which run the
 * bar's card is about. */
import type { Conversation, Run } from "@zirma/protocol";

/** How long after a conversation last moved the bar still adds to it. After that a question starts a new one: what
 * was said this morning is not what this afternoon's question is about. */
export const CONTINUE_MS = 30 * 60_000;

/** The conversation a question from the bar continues: the open one, while something in it still runs or waits for
 * the user, or it moved a short while ago. Otherwise none, and the question starts a new conversation. */
export function continues(conversation: Pick<Conversation, "id" | "updatedAt" | "busy" | "attention"> | undefined, now: number): string | null {
  if (!conversation) return null;
  if (conversation.busy > 0 || conversation.attention > 0) return conversation.id;
  return now - Date.parse(conversation.updatedAt) < CONTINUE_MS ? conversation.id : null;
}

/** The newest run of a conversation. `runs` is newest first, as the home node lists them. */
export function newestRun(runs: readonly Run[], conversationId: string | null): Run | undefined {
  return conversationId ? runs.find((run) => run.conversationId === conversationId) : undefined;
}

/** Where a run stands, as the card cares: still going, waiting for the user, or over. */
export function standing(run: Pick<Run, "state" | "request">): "busy" | "waiting" | "over" {
  if (run.request || run.state === "waiting_permission" || run.state === "waiting_input") return "waiting";
  return run.state === "queued" || run.state === "running" || run.state === "cancelling" ? "busy" : "over";
}
