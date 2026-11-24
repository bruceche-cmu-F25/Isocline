/** Which notices are this window's to show (docs/design/attention.md). Who tells the user about a notice is decided
 * on the home node, once, for every window, figure and phone; a window never takes one for itself.
 */
import type { Notice } from "@zirma/protocol";

/** What this window is to do about a notice. `show`: the home node handed it here, so show it and say so. `again`:
 * it was shown here before (the page was reloaded since), so it is put back, here only. Otherwise nothing: it is
 * another outlet's, or nobody's yet. */
export function handed(notice: Pick<Notice, "state" | "claimedBy">, me: string): "show" | "again" | null {
  if (notice.claimedBy !== me) return null;
  return notice.state === "claimed" ? "show" : notice.state === "presented" ? "again" : null;
}
