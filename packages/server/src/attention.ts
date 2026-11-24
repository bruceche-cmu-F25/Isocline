/** The home node's side of attention (docs/design/attention.md): it puts every notice nobody holds to the table
 * (core attention.ts), and hands each to the outlet the table names, when the table says.
 *
 * There are two ways to hand one over. A window or the Mac's figure is named as the notice's holder: the device
 * sees that, shows the notice and says so; if it does not within the table's time, the next row is tried. Push the
 * home node sends by itself (push.ts); once it went out the phone has told the user, and nothing shows it again.
 *
 * An outlet in use is also how the home node knows the user is here, on whichever device (core presence.ts). When
 * that is a return after a while, the welcome is made there and then, and tells what waited: so on a return
 * nothing is handed out one by one.
 *
 * A device no longer takes notices for itself. One from before this still can (`POST /api/notices/:id/claim`):
 * what it takes is held, so it does not come up here until that hold runs out.
 */
import {
  ATTENTION, attends, claimNotice, decide, isOpen, presentNotice, releaseNotice, reportPresence, undeliveredNotices,
  type AttentionPolicy, type Notice, type Outlet, type PresenceOptions, type World,
} from "@zirma/core";

/** An outlet as it last described itself, and the device it spoke from. */
export interface SeenOutlet extends Outlet {
  /** The paired device's id; `home` for the home node's own machine. */
  device: string;
  /** When the user last did something there, if the outlet could tell. */
  activeAt?: number;
  reportedAt: number;
}

/** An outlet that has not reported for this long is forgotten: its window was closed, or its device went away. */
export const OUTLET_STALE_MS = 90_000;

/** The outlets that have reported lately: where the user could be told something, and whether they are looking
 * there. Memory only, on purpose: it is what devices see right now, not something that happened, so none of it is
 * an event and none of it survives a restart (devices report again within half a minute). */
export class Outlets {
  readonly #seen = new Map<string, SeenOutlet>();
  readonly #listeners = new Set<(outlet: SeenOutlet, was: SeenOutlet | undefined) => void>();

