/** Zirma's passes through the notes (notes-two-layers.md 4.5): every half minute the home node asks the notes module
 * whether a pass is due (the user has left their pages alone for a few minutes since changing them, the daily time
 * has come, or they asked for a page on a subject) and, if so, starts it as a run under the notes' own profile, whose
 * only tools read the notes and write Zirma's own folder.
 *
 * Each pass is a conversation of its own, archived from the start: it is not one of the user's chats and never
 * waits on them, but it is kept, so what Zirma read and wrote in a pass can be looked at afterwards (in the archived
 * conversations). Before a pass, sources that are gone are taken out of Zirma's pages, which needs no model. */
import { submitRun, updateConversation, userLocale } from "@zirma/core";
import { COMPILE_PROFILE, compileDue, compileStarted, compileState, pruneSources, type Library } from "@zirma/module-notes";
import type { Home } from "./home.ts";

const EVERY_MS = 30_000;

interface NotesHandle { library(world: Home["world"]): { library: Library; id: string } }

/** How long the user's pages must be left alone after a change before Zirma goes through them. */
export function quietMs(env: NodeJS.ProcessEnv = process.env): number {
  const said = Number(env.ZIRMA_NOTES_QUIET_MS);
  return Number.isFinite(said) && said >= 0 ? said : 5 * 60_000;
}

/** Starts a pass if one is due. Returns the run it started, if any. Safe to call as often as you like. */
export function tickNoteCompile(home: Pick<Home, "world" | "modules" | "kick">, now = Date.now(), quiet = quietMs()): string | null {
  const module = home.modules.find((candidate) => candidate.id === "note") as unknown as (NotesHandle & { jobs?: Record<string, unknown> }) | undefined;
  if (!module?.jobs?.compile) return null;
  const { world } = home;
  const state = compileState(world);
  const running = !!state.run && !!world.db.prepare("SELECT 1 FROM core_runs WHERE id = ? AND state IN ('queued', 'running', 'cancelling', 'waiting_input', 'waiting_permission')").get(state.run);
  const locale = userLocale(world) === "zh" ? "zh" : "en";
  const pass = compileDue(world, { now, quietMs: quiet, running, locale });
  if (!pass) return null;
  // Sources that are gone go first, without a model; the pass then sees the pages as they are.
  try { pruneSources(world, module.library(world).library, locale); } catch { /* the library is not there: the pass will say so */ }
  if (!pass.goal) { compileStarted(world, pass, null); return null; }
  const title = locale === "zh" ? "整理笔记" : "Keeping notes";
  const { run } = submitRun(world, { requestId: `note-compile:${pass.kind}:${now}`, goal: pass.goal, profile: COMPILE_PROFILE, now });
  updateConversation(world, run.conversationId, { title, archived: true, now });
  compileStarted(world, pass, run.id);
  home.kick();
  return run.id;
}

export function watchNoteCompile(home: Home, log: (message: string) => void): () => void {
  const tick = () => {
    try {
      const run = tickNoteCompile(home);
      if (run) log(`notes: a pass through the notes started (run ${run})`);
    } catch (error) { log(`notes: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const first = setTimeout(tick, 5_000);
  const every = setInterval(tick, EVERY_MS);
  first.unref();
  every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}
