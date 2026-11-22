/** The home node: the one process that holds the world and executes runs.
 * A lock file keeps it single, which is what lets a fresh start treat every
 * run still marked running as orphaned.
 */
import { EventEmitter } from "node:events";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  CORE_MIGRATIONS, createRunDrain, expireProposals, interruptOutbound, ensureTemplates, fireDueAutomations, interruptOrphanedRuns, openWorld, tidyWorld,
  type AttentionPolicy, type EngineModel, type EnginePort, type LiveUpdate, type PresenceOptions, type Run, type World,
} from "@alfred/core";
import { moduleMigrations, type AlfredModule, type ModuleServices } from "@alfred/module-kit";
import { setMailFavorite } from "@alfred/module-mail";
import { Outlets, watchAttention, type Reach } from "./attention.ts";
import { FileStore, type FileStoreOptions } from "./files.ts";
import { Terminals } from "./terminals.ts";
import { SessionArchives } from "./archives.ts";
import { Processes } from "./processes.ts";
import { Desk } from "./desk.ts";
import { modulePasses } from "./passes.ts";
import { AUTOMATION_PROFILE, profiles } from "./profiles.ts";

/** How often the home node's clock looks for automations that are due and proposals past their time. */
const CLOCK_MS = 30_000;
const TIDY_AFTER_MS = 60_000;
const TIDY_EVERY_MS = 24 * 3600_000;

export interface HomeOptions {
  dataDir: string;
  engine: EnginePort;
  modules: readonly AlfredModule[];
  /** How long away counts as away (a user preference). */
  presence?: PresenceOptions;
  /** The attention table's waits, when not the usual ones (tests). */
  attention?: AttentionPolicy;
  /** For the operator's log. */
  log?: (message: string) => void;
  /** The outside services the user has connected, for modules that mirror one (read when each sync runs). */
  services?: () => ModuleServices;
  /** How a PDF's text is read out (tests); `pdftotext` otherwise. */
  readPdf?: FileStoreOptions["readPdf"];
  /** The user's terminals in development sessions; made here unless a test brings its own. */
  terminals?: Terminals;
}

export interface Home {
  world: World;
  modules: readonly AlfredModule[];
  presence: PresenceOptions;
  owner: string;
  /** What runs are writing right now (not recorded). Emits `update` with a LiveUpdate. */
  live: EventEmitter<{ update: [LiveUpdate] }>;
  /** The windows and figures that have reported lately, and whether the user is looking there (not recorded).
   * The home node hands each notice to one of them, or to a reach, as the attention table says (attention.ts). */
  outlets: Outlets;
  /** Adds outlets the home node tells the user through by itself (the phones' push notifications). */
  reach(list: () => Reach[]): void;
  /** The files the user sends with their messages: their bytes, on this machine's disk. */
  files: FileStore;
  /** The user's own terminals, one per development session (this machine only). */
  terminals: Terminals;
  /** Background processes in development sessions (dev servers), started by Alfred or the user. */
  processes: Processes;
  archives: SessionArchives;
  /** Where a development session's worktree is made: one folder per session, under the data directory. */
  worktreeDir(projectId: string, conversationKey: string): string;
  /** Requests to the Mac app (what is in its browser pane); the app comes and takes them. */
  desk: Desk;
  /** Starts executing queued runs if it is not already. */
  kick(): void;
  /** Delivers the user's words into a running run; false if it is not running or cannot take them. */
  steer(runId: string, text: string): Promise<boolean>;
  /** The models the engine can run, for choosing one per conversation. */
  models(): Promise<EngineModel[]>;
  /** Refreshes a module's mirror of an outside service now (a device asked); resolves when done. */
  syncModule(id: string): Promise<void>;
  setMailFavorite(account: string, id: string, starred: boolean): ReturnType<typeof setMailFavorite>;
  /** Delivers accepted outside changes now (after a proposal is accepted, an op clicked), not at the next sync. */
  deliver(): void;
  /** Starts the runs of automations that are due now (the clock calls it; tests call it with a time). */
  tickAutomations(now?: number): Run[];
  /** Waits for the current drain (tests). */
  idle(): Promise<void>;
  close(): void;
}

class AlreadyRunningError extends Error {
  override name = "AlreadyRunningError";
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Lock files this process holds, so a second home in the same process is refused too. */
const held = new Set<string>();

function lock(path: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      held.add(path);
      return () => {
        held.delete(path);
        try { if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path); } catch { /* already gone */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(readFileSync(path, "utf8"));
      const ours = pid === process.pid && held.has(path);
      if (ours || (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid))) {
        throw new AlreadyRunningError(`Another Alfred home node is running (pid ${pid}) on this data directory`);
      }
      unlinkSync(path); // stale: its process is gone
    }
  }
  throw new AlreadyRunningError("Could not take the home node lock");
}

