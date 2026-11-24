/** Modules that reach an outside service (the calendar, mail) work in passes, one at a time per module. A pass first
 * sends the accepted changes waiting for the module (its `deliver`, one change at a time; the queue's rules are in
 * module-kit `deliverQueued`), then reads its mirror again (its `sync`), so the read already shows what was just sent.
 *
 * A pass runs shortly after the home node starts, then on the module's own interval; at once when a device asks for a
 * refresh (`sync`), when a change was just accepted (`deliver`), or after an event the module named (`sync.onEvents`).
 * Whatever asks, a module never has two passes at a time: what arrives during one gets one more pass right after it.
 */
import { listOutbound, onEvents, type World } from "@isocline/core";
import { deliverQueued, type IsoclineModule, type ModuleServices } from "@isocline/module-kit";

/** How often changes that had to wait go out again, for a module that has no mirror of its own to refresh. */
const DELIVER_EVERY_MS = 5 * 60_000;
/** How long after the home node starts each module's first pass runs. */
const FIRST_PASS_MS = 2_000;

export interface PassesOptions {
  world: World;
  modules: readonly IsoclineModule[];
  /** The outside services the user has connected (read when each pass runs). */
  services?: () => ModuleServices;
  log?: (message: string) => void;
}

export interface ModulePasses {
  /** Refreshes a module's mirror of an outside service now; resolves when its pass is done. */
  sync(id: string): Promise<void>;
  /** Sends accepted outside changes now, not at the next scheduled pass. */
  deliver(): void;
  /** Stops the schedule and whatever pass is under way. */
  close(): void;
}

export function modulePasses(options: PassesOptions): ModulePasses {
  const { world, modules } = options;
  const stopping = new AbortController();
  const stopped = () => stopping.signal.aborted;
  const passes = new Map<string, Promise<void>>();
  /** Modules with a change accepted while their pass was under way: it came after the pass's sending step. */
  const again = new Set<string>();
  /** Modules one of whose events came while their pass was under way: the pass may have read before it. */
  const stale = new Set<string>();
  const queued = (id: string) => listOutbound(world, { module: id, states: ["queued"] }).length > 0;

  const pass = (module: IsoclineModule): Promise<void> => {
    const running = passes.get(module.id);
    if (running) return running;
    const services = options.services?.() ?? {};
    const work = (async () => {
      await deliverQueued(world, module, services, stopping.signal);
      if (module.sync && !stopped()) await module.sync.run(world, services, stopping.signal);
    })()
      .catch((error) => { if (!stopped()) options.log?.(`module ${module.id}: ${error instanceof Error ? error.message : String(error)}`); })
      .finally(() => {
        passes.delete(module.id);
        // One more pass right after, not at the next scheduled one: for a change still waiting to go out, or to read
        // again after the event.
        const unsent = again.delete(module.id) && !stopped() && queued(module.id);
        const unread = stale.delete(module.id);
        if ((unsent || unread) && !stopped()) void pass(module);
      });
    passes.set(module.id, work);
    return work;
  };

  const timers = modules.filter((module) => module.sync || module.deliver).flatMap((module) => {
    const first = setTimeout(() => void pass(module), FIRST_PASS_MS);
    const every = setInterval(() => void pass(module), module.sync?.everyMs ?? DELIVER_EVERY_MS);
    first.unref();
    every.unref();
    return [first, every];
  });

  // A module may name events after which its pass should run soon (module-kit `sync.onEvents`).
  const eager = modules.filter((module) => module.sync?.onEvents?.length);
  const offEager = eager.length ? onEvents(world, (kinds) => {
    if (stopped()) return;
    for (const module of eager) {
      if (!module.sync!.onEvents!.some((kind) => kinds.has(kind))) continue;
      // One already under way may have started before this event.
      if (passes.has(module.id)) stale.add(module.id);
      else setImmediate(() => { if (!stopped() && world.db.isOpen) void pass(module); });
    }
  }) : () => {};

  return {
    sync(id) {
      const module = modules.find((candidate) => candidate.id === id);
      return module?.sync ? pass(module) : Promise.reject(new Error(`No module ${id} to sync`));
    },
    deliver() {
      const waiting = new Set(listOutbound(world, { states: ["queued"] }).map((outbound) => outbound.module));
      for (const module of modules) {
        if (!module.deliver || !waiting.has(module.id)) continue;
        if (passes.has(module.id)) again.add(module.id);
        else void pass(module);
      }
    },
    close() {
      for (const timer of timers) clearTimeout(timer);
      offEager();
      stopping.abort();
    },
  };
}
