/** Which of Pi's looking tools (read, grep, find, ls) may run without asking: reading Isocline's own skills, and, in a
 * development session, anything inside the project's folder or inside another project the user trusted. Symlinks are
 * resolved first, so a link inside a project to a file outside it counts as outside. Everything else asks the user.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/** Pi's file tools that only look, by name, with how a step names them. */
export const LOOKERS: Readonly<Record<string, string>> = { read: "Read file", grep: "Search files", find: "Find files", ls: "List folder" };

export function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return !!rel && !rel.startsWith("..") && !rel.startsWith(sep);
}

/** Where a path really points: symlinks resolved, also for a file that does not exist yet. */
export function real(path: string): string {
  try { return realpathSync(path); } catch { /* not there (yet) */ }
  try { return join(realpathSync(dirname(path)), basename(path)); } catch { return path; }
}

export interface Look {
  /** The resolved path it looks at (the question to the user names it in full). */
  path: string;
  label: string;
  about: string;
  /** True when it may run without asking. */
  free: boolean;
}

/** `root`: a development session's project folder (resolved), or null. `cwd`: where relative paths start otherwise.
 * `others`: in a session, the user's other trusted projects (resolved): looking there is free too. */
export function look(name: string, input: Record<string, unknown>, places: { root: string | null; cwd: string; skills: string; others?: readonly string[] }): Look {
  const path = real(resolve(places.root ?? places.cwd, String(input.path ?? "")));
  const inProject = places.root !== null && (path === places.root || inside(places.root, path));
  // Inside the project a step names the path from its root ("src/app.ts", "." for the root); elsewhere in full.
  const shown = inProject ? relative(places.root!, path) || "." : path;
  const about = name === "grep" && input.pattern ? `${String(input.pattern).slice(0, 80)} · ${shown}` : shown;
  const inOther = places.root !== null && (places.others ?? []).some((other) => path === other || inside(other, path));
  const free = inside(places.skills, path) || inProject || inOther;
  return { path, label: LOOKERS[name] ?? name, about, free };
}
