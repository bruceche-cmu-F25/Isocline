import type { StateResponse } from "@isocline/protocol";
import { shared } from "./share.ts";

/** The state just read, made of the last one's objects wherever they say the same (share.ts), and with the module
 * snapshots the home node left out because this device already holds them. When nothing but the place in the event
 * log moved, it is the last state itself, so nothing is drawn again. */
export function mergeState(before: StateResponse | null, next: StateResponse): StateResponse {
  if (!before) return next;
  const modules = { ...next.modules };
  for (const id of Object.keys(next.revisions ?? {})) if (!(id in modules) && id in before.modules) modules[id] = before.modules[id];
  // `cursor` is only where to start following events from, once, when the app opens.
  return shared(before, { ...next, modules, cursor: before.cursor });
}

/** The revisions of the snapshots a state holds, to ask for the next one with. */
export function heldRevisions(state: StateResponse | null): Record<string, string> | undefined {
  if (!state?.revisions) return undefined;
  return Object.fromEntries(Object.entries(state.revisions).filter(([id]) => id in state.modules));
}
