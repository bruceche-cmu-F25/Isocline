import type { StateResponse } from "@isocline/protocol";

/** Development sessions, most recently active first. Apart from the Code page (Dev.tsx), so that what only counts
 * them (the page's badge) does not need the page's code. */
export const sessionsOf = (state: StateResponse, projectId?: string) =>
  state.conversations.filter((conversation) => conversation.projectId && (!projectId || conversation.projectId === projectId));
