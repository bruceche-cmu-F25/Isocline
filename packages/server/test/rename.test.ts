import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { moveRenamedFolders, renamedFolders } from "../src/rename.ts";

const PRODUCTION = { ZIRMA_ENV: "production" };
const support = (home: string, name: string) => join(home, "Library", "Application Support", name);
const logs = (home: string, name: string) => join(home, "Library", "Logs", name);
const seed = (folder: string, text: string) => { mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, "world.sqlite"), text); };

test("an Isocline install: its world and logs move to Zirma's folders, once", () => {
  const home = mkdtempSync(join(tmpdir(), "zirma-rename-"));
  seed(support(home, "Isocline"), "the Isocline world");
  mkdirSync(logs(home, "Isocline"), { recursive: true });
  const moved = moveRenamedFolders(renamedFolders(home, PRODUCTION, "darwin"));
  assert.deepEqual(moved.map((move) => move.from), [support(home, "Isocline"), logs(home, "Isocline")]);
  assert.equal(readFileSync(join(support(home, "Zirma"), "world.sqlite"), "utf8"), "the Isocline world");
  assert.equal(existsSync(support(home, "Isocline")), false);
  assert.equal(existsSync(logs(home, "Zirma")), true);
  assert.deepEqual(moveRenamedFolders(renamedFolders(home, PRODUCTION, "darwin")), [], "nothing the second time");
});

test("an install that only ever had Alfred moves straight to Zirma, and the newer name wins when both are there", () => {
  const alfredOnly = mkdtempSync(join(tmpdir(), "zirma-rename-"));
  seed(support(alfredOnly, "Alfred"), "the Alfred world");
  moveRenamedFolders(renamedFolders(alfredOnly, PRODUCTION, "darwin"));
  assert.equal(readFileSync(join(support(alfredOnly, "Zirma"), "world.sqlite"), "utf8"), "the Alfred world");

  const both = mkdtempSync(join(tmpdir(), "zirma-rename-"));
  seed(support(both, "Alfred"), "older");
  seed(support(both, "Isocline"), "newer");
  moveRenamedFolders(renamedFolders(both, PRODUCTION, "darwin"));
  assert.equal(readFileSync(join(support(both, "Zirma"), "world.sqlite"), "utf8"), "newer");
  assert.equal(existsSync(support(both, "Alfred")), true, "the older one is left where it is");
});

test("development moves its own Isocline Dev world, never production's, and leaves the logs to production", () => {
  const home = mkdtempSync(join(tmpdir(), "zirma-rename-"));
  seed(support(home, "Isocline Dev"), "the dev world");
  seed(support(home, "Isocline"), "the real world");
  mkdirSync(logs(home, "Isocline"), { recursive: true });
  moveRenamedFolders(renamedFolders(home, {}, "darwin"));
  assert.equal(readFileSync(join(support(home, "Zirma Dev"), "world.sqlite"), "utf8"), "the dev world");
  assert.equal(existsSync(support(home, "Zirma")), false, "production's world is production's to move");
  assert.equal(existsSync(logs(home, "Isocline")), true);
});

test("a new folder that already exists is never overwritten, and a world given by path stays where it is", () => {
  const home = mkdtempSync(join(tmpdir(), "zirma-rename-"));
  seed(support(home, "Isocline"), "the old world");
  seed(support(home, "Zirma"), "the new world");
  assert.deepEqual(moveRenamedFolders(renamedFolders(home, PRODUCTION, "darwin")), []);
  assert.equal(readFileSync(join(support(home, "Zirma"), "world.sqlite"), "utf8"), "the new world");
  for (const name of ["ZIRMA_DATA_DIR", "ISOCLINE_DATA_DIR", "ALFRED_DATA_DIR"]) assert.deepEqual(renamedFolders(home, { ...PRODUCTION, [name]: "/dev/world" }, "darwin"), []);
  assert.deepEqual(renamedFolders(home, { ...PRODUCTION, XDG_DATA_HOME: "/data" }, "linux"), [
    { from: "/data/isocline", to: "/data/zirma" },
    { from: "/data/alfred", to: "/data/zirma" },
  ]);
  assert.deepEqual(renamedFolders(home, { XDG_DATA_HOME: "/data" }, "linux"), [{ from: "/data/isocline-dev", to: "/data/zirma-dev" }]);
});