export function openHome(options: HomeOptions): Home {
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const unlock = lock(join(options.dataDir, "home-node.lock"));
  let world: World;
  try {
    world = openWorld(join(options.dataDir, "world.sqlite"), [...CORE_MIGRATIONS, ...moduleMigrations(options.modules)]);
  } catch (error) {
    unlock();
    throw error;
  }
  const owner = `home-${process.pid}-${Date.now().toString(36)}`;
  const orphaned = interruptOrphanedRuns(world, owner);
  // Changes outside (an event, an email) the last node was in the middle of delivering: retried if that is safe.
  const cutOff = interruptOutbound(world);
  if (cutOff) options.log?.(`${cutOff} outbound change(s) were being delivered when the last home node stopped`);
  if (orphaned) options.log?.(`${orphaned} run(s) were still running when the last home node stopped; marked interrupted, not re-run`);
  const live = new EventEmitter<{ update: [LiveUpdate] }>();
  live.setMaxListeners(0);
  const files = new FileStore({ dataDir: options.dataDir, world, log: options.log, ...(options.readPdf ? { readPdf: options.readPdf } : {}) });
  const terminals = options.terminals ?? new Terminals({ log: options.log });
  const desk = new Desk();
  const processes = new Processes();
  const archives = new SessionArchives(world, processes, terminals, options.log);
  const drain = createRunDrain(world, options.engine, {
    owner,
    profiles: profiles(world, options.modules, { terminals, desk, processes }),
    attach: (list) => files.attach(list),
    onLive: (update) => live.emit("update", update),
    onEngineError: (run: Run, error) => options.log?.(`run ${run.id} failed in the engine: ${error instanceof Error ? error.message : String(error)}`),
  });
  let current: Promise<void> = Promise.resolve();
  const kick = () => {
    current = drain.kick().catch((error) => options.log?.(`drain stopped: ${error instanceof Error ? error.message : String(error)}`));
  };
  ensureTemplates(world);
  expireProposals(world);
  const tickAutomations = (now?: number): Run[] => {
    const fired = fireDueAutomations(world, { profile: AUTOMATION_PROFILE, now });
    if (fired.length) {
      options.log?.(`automations: started ${fired.length} run(s)`);
      kick();
    }
    return fired;
  };
  const clock = setInterval(() => {
    try { tickAutomations(); } catch (error) { options.log?.(`automations: ${error instanceof Error ? error.message : String(error)}`); }
    try { expireProposals(world); } catch (error) { options.log?.(`proposals: ${error instanceof Error ? error.message : String(error)}`); }
  }, CLOCK_MS);
  clock.unref();
  // Upkeep of the log (core upkeep.ts): a minute after starting, so it is not in the way of opening, then daily.
  const tidy = () => {
    if (!world.db.isOpen) return;
    try {
      const done = tidyWorld(world);
      if (done.outputs || done.commands) options.log?.(`upkeep: dropped what ${done.outputs} old command(s) printed and ${done.commands} old command record(s)`);
    } catch (error) { options.log?.(`upkeep: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const firstTidy = setTimeout(tidy, TIDY_AFTER_MS);
  const tidying = setInterval(tidy, TIDY_EVERY_MS);
  firstTidy.unref();
  tidying.unref();

  const passes = modulePasses({ world, modules: options.modules, services: options.services, log: options.log });
  // Who tells the user about a notice, where and when: decided here, once, for every device.
  const outlets = new Outlets();
  const reaches: Array<() => Reach[]> = [];
  const attention = watchAttention({ world, outlets, reaches: () => reaches.flatMap((list) => list()), policy: options.attention, presence: options.presence, log: options.log });
  return {
    world,
    modules: options.modules,
    presence: options.presence ?? {},
    owner,
    live,
    files,
    terminals,
    processes,
    archives,
    worktreeDir: (projectId, key) => join(options.dataDir, "worktrees", projectId, key),
    desk,
    outlets,
    reach(list) {
      reaches.push(list);
      attention.look();
    },
    kick,
    steer: (runId, text) => drain.steer(runId, text),
    models: () => options.engine.models?.() ?? Promise.resolve([]),
    tickAutomations,
    syncModule: passes.sync,
    setMailFavorite: (account, id, starred) => setMailFavorite(world, options.services?.() ?? {}, account, id, starred),
    deliver: passes.deliver,
    idle: () => current,
    close() {
      clearInterval(clock);
      clearTimeout(firstTidy);
      clearInterval(tidying);
      archives.close();
      passes.close();
      files.close();
      terminals.closeAll();
      processes.stopAll();
      desk.close();
      attention.close();
      world.close();
      unlock();
    },
  };
}
