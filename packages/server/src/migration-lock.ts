/** Migrations, once merged, are never changed (docs/WORKFLOW.md §6): a world that already ran one would not run the
 * new text, so two worlds would end up with different tables under the same id. `migrations.lock.json` at the repo
 * root keeps a fingerprint of every migration; `npm test` compares them (test/migration-lock.test.ts), and a pull
 * request that changes the lock needs the `reviewed` label before CI passes (.github/workflows/ci.yml).
 *
 * Add a new migration's line with `npm run migrations:lock`. It never rewrites an existing line. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CORE_MIGRATIONS, type Migration } from "@zirma/core";
import { calendarModule } from "@zirma/module-calendar";
import { linksModule } from "@zirma/module-links";
import { mailModule } from "@zirma/module-mail";
import { createNotesModule } from "@zirma/module-notes";
import { createGoalsModule } from "@zirma/module-goals";
import { todoModule } from "@zirma/module-todo";

export const LOCK_FILE = fileURLToPath(new URL("../../../migrations.lock.json", import.meta.url));

/** Every migration a home node runs: the core's, then each built-in module's. */
export function allMigrations(): Migration[] {
  const notes = createNotesModule({ defaultRoot: "/nonexistent" });
  const modules = [todoModule, calendarModule, mailModule, linksModule, notes, createGoalsModule({ notes })];
  return [...CORE_MIGRATIONS, ...modules.flatMap((module) => module.migrations)];
}

/** What a migration does: its SQL and, if it has one, the source of its data upgrade. */
export function fingerprintMigration(migration: Migration): string {
  const hash = createHash("sha256").update(migration.sql, "utf8");
  if (migration.apply) hash.update("\0apply\0").update(migration.apply.toString(), "utf8");
  return hash.digest("hex").slice(0, 16);
}

export function readLock(file = LOCK_FILE): Record<string, string> {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>) : {};
}

export interface LockProblems {
  /** In the lock with another fingerprint: changed after it was merged. */
  changed: string[];
  /** Not in the lock yet: new, and to be added with `npm run migrations:lock`. */
  added: string[];
  /** In the lock but gone: a world that ran it keeps its tables, so it may not be taken out. */
  removed: string[];
}

export function checkLock(migrations: readonly Migration[] = allMigrations(), lock = readLock()): LockProblems {
  const ids = new Set(migrations.map((migration) => migration.id));
  return {
    changed: migrations.filter((migration) => lock[migration.id] && lock[migration.id] !== fingerprintMigration(migration)).map((migration) => migration.id),
    added: migrations.filter((migration) => !lock[migration.id]).map((migration) => migration.id),
    removed: Object.keys(lock).filter((id) => !ids.has(id)),
  };
}

/** Adds the new migrations to the lock, in the order they run. Existing lines are kept as they are. */
export function addToLock(file = LOCK_FILE): string[] {
  const lock = readLock(file);
  const added: string[] = [];
  for (const migration of allMigrations()) {
    if (lock[migration.id]) continue;
    lock[migration.id] = fingerprintMigration(migration);
    added.push(migration.id);
  }
  writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
  return added;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const added = addToLock();
  console.log(added.length ? `Added to migrations.lock.json: ${added.join(", ")}` : "migrations.lock.json already lists every migration");
  const { changed, removed } = checkLock();
  if (changed.length || removed.length) {
    console.error(`Not fixed by this: changed ${changed.join(", ") || "none"}; removed ${removed.join(", ") || "none"}. Put the old migration back and add a new one.`);
    process.exit(1);
  }
}
