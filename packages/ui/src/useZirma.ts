/** One live view of the world: the state snapshot, refreshed whenever the
 * event stream says something changed. What runs are writing right now is kept beside it (live.ts).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CoreEvent, StateResponse } from "@zirma/protocol";
import { api, isUnpaired, subscribe, type Connection } from "./api.ts";
import { liveReplies } from "./live.ts";
import { heldRevisions, mergeState } from "./stateMerge.ts";

/** A run's own progress: recorded for the conversation it is in (which follows the events itself), and changes
 * nothing the state holds. A working run records dozens of them, so the state is not read again for each. */
const NOT_STATE = new Set(["run.step", "run.usage"]);
const RUN_ENDED = new Set(["run.completed", "run.failed", "run.cancelled", "run.interrupted"]);

export interface Zirma {
  state: StateResponse | null;
  connection: Connection;
  error: string | null;
  /** This device came in from another machine and is not paired (or was revoked): show pairing instead. */
  unpaired: boolean;
  /** Subjects (like `todo:abc`) that Zirma changed in the last few seconds. */
  fresh: ReadonlySet<string>;
  /** Listen to every recorded event as it arrives. */
  onEvent(listener: (event: CoreEvent) => void): () => void;
  refresh(): void;
}

export function useZirma(): Zirma {
  const [state, setState] = useState<StateResponse | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [unpaired, setUnpaired] = useState(false);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const listeners = useRef(new Set<(event: CoreEvent) => void>());
  const pending = useRef<number | null>(null);
  /** The state as last read, for asking only for what changed and for keeping what did not. */
  const latest = useRef<StateResponse | null>(null);
  const reading = useRef(false);
  const readAgain = useRef(false);

  const failed = useCallback((reason: Error) => {
    if (isUnpaired(reason)) setUnpaired(true);
    else setError(reason.message);
  }, []);
  const take = useCallback((next: StateResponse) => {
    latest.current = mergeState(latest.current, next);
    setState(latest.current);
    setError(null);
  }, []);
  // One reading at a time: on a slow connection two could come back out of order, the older one last. Something
  // that happened while one was under way is read right after it.
  const refresh = useCallback(() => {
    if (reading.current) { readAgain.current = true; return; }
    reading.current = true;
    api.state(heldRevisions(latest.current)).then(take, failed).finally(() => {
      reading.current = false;
      if (readAgain.current) { readAgain.current = false; refresh(); }
    });
  }, [take, failed]);

  const scheduleRefresh = useCallback(() => {
    if (pending.current !== null) return;
    pending.current = window.setTimeout(() => { pending.current = null; refresh(); }, 120);
  }, [refresh]);

  const onEvent = useCallback((listener: (event: CoreEvent) => void) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);

  const received = useCallback((event: CoreEvent) => {
    if (event.actor === "alfred" && event.subject && !event.kind.startsWith("run.")) {
      const subject = event.subject;
      setFresh((current) => new Set(current).add(subject));
      window.setTimeout(() => setFresh((current) => { const next = new Set(current); next.delete(subject); return next; }), 2400);
    }
    if (event.runId && RUN_ENDED.has(event.kind)) liveReplies.end(event.runId);
    for (const listener of listeners.current) listener(event);
    if (!NOT_STATE.has(event.kind)) scheduleRefresh();
  }, [scheduleRefresh]);

  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    api.state().then((initial) => {
      if (cancelled) return;
      take(initial);
      unsubscribe = subscribe(initial.cursor, {
        event: received,
        live: liveReplies.apply,
        connection: (next) => {
          setConnection(next);
          // After a drop, the stream replays what was missed; the snapshot catches up too.
          // A drop can also mean this device was revoked: the snapshot request says so.
          if (next === "live" || next === "reconnecting") scheduleRefresh();
        },
      });
    }).catch(failed);
    return () => { cancelled = true; unsubscribe(); };
  }, [received, scheduleRefresh, failed, take]);

  return { state, connection, error, unpaired, fresh, onEvent, refresh };
}
