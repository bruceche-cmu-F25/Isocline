/** Zirma's passes that file links on their own (docs/design/links-autofile.md §2–§3): every half minute the home node
 * finishes a pass whose run has ended, then asks the links module whether another is due (links saved since the
 * switch went on, ten ready or the last one alone a minute; or the Unfiled button's sweep) and, if so, starts it as a
 * run under the links' own profile, whose one tool files one link of the batch.
 *
 * Each pass is a conversation of its own, archived from the start, like the notes' passes (note-compile.ts): not one
 * of the user's chats, but kept, so what Zirma filed and why can be looked at afterwards. */
import { isRunUnfinished, submitRun, updateConversation, userLocale } from "@zirma/core";
import { attachRun, beginFilePass, currentPass, FILE_PROFILE, filePassDue, filePassGoal, finishFilePass } from "@zirma/module-links";
import type { Home } from "./home.ts";

const EVERY_MS = 30_000;

/** Finishes an ended pass and starts one if due. Returns the run it started, if any. Safe to call as often as you like. */
export function tickLinkFile(home: Pick<Home, "world" | "modules" | "kick">, now = Date.now()): string | null {
  const module = home.modules.find((candidate) => candidate.id === "link");
  if (!module?.jobs?.file) return null;
  const { world } = home;
  const pass = currentPass(world);
  if (pass) {
    if (pass.runId && isRunUnfinished(world, pass.runId)) return null;
    finishFilePass(world, pass.id, now);
  }
  const due = filePassDue(world, now);
  if (!due) return null;
  const locale = userLocale(world) === "zh" ? "zh" : "en";
  const passId = beginFilePass(world, due, now);
  try {
    const { run } = submitRun(world, { requestId: `link-file:${passId}`, goal: filePassGoal(world, passId, locale), profile: FILE_PROFILE, now });
    updateConversation(world, run.conversationId, { title: locale === "zh" ? "归类链接" : "Filing links", archived: true, now });
    attachRun(world, passId, run.id);
    home.kick();
    return run.id;
  } catch (error) {
    finishFilePass(world, passId, now);
    throw error;
  }
}

export function watchLinkFile(home: Home, log: (message: string) => void): () => void {
  const tick = () => {
    try {
      const run = tickLinkFile(home);
      if (run) log(`links: a pass filing links started (run ${run})`);
    } catch (error) { log(`links: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const first = setTimeout(tick, 5_000);
  const every = setInterval(tick, EVERY_MS);
  first.unref();
  every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}
