import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { look } from "../src/looking.ts";

test("in a session, looking inside the project is free; outside it, or through a link out of it, asks", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "alfred-look-")));
  const root = join(base, "shop");
  const skills = join(base, "skills");
  const engine = join(base, "engine");
  for (const dir of [root, join(root, "src"), skills, engine, join(base, "secrets")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(base, "secrets", "key.txt"), "x");
  symlinkSync(join(base, "secrets"), join(root, "out"));
  const places = { root, cwd: engine, skills };

  assert.equal(look("read", { path: "src/app.ts" }, places).free, true, "relative to the project");
  assert.equal(look("ls", {}, places).free, true, "the project itself");
  assert.equal(look("grep", { pattern: "checkout", path: root }, places).about, "checkout · .", "named from the project root");
  assert.equal(look("read", { path: "src/app.ts" }, places).about, join("src", "app.ts"));
  assert.equal(look("read", { path: join(skills, "notes", "SKILL.md") }, places).free, true, "Alfred's skills");
  assert.equal(look("read", { path: join(base, "secrets", "key.txt") }, places).free, false);
  assert.equal(look("read", { path: "../secrets/key.txt" }, places).free, false);
  const linked = look("read", { path: "out/key.txt" }, places);
  assert.equal(linked.free, false, "a symlink out of the project counts as outside");
  assert.equal(linked.path, join(base, "secrets", "key.txt"));
  assert.equal(linked.about, linked.path, "outside, the full path");
  assert.equal(look("find", { path: `${root}-other` }, places).free, false, "a sibling with the same prefix is outside");

  // The user's other trusted projects are free to look in; their siblings and links out of them are not.
  const other = join(base, "site");
  mkdirSync(join(other, "app"), { recursive: true });
  symlinkSync(join(base, "secrets"), join(other, "out"));
  const both = { ...places, others: [other] };
  assert.equal(look("read", { path: join(other, "app", "page.tsx") }, both).free, true, "inside another project");
  assert.equal(look("ls", { path: other }, both).free, true, "another project itself");
  assert.equal(look("read", { path: join(other, "app", "page.tsx") }, both).about, join(other, "app", "page.tsx"), "named in full");
  assert.equal(look("read", { path: join(other, "out", "key.txt") }, both).free, false, "a link out of another project");
  assert.equal(look("read", { path: join(base, "secrets", "key.txt") }, both).free, false);
  assert.equal(look("read", { path: join(other, "app") }, { ...both, root: null }).free, false, "only in a session");

  // Not a session: only skills are free.
  assert.equal(look("read", { path: join(root, "src") }, { ...places, root: null }).free, false);
});
