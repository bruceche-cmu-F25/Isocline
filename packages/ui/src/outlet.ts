/** This window, as a place where Zirma can tell the user something (docs/design/attention.md): it says whether it
 * is being looked at and when the user last did something in it. From that, and from what the other outlets say, the
 * home node decides which window, figure or phone gets a notice (handed.ts is this window's half of that).
 */
import { useCallback, useEffect, useRef } from "react";
import { api } from "./api.ts";

/** While someone is looking, said again this often; an outlet that goes quiet is forgotten after three of these. */
const REPORT_MS = 30_000;
/** Left alone for this long at the last report, and touched now: the user came back to it, which is said at once.
 * How long left alone still counts as using it is the home node's to say, not this file's. Not a multiple of
 * REPORT_MS: a window touched last when it reported says a hair under 30 s the next time. */
const BACK_AFTER_MS = 45_000;
const INPUT = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

export function useOutlet(attending: boolean): void {
  const lastInput = useRef(Date.now());
  const looking = useRef(attending);
  /** What this window last said. */
  const said = useRef({ attending: false, idleMs: 0 });

  const report = useCallback(() => {
    const idleMs = Date.now() - lastInput.current;
    said.current = { attending: looking.current, idleMs };
    api.outlet(looking.current, idleMs).catch(() => { /* the node is away; the next one catches up */ });
  }, []);

  useEffect(() => {
    const mark = () => {
      lastInput.current = Date.now();
      if (said.current.attending && said.current.idleMs >= BACK_AFTER_MS) report();
    };
    for (const type of INPUT) window.addEventListener(type, mark, { passive: true, capture: true });
    return () => { for (const type of INPUT) window.removeEventListener(type, mark, { capture: true }); };
  }, [report]);

  useEffect(() => {
    looking.current = attending;
    // Turning to this window is using it: the focus comes before the click that brought it.
    if (attending) lastInput.current = Date.now();
    // A window that has not said it was looked at has nothing to take back. Tabs of one browser go by one name, so
    // one opened in the background must not speak over the one in front.
    if (!attending && !said.current.attending) return;
    report();
    // Not looked at: said once, then nothing until it is looked at again.
    if (!attending) return;
    const timer = window.setInterval(report, REPORT_MS);
    return () => window.clearInterval(timer);
  }, [attending, report]);
}
