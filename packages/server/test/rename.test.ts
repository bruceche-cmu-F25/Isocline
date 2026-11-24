import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { moveRenamedFolders, renamedFolders } from "../src/rename.ts";

test("an install from before the rename: its world and logs move to the new folders, once", () => {
  const home = mkdtempSync(join(tmpdir(), "isocline-rename-"));
  const moves = renamedFolders(home, {}, "darwin");
  const [world, logs] = moves;
  mkdirSync(world!.from, { recursive: true });
  writeFileSync(join(world!.from, "world.sqlite"), "the world");
  mkdirSync(logs!.from, { recursive: true });
  assert.deepEqual(moveRenamedFolders(moves), moves);
  assert.equal(readFileSync(join(world!.to, "world.sqlite"), "utf8"), "the world");
  assert.equal(existsSync(world!.from), false);
  assert.deepEqual(moveRenamedFolders(moves), [], "nothing the second time");
});

test("a new folder that already exists is never overwritten, and a development world stays where it is", () => {
  const home = mkdtempSync(join(tmpdir(), "isocline-rename-"));
  const [world] = renamedFolders(home, {}, "darwin");
  mkdirSync(world!.from, { recursive: true });
  mkdirSync(world!.to, { recursive: true });
  writeFileSync(join(world!.to, "world.sqlite"), "the new world");
  assert.deepEqual(moveRenamedFolders([world!]), []);
  assert.equal(readFileSync(join(world!.to, "world.sqlite"), "utf8"), "the new world");
  assert.deepEqual(renamedFolders(home, { ISOCLINE_DATA_DIR: "/dev/world" }, "darwin"), []);
  assert.deepEqual(renamedFolders(home, { XDG_DATA_HOME: "/data" }, "linux"), [{ from: "/data/alfred", to: "/data/isocline" }]);
});
