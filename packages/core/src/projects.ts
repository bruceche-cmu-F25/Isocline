/** Projects: folders on the home node that Zirma may work in. A conversation either belongs to no project (an
 * everyday conversation) or to one (a development session), fixed when it is created (docs/design/dev-mode.md).
 *
 * A project is added untrusted. Trust allows coding sessions to start there under their selected permission mode.
 * The path is the home node's; only the home node's own machine may add one.
 */
import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { recordDomainEvent } from "./events.ts";
import { iso, newId } from "./ids.ts";
import type { World } from "./world.ts";

export interface Project {
  id: string;
  name: string;
  /** Absolute and resolved (no symlinks), on the home node. */
  path: string;
  createdAt: string;
  /** When the user trusted it; null until then, and no session can start. */
  trustedAt: string | null;
  /** Permission mode for the next new session in this project. */
  defaultMode: SessionMode;
}

export class ProjectError extends Error {
  override name = "ProjectError";
  readonly code: "missing" | "invalid" | "untrusted";
  constructor(code: "missing" | "invalid" | "untrusted", message?: string) {
    super(message ?? (code === "missing" ? "No such project" : code === "untrusted" ? "This folder is not trusted yet" : "Invalid project"));
    this.code = code;
  }
}

export const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** In a development session, `plan` blocks edits and shell calls, `ask` prompts, and `edits` allows
 * project file edits and commands launched from the session folder. External file edits still ask. */
export const SESSION_MODES = ["plan", "ask", "edits"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

function toProject(row: Record<string, unknown>): Project {
  return { id: row.id as string, name: row.name as string, path: row.path as string, createdAt: row.created_at as string,
    trustedAt: (row.trusted_at as string | null) ?? null, defaultMode: row.default_mode as SessionMode };
}

/** Projects not removed, most recently added first. */
export function listProjects(world: World): Project[] {
  return world.db.prepare("SELECT * FROM core_projects WHERE removed_at IS NULL ORDER BY created_at DESC, rowid DESC").all().map(toProject);
}

export function getProject(world: World, id: string): Project {
  const row = PROJECT_ID.test(id) ? world.db.prepare("SELECT * FROM core_projects WHERE id = ? AND removed_at IS NULL").get(id) : undefined;
  if (!row) throw new ProjectError("missing");
  return toProject(row);
}

/** Adds a folder (or returns the one already added there). It starts untrusted. */
export function addProject(world: World, input: { path: string; name?: string }, now: number = Date.now()): Project {
  if (typeof input.path !== "string" || !isAbsolute(input.path)) throw new ProjectError("invalid", "A project is an absolute folder path");
  let path: string;
  try {
    path = realpathSync(input.path);
    if (!statSync(path).isDirectory()) throw new Error("not a folder");
  } catch {
    throw new ProjectError("invalid", "That folder does not exist");
  }
  const name = (input.name ?? basename(path)).replace(/\s+/g, " ").trim().slice(0, 80) || path;
  return world.tx((db) => {
    const existing = db.prepare("SELECT * FROM core_projects WHERE path = ? AND removed_at IS NULL").get(path);
    if (existing) return toProject(existing);
    const id = newId();
    db.prepare("INSERT INTO core_projects (id, name, path, created_at) VALUES (?, ?, ?, ?)").run(id, name, path, iso(now));
    recordDomainEvent(world, { kind: "project.added", subject: `project:${id}`, payload: { name, path }, actor: "user", now });
    return toProject(db.prepare("SELECT * FROM core_projects WHERE id = ?").get(id)!);
  });
}

/** The user allows coding sessions to work in this folder under their selected permission mode. */
export function trustProject(world: World, id: string, now: number = Date.now()): Project {
  return world.tx((db) => {
    const project = getProject(world, id);
    if (!project.trustedAt) {
      db.prepare("UPDATE core_projects SET trusted_at = ? WHERE id = ?").run(iso(now), id);
      recordDomainEvent(world, { kind: "project.trusted", subject: `project:${id}`, payload: { name: project.name, path: project.path }, actor: "user", now });
    }
    return getProject(world, id);
  });
}

/** Removed from Zirma (nothing on disk is touched). Its sessions stay readable but take no new requests. */
export function removeProject(world: World, id: string, now: number = Date.now()): void {
  world.tx((db) => {
    const project = getProject(world, id);
    db.prepare("UPDATE core_projects SET removed_at = ? WHERE id = ?").run(iso(now), id);
    recordDomainEvent(world, { kind: "project.removed", subject: `project:${id}`, payload: { name: project.name }, actor: "user", now });
  });
}
