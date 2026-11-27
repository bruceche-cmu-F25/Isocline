import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addToLock, allMigrations, checkLock, fingerprintMigration, readLock } from "../src/migration-lock.ts";

/** A migration merged into zirma has run on someone's world: its text may not change, and it may not be taken out. */
test("every migration is in migrations.lock.json, unchanged since it was merged", () => {
  const { changed, added, removed } = checkLock();
  assert.deepEqual(changed, [], `Changed after they were merged: ${changed.join(", ")}. Put the old text back and add a new migration.`);
  assert.deepEqual(removed, [], `Taken out after they were merged: ${removed.join(", ")}. Worlds that ran them keep their tables; put them back.`);
  assert.deepEqual(added, [], `New migrations not yet locked: ${added.join(", ")}. Run npm run migrations:lock (and the pull request needs the reviewed label).`);
});

test("ids are unique, and the lock never rewrites a line it has", () => {
  const ids = allMigrations().map((migration) => migration.id);
  assert.equal(new Set(ids).size, ids.length);
  const file = join(mkdtempSync(join(tmpdir(), "zirma-lock-")), "lock.json");
  addToLock(file);
  const [first] = allMigrations();
  assert.equal(readLock(file)[first.id], fingerprintMigration(first));
  const edited = { ...first, sql: `${first.sql}\n-- edited` };
  assert.deepEqual(checkLock([edited], readLock(file)).changed, [first.id]);
  addToLock(file);
  assert.equal(JSON.parse(readFileSync(file, "utf8"))[first.id], fingerprintMigration(first));
});