  report(device: string, report: { client: string; kind: "window" | "figure"; attending: boolean; idleMs?: number }, now: number = Date.now()): void {
    const was = this.#seen.get(report.client);
    const outlet: SeenOutlet = {
      id: report.client, kind: report.kind, attending: report.attending, device, reportedAt: now,
      ...(report.idleMs === undefined ? {} : { activeAt: now - report.idleMs }),
    };
    this.#seen.set(report.client, outlet);
    for (const listener of this.#listeners) listener(outlet, was);
  }

  /** Called with every report, and what that outlet said before. */
  onReport(listener: (outlet: SeenOutlet, was: SeenOutlet | undefined) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** A device was unpaired: what it said about itself no longer counts. */
  forget(device: string): void {
    for (const [id, outlet] of this.#seen) if (outlet.device === device) this.#seen.delete(id);
  }

  /** Those still reporting, the one used last first. */
  list(now: number = Date.now()): SeenOutlet[] {
    for (const [id, outlet] of this.#seen) if (now - outlet.reportedAt > OUTLET_STALE_MS) this.#seen.delete(id);
    return [...this.#seen.values()].sort((a, b) => (b.activeAt ?? 0) - (a.activeAt ?? 0));
  }
}

/** An outlet the home node can tell the user through by itself. */
export interface Reach {
  outlet: Outlet;
  /** Tells the user there. True when it went out: that counts as told, though it is no proof they saw it. What
   * still needs them stays in the list, and the welcome says how many things wait. */
  send(notice: Notice): Promise<boolean>;
}

export interface AttentionOptions {
  world: World;
  /** The windows and figures that say what they see. Handing one a notice is naming it as the holder. */
  outlets?: Outlets;
  /** The outlets the home node tells through by itself, right now. */
  reaches(): Reach[];
  policy?: AttentionPolicy;
  /** When being seen again counts as a return (core presence.ts). */
  presence?: PresenceOptions;
  log?: (message: string) => void;
}

/** Follows the world and the outlets: every notice nobody holds is put to the table when something happens, when an
 * outlet says something new, and when the table said to look again. */
export function watchAttention(options: AttentionOptions): { look(): void; close(): void } {
  const { world } = options;
  const policy = options.policy ?? ATTENTION;
  /** Notices on their way out through a reach. */
  const sending = new Set<string>();
  /** Per notice, the outlets it was handed to that did not show it. */
  const tried = new Map<string, Set<string>>();
  let closed = false;
  let wake: NodeJS.Timeout | null = null;
  let wakeAt = Infinity;

  const again = (at: number) => {
    if (at === Infinity || (wake && wakeAt <= at)) return;
    if (wake) clearTimeout(wake);
    wakeAt = at;
    wake = setTimeout(() => { wake = null; wakeAt = Infinity; look(); }, Math.max(0, at - Date.now()));
    wake.unref();
  };

  const passOver = (noticeId: string, outlet: string) => {
    const set = tried.get(noticeId) ?? new Set<string>();
    tried.set(noticeId, set.add(outlet));
  };

  const send = async (notice: Notice, reach: Reach) => {
    let out = false;
    try {
      out = await reach.send(notice);
    } catch (error) {
      options.log?.(`telling ${reach.outlet.id} about notice ${notice.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    sending.delete(notice.id);
    if (closed) return;
    if (out) {
      // It was told there, and that is recorded like any other showing. A device may have taken it meanwhile.
      try {
        claimNotice(world, notice.id, reach.outlet.id, { ttlMs: policy.presentWithinMs });
        presentNotice(world, notice.id, reach.outlet.id);
      } catch { /* taken */ }
      return;
    }
    // It did not go out there: that outlet is passed over, and the table is asked once more.
    passOver(notice.id, reach.outlet.id);
    look();
  };

  function look(): void {
    if (closed) return;
    const now = Date.now();
    const reaches = options.reaches();
    const outlets: Outlet[] = [...(options.outlets?.list(now) ?? []), ...reaches.map((reach) => reach.outlet)];
    if (!outlets.length) return;
    const waiting = undeliveredNotices(world, now);
    const ids = new Set(waiting.map((notice) => notice.id));
    for (const id of tried.keys()) if (!ids.has(id)) tried.delete(id);
    let next = Infinity;
    for (const notice of waiting) {
      // The welcome is not the table's: it stays with the device that saw the user come back.
      if (sending.has(notice.id) || notice.class === "greeting") continue;
      if (notice.state === "claimed") {
        // Somebody has it: look again when their time to show it runs out.
        if (!isOpen(notice, now)) { next = Math.min(next, Date.parse(notice.claimUntil!)); continue; }
        // They did not show it in time: it is taken back, and they are passed over.
        const from = releaseNotice(world, notice.id, { now });
        if (from === null) continue;
        passOver(notice.id, from);
      }
      const decision = decide(notice, outlets, now, { tried: tried.get(notice.id), policy });
      if (decision.do === "nothing") continue;
      if (decision.do === "wait") {
        if (decision.until !== "return") next = Math.min(next, decision.until);
        continue;
      }
      const reach = reaches.find((candidate) => candidate.outlet.id === decision.outlet);
      if (reach) {
        sending.add(notice.id);
        void send(notice, reach);
        continue;
      }
      // A window or a figure: it is named as the holder, and has the table's time to show the notice.
      try {
        claimNotice(world, notice.id, decision.outlet, { ttlMs: policy.presentWithinMs, now });
        next = Math.min(next, now + policy.presentWithinMs);
      } catch { /* a device took it meanwhile */ }
    }
    again(next);
  }

  const unsubscribe = world.onCommit(() => setImmediate(look));
  const unfollow = options.outlets?.onReport((outlet, was) => {
    const now = Date.now();
    if (attends(outlet, now, policy)) {
      // Where the user can be told is where the user is: a phone in the hand counts like the Mac. Said before
      // anything is handed out below: if this is a return, the welcome is made here and tells what waited.
      try {
        reportPresence(world, { clientId: outlet.id, kind: "active", now, ...options.presence });
      } catch (error) {
        options.log?.(`noting the user at ${outlet.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      // The user turned back to it: it gets another chance at what it did not show before.
      if (!(was && attends(was, now, policy))) for (const set of tried.values()) set.delete(outlet.id);
    }
    look();
  });
  look();
  return {
    look,
    close() {
      closed = true;
      unsubscribe();
      unfollow?.();
      if (wake) clearTimeout(wake);
    },
  };
}
