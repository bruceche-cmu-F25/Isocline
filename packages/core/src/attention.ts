/** Attention: by whom, where and when the user is told about a notice (docs/design/attention.md).
 *
 * It is one decision, and this file is where it is made: what kind of thing a notice is to the user, the table that
 * says which outlet it goes to, and the waiting times in between. `decide` is pure, so the whole table can be read
 * and tested here.
 *
 * Every outlet follows it: the app's windows and the Mac's figure say what they see, the home node (server
 * attention.ts) puts each notice to this table and hands it to the outlet the table names, and an outlet shows only
 * what it was handed. The welcome is the one exception: it goes to the device that saw the user come back.
 */

/** What a notice is to the user. */
export const NOTICE_CLASSES = ["needs_you", "tells_you", "greeting"] as const;
/** `needs_you`: it waits on the user (a question, a proposal, an interrupted run, a change outside that failed or
 * may not have happened). `tells_you`: something they will want to know, and nothing to do. `greeting`: the welcome
 * when they come back. */
export type NoticeClass = (typeof NOTICE_CLASSES)[number];

/** The class of a notice, from its kind and what it carries. This is the one list of which notices matter how: a
 * notice kind added later gets its place here. Until it has one it tells, and is not pushed. */
export function noticeClass(kind: string, payload: Record<string, unknown>): NoticeClass {
  if (kind === "welcome") return "greeting";
  if (kind === "run_request" || kind === "proposal" || kind === "run_interrupted") return "needs_you";
  // A change outside Zirma that went through is news; one that was refused or may not have happened needs a look.
  if (kind === "outbound") return payload.state === "done" ? "tells_you" : "needs_you";
  return "tells_you";
}

/** A place on a device that can tell the user something, as it last described itself. */
export interface Outlet {
  /** Unique among outlets: the device it is on and what it is. */
  id: string;
  /** A window of the app; the Mac's always-there figure; or a phone's push notifications. */
  kind: "window" | "figure" | "push";
  /** A window: on screen and focused. A figure: its machine is awake and unlocked. Push: never, it reaches a pocket. */
  attending: boolean;
  /** When the user last did something there: in that window, or for a figure anywhere on its machine. A window or a
   * figure counts only while this is recent (`atWindowWithinMs`, `atMachineWithinMs`); among several windows in use
   * the latest gets the notice. One that does not say is taken at its word. */
  activeAt?: number;
}

/** What to do about a notice now. */
export type Decision =
  /** Hand it to this outlet. */
  | { do: "tell"; outlet: string }
  /** Nobody to tell yet: decide again at this time, or when the user comes back. */
  | { do: "wait"; until: number | "return" }
  /** Not this decision's: a greeting is handed, when it is made, to the device that saw the user come back. */
  | { do: "nothing" };

export interface AttentionPolicy {
  /** A window in front is in use while the user did something in it within this long. Left alone longer, it may be
   * in front of an empty chair: what it showed would count as told, and the phone would stay quiet. */
  atWindowWithinMs: number;
  /** The figure speaks only once a notice is this old: a window in use shows it first, in place. */
  figureAfterMs: number;
  /** The user is at a figure's machine while they did something on it within this long. */
  atMachineWithinMs: number;
  /** A window or a figure that was handed a notice has this long to show it; then the next row is tried. */
  presentWithinMs: number;
  /** A notice nobody took goes to the phone once it is this old. */
  pushAfterMs: number;
  /** A notice older than this is not pushed any more (the home node was off, or it was found late): it is no
   * longer news worth a buzz, and waits for the user's return. */
  pushWhileFreshMs: number;
  /** Whether a notice of this kind and class goes to the phone at all when the user is at no device. */
  pushes(notice: { kind: string; class: NoticeClass }): boolean;
}

export const ATTENTION: AttentionPolicy = {
  atWindowWithinMs: 5 * 60_000,
  figureAfterMs: 1500,
  atMachineWithinMs: 120_000,
  presentWithinMs: 8_000,
  pushAfterMs: 20_000,
  pushWhileFreshMs: 10 * 60_000,
  // What needs the user reaches them wherever they are. Of the news, a run's result does (they asked, and left), and
  // so does a reminder (an event about to start is no use told later); "it went through" for a change they have
  // just said yes to does not.
  pushes: (notice) => notice.class === "needs_you" || notice.kind === "run_result" || notice.kind === "reminder",
};

/** Whether the user can be told at this outlet right now: a window they are using, or the figure of a machine they
 * are at. Never push: nobody is looking at a pocket. */
export function attends(outlet: Outlet, now: number, policy: AttentionPolicy = ATTENTION): boolean {
  if (!outlet.attending || outlet.kind === "push") return false;
  if (outlet.activeAt === undefined) return true;
  return now - outlet.activeAt < (outlet.kind === "figure" ? policy.atMachineWithinMs : policy.atWindowWithinMs);
}

/**
 * The table, top row first:
 *
 *   a window in use            → that window, at once (the one used last). In use: in front, and touched within
 *                                `atWindowWithinMs`
 *   at the Mac, not looking    → the Mac's figure, once the notice is `figureAfterMs` old
 *   at no device               → the phone, once it is `pushAfterMs` old, if this kind is pushed and still fresh
 *   otherwise                  → wait for the user's return
 *
 * `tried`: outlets that were handed this notice and did not show it in time; they are passed over.
 */
export function decide(
  notice: { kind: string; class: NoticeClass; createdAt: string },
  outlets: readonly Outlet[],
  now: number,
  options: { tried?: ReadonlySet<string>; policy?: AttentionPolicy } = {},
): Decision {
  const policy = options.policy ?? ATTENTION;
  if (notice.class === "greeting") return { do: "nothing" };
  const open = outlets.filter((outlet) => !options.tried?.has(outlet.id));
  const age = now - Date.parse(notice.createdAt);

  const windows = open.filter((outlet) => outlet.kind === "window" && attends(outlet, now, policy)).sort((a, b) => (b.activeAt ?? 0) - (a.activeAt ?? 0));
  if (windows.length) return { do: "tell", outlet: windows[0].id };

  const figure = open.find((outlet) => outlet.kind === "figure" && attends(outlet, now, policy));
  if (figure) return age >= policy.figureAfterMs ? { do: "tell", outlet: figure.id } : { do: "wait", until: now + policy.figureAfterMs - age };

  const push = open.find((outlet) => outlet.kind === "push");
  if (push && policy.pushes(notice) && age <= policy.pushWhileFreshMs) {
    return age >= policy.pushAfterMs ? { do: "tell", outlet: push.id } : { do: "wait", until: now + policy.pushAfterMs - age };
  }
  return { do: "wait", until: "return" };
}
