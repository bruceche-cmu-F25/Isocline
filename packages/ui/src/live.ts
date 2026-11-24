/** Replies being written, by run: what the event stream says of them, kept outside React's state.
 *
 * A reply is written a few words at a time, a dozen times a second. Held in the app's state, each of those turned
 * the whole window over again (the sidebar, the page, the bar). Here only what shows the reply follows it
 * (`useLiveText`), and the rest of the app hears just that a run began or stopped writing (`useWriting`).
 */
import { useCallback, useSyncExternalStore } from "react";
import type { LiveUpdate } from "@isocline/protocol";

/** How long a finished reply's last words are kept, for whoever is still showing them. */
const KEEP_MS = 60_000;

export interface LiveReplies {
  /** Takes one update from the stream: the reply so far, or what was written since the last one. */
  apply(update: LiveUpdate): void;
  /** The run's record has arrived: it is no longer being written. Its last words stay for a while (`busy`, below). */
  end(runId: string): void;
  /** The reply as it stands. `busy`: whoever asks still shows the run as working, so the last words of one that
   * has just ended are given too (the stream ends a moment before the finished reply loads). */
  text(runId: string, busy?: boolean): string | undefined;
  /** The runs being written right now. The same set until one begins or ends. */
  writing(): ReadonlySet<string>;
  onText(runId: string, listener: () => void): () => void;
  onWriting(listener: () => void): () => void;
}

export function createLiveReplies(keepMs: number = KEEP_MS): LiveReplies {
  const texts = new Map<string, string>();
  const last = new Map<string, string>();
  const byRun = new Map<string, Set<() => void>>();
  const any = new Set<() => void>();
  let writing: ReadonlySet<string> = new Set();
  const told = (runId: string) => { for (const listener of byRun.get(runId) ?? []) listener(); };
  const count = () => { writing = new Set(texts.keys()); for (const listener of any) listener(); };

  return {
    apply(update) {
      const had = texts.get(update.runId);
      let next: string;
      if (typeof update.text === "string") next = update.text;
      // What was written since: it goes on from what is here, or it is not for this text (an update from before a
      // reconnection); the stream then says the whole reply again.
      else if (typeof update.add === "string" && had !== undefined && update.at === had.length) next = had + update.add;
      else return;
      if (next === had) return;
      texts.set(update.runId, next);
      last.set(update.runId, next);
      if (had === undefined) count();
      told(update.runId);
    },
    end(runId) {
      if (!texts.delete(runId)) return;
      setTimeout(() => { if (!texts.has(runId)) last.delete(runId); }, keepMs);
      count();
      told(runId);
    },
    text: (runId, busy) => texts.get(runId) ?? (busy ? last.get(runId) : undefined),
    writing: () => writing,
    onText(runId, listener) {
      let listeners = byRun.get(runId);
      if (!listeners) byRun.set(runId, listeners = new Set());
      listeners.add(listener);
      return () => { listeners.delete(listener); if (!listeners.size) byRun.delete(runId); };
    },
    onWriting(listener) { any.add(listener); return () => { any.delete(listener); }; },
  };
}

/** The app's own: one event stream, one set of replies. */
export const liveReplies = createLiveReplies();

const nothing = () => () => {};

/** A run's reply as it is written; undefined when it is not being written. `busy` as in `LiveReplies.text`. */
export function useLiveText(runId: string | undefined, busy = false): string | undefined {
  const subscribe = useCallback((listener: () => void) => (runId ? liveReplies.onText(runId, listener) : nothing()), [runId]);
  return useSyncExternalStore(subscribe, () => (runId ? liveReplies.text(runId, busy) : undefined));
}

/** The runs whose reply is being written right now. */
export function useWriting(): ReadonlySet<string> {
  return useSyncExternalStore(liveReplies.onWriting, liveReplies.writing);
}
