import { join } from "node:path";
import { CORE_MIGRATIONS, latestEventSeq, openWorld, runCommand, type World } from "@alfred/core";
import { invokeOp, type AlfredModule } from "@alfred/module-kit";
import { recordPage, saveClip, updateClip, type LinksSnapshot } from "@alfred/module-links";
import { modulePasses } from "./passes.ts";

/** Newest first, matching the preview. Public titles are usable before the normal Links sync retrieves the posters. */
const videos = [
  ["O_zcc6Xl12g", "All Code Is Slop (Except Mine) — Lauren Tan, SpaceXSI", "AI Engineer"],
  ["aircAruvnKk", "But what is a neural network? | Deep learning chapter 1", "3Blue1Brown"],
  ["WhWc3b3KhnY", "Spring - Blender Open Movie", "Blender Studio"],
  ["6avJHaC3C2U", "The Art of Code - Dylan Beattie", "NDC Conferences"],
  ["fNk_zzaMoSs", "Vectors | Chapter 1, Essence of linear algebra", "3Blue1Brown"],
] as const;

function restoreVideos(world: World) {
  for (const [id, title, author] of videos.toReversed()) {
    const url = `https://www.youtube.com/watch?v=${id}`;
    const saved = saveClip(world, { url, title });
    if ("error" in saved) throw new Error(saved.error);
    if (!saved.existing) recordPage(world, saved.clip.id, { title, author, site: "YouTube" });
    if (saved.clip.state !== "unread") updateClip(world, saved.clip.id, { state: "unread" });
  }
}

/** A separate world owns both the sample links and their cached files. Open it only when someone visits. */
export function openLinkSample(dataDir: string, links: AlfredModule, log?: (message: string) => void) {
  const world = openWorld(join(dataDir, "link-sample.sqlite"), [...CORE_MIGRATIONS, ...links.migrations]);
  const modules = [links];
  try {
    runCommand(world, { requestId: "link-sample-seed-v1", command: "sample.seed", input: {} }, () => restoreVideos(world));
  } catch (error) {
    world.close();
    throw error;
  }
  const passes = modulePasses({ world, modules, log });
  // The module limits each pass to four covers. A second pass picks up the fifth on a fresh or restored shelf.
  async function refreshCovers() {
    if (!links.sync) return;
    await passes.sync("link");
    if (world.db.isOpen) await passes.sync("link");
  }
  void refreshCovers();
  const read = () => ({ snapshot: links.snapshot!(world) as LinksSnapshot, revision: latestEventSeq(world) });
  return {
    read,
    op(op: string, requestId: string, input: unknown) {
      return { ...invokeOp(world, modules, { op, requestId, input }), ...read() };
    },
    restore(requestId: string) {
      const command = runCommand(world, { requestId, command: "sample.restore", input: {} }, () => restoreVideos(world));
      if (!command.replayed) void refreshCovers();
      return read();
    },
    file: (name: string) => links.file?.(world, name),
    close() { passes.close(); world.close(); },
  };
}
