import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setSkillDisabled, SkillError, Skills } from "../src/index.ts";

const skillText = (name: string, extra = "") => `---\nname: ${name}\ndescription: What ${name} is for.\n${extra}---\n\n# ${name}\n\nDo the thing.\n`;

function setup(site: Record<string, unknown> = {}) {
  const base = mkdtempSync(join(tmpdir(), "alfred-skills-"));
  const dataDir = join(base, "data"), home = join(base, "home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const asked: string[] = [];
  const changes: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    asked.push(url.pathname + url.search);
    const body = site[url.pathname];
    return body === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const skills = new Skills({ dataDir, home, api: "https://skills.test", fetcher, onChange: (kind, name) => changes.push(`${kind} ${name}`) });
  const put = (root: string, folder: string, name = folder, extra = "") => {
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, "SKILL.md"), skillText(name, extra));
  };
  return { dataDir, home, skills, asked, changes, put, dir: join(dataDir, "skills"), rev: () => { try { return readFileSync(join(dataDir, "skills.rev"), "utf8"); } catch { return ""; } } };
}

test("the frontmatter switch changes one line and nothing else", () => {
  const plain = skillText("notes");
  const off = setSkillDisabled(plain, true);
  assert.equal(off, plain.replace("---\n", "---\ndisable-model-invocation: true\n"));
  assert.equal(setSkillDisabled(off, true), off);
  assert.equal(setSkillDisabled(off, false), plain);
  assert.equal(setSkillDisabled(plain, false), plain);
  // An explicit false is changed in place, never doubled.
  const explicit = skillText("notes", "disable-model-invocation: false\n");
  assert.equal(setSkillDisabled(explicit, true), skillText("notes", "disable-model-invocation: true\n"));
  // A line in the body that names the key is left alone.
  const body = `${plain}\ndisable-model-invocation: true\n`;
  assert.equal(setSkillDisabled(setSkillDisabled(body, true), false), body);
});

test("Isocline's skills are listed, switched off and on, read and removed", () => {
  const t = setup();
  t.put(t.dir, "notes");
  t.put(t.dir, "quiet", "quiet", "disable-model-invocation: true\n");
  assert.deepEqual(t.skills.list().skills.map((skill) => [skill.id, skill.name, skill.enabled]), [["notes", "notes", true], ["quiet", "quiet", false]]);
  assert.equal(t.skills.content("notes").content, "# notes\n\nDo the thing.");

  assert.equal(t.rev(), "");
  assert.equal(t.skills.setEnabled("notes", false).enabled, false);
  const stamp = t.rev();
  assert.ok(stamp, "sessions are told to open anew");
  assert.match(readFileSync(join(t.dir, "notes", "SKILL.md"), "utf8"), /^---\ndisable-model-invocation: true\nname: notes\n/);
  assert.equal(t.skills.list().skills[0].enabled, false);
  assert.equal(t.skills.setEnabled("notes", true).enabled, true);
  assert.equal(readFileSync(join(t.dir, "notes", "SKILL.md"), "utf8"), skillText("notes"));
  // Already in that state: the file and the stamp stay.
  const before = t.rev();
  t.skills.setEnabled("notes", true);
  assert.equal(t.rev(), before);

  t.skills.remove("quiet");
  assert.equal(existsSync(join(t.dir, "quiet")), false);
  assert.deepEqual(t.skills.list().skills.map((skill) => skill.id), ["notes"]);
  assert.throws(() => t.skills.remove("quiet"), (error: SkillError) => error.code === "not_found");
  assert.throws(() => t.skills.content("../secrets"), (error: SkillError) => error.code === "not_found");
  assert.deepEqual(t.changes, ["disabled notes", "enabled notes", "removed quiet"]);
});

test("a skill found in another agent's folder is copied whole; only the listed ones can be added", () => {
  const t = setup();
  t.put(t.dir, "notes");
  const claude = join(t.home, ".claude", "skills"), agents = join(t.home, ".agents", "skills");
  t.put(agents, "pdf");
  mkdirSync(join(agents, "pdf", "scripts"), { recursive: true });
  writeFileSync(join(agents, "pdf", "scripts", "fill.py"), "print('fill')\n");
  mkdirSync(join(agents, "pdf", "node_modules", "x"), { recursive: true });
  writeFileSync(join(agents, "pdf", "node_modules", "x", "index.js"), "");
  // The same skill linked into a second place, and one Isocline already has: each name is offered once, or not at all.
  mkdirSync(claude, { recursive: true });
  symlinkSync(join(agents, "pdf"), join(claude, "pdf"));
  t.put(claude, "notes");
  t.put(claude, "tdd");

  const found = t.skills.list().found;
  assert.deepEqual(found.map((skill) => [skill.name, skill.place]), [["pdf", "~/.agents/skills"], ["tdd", "~/.claude/skills"]]);
  const added = t.skills.addFound(found[0].path);
  assert.deepEqual([added.id, added.name, added.enabled, added.source], ["pdf", "pdf", true, undefined]);
  assert.equal(readFileSync(join(t.dir, "pdf", "scripts", "fill.py"), "utf8"), "print('fill')\n");
  assert.equal(existsSync(join(t.dir, "pdf", "node_modules")), false);
  assert.deepEqual(t.skills.list().found.map((skill) => skill.name), ["tdd"]);

  assert.throws(() => t.skills.addFound(join(t.home, ".ssh")), (error: SkillError) => error.code === "not_found");
  assert.throws(() => t.skills.addFound(found[0].path), (error: SkillError) => error.code === "not_found", "Isocline has it now");
  assert.deepEqual(t.changes, ["added pdf"]);
});

test("Code loads an explicitly named, enabled Isocline skill and keeps its request separate", () => {
  const t = setup();
  t.put(join(t.home, ".pi", "agent", "skills"), "layout", "apple-design");
  const invoke = (text: string) => t.skills.expandCommand(text);
  assert.equal(invoke("explain /skill:apple-design"), "explain /skill:apple-design");
  assert.equal(invoke("Example:\n/skill:apple-design"), "Example:\n/skill:apple-design");
  assert.throws(() => invoke("/skill:apple-design"), { name: "SkillError" }, "discovery alone does not install it");
  assert.throws(() => invoke("/skill:../../outside"), { name: "SkillError" });

  const [found] = t.skills.list().found;
  const skill = t.skills.addFound(found.path);
  const expanded = invoke("/skill:apple-design\nReview the layout\nthen the type.");
  assert.ok(expanded.includes(join(t.dir, "layout")), "references point to the installed copy");
  assert.match(expanded, /<skill>\n# apple-design\n\nDo the thing\.\n<\/skill>\n\nReview the layout\nthen the type\.$/);
  assert.ok(!expanded.includes("description:"));
  assert.match(invoke("/skill:apple-design"), /<\/skill>$/);
  t.skills.setEnabled(skill.id, false);
  assert.throws(() => invoke("/skill:apple-design more"), { name: "SkillError" });
});

test("a skill from skills.sh is searched for, downloaded, checked for a newer version and updated", async () => {
  const files = (body: string) => [{ path: "SKILL.md", contents: skillText("pdf").replace("Do the thing.", body) }, { path: "scripts/fill.py", contents: "print('fill')\n" }];
  const site: Record<string, unknown> = {
    "/api/search": { skills: [
      { id: "acme/skills/docx", source: "acme/skills", skillId: "docx", name: "docx", installs: 10 },
      { id: "acme/skills/pdf", source: "acme/skills", skillId: "pdf", name: "pdf", installs: 2000 },
      { id: "bad", source: "../etc", skillId: "passwd", name: "passwd", installs: 9 },
    ] },
    "/api/download/acme/skills/pdf": { hash: "one", files: files("First.") },
  };
  const t = setup(site);
  const results = await t.skills.search("  pdf  ");
  assert.deepEqual(results.map((result) => [result.package, result.installs, result.added]), [["acme/skills/pdf", 2000, false], ["acme/skills/docx", 10, false]]);
  assert.equal(t.asked[0], "/api/search?q=pdf&limit=30");

  const added = await t.skills.install("acme/skills/pdf");
  assert.deepEqual(added, { id: "pdf", name: "pdf", description: "What pdf is for.", enabled: true, source: { package: "acme/skills/pdf", url: "https://skills.sh/acme/skills/pdf" } });
  assert.equal(readFileSync(join(t.dir, "pdf", "scripts", "fill.py"), "utf8"), "print('fill')\n");
  assert.equal((await t.skills.search("pdf"))[0].added, true);
  await assert.rejects(t.skills.install("acme/skills/pdf"), (error: SkillError) => error.code === "exists");
  await assert.rejects(t.skills.install("acme/skills/../../x"), (error: SkillError) => error.code === "invalid");
  await assert.rejects(t.skills.install("acme/skills/none"), (error: SkillError) => error.code === "unreachable");

  assert.deepEqual(await t.skills.updates(), { updates: [], failed: [] });
  site["/api/download/acme/skills/pdf"] = { hash: "two", files: files("Second.") };
  assert.deepEqual(await t.skills.updates(), { updates: ["pdf"], failed: [] });
  // Switched off stays switched off through an update.
  t.skills.setEnabled("pdf", false);
  const updated = await t.skills.update("pdf");
  assert.equal(updated.enabled, false);
  assert.match(t.skills.content("pdf").content, /Second\./);
  assert.deepEqual(await t.skills.updates(), { updates: [], failed: [] });
  assert.deepEqual(t.changes, ["added pdf", "disabled pdf", "updated pdf"]);
});

test("a download cannot write outside its own folder, and what is not a skill is not kept", async () => {
  const t = setup({
    "/api/download/acme/skills/escape": { hash: "x", files: [{ path: "SKILL.md", contents: skillText("escape") }, { path: "../../outside.txt", contents: "no" }] },
    "/api/download/acme/skills/rooted": { hash: "x", files: [{ path: "SKILL.md", contents: skillText("rooted") }, { path: "/tmp/outside.txt", contents: "no" }] },
    "/api/download/acme/skills/empty": { hash: "x", files: [{ path: "README.md", contents: "hello" }] },
    "/api/download/acme/skills/blank": { hash: "x", files: [{ path: "SKILL.md", contents: "# No frontmatter\n" }] },
  });
  for (const name of ["escape", "rooted", "empty", "blank"]) {
    await assert.rejects(t.skills.install(`acme/skills/${name}`), (error: SkillError) => error.code === "invalid", name);
    assert.equal(existsSync(join(t.dir, name)), false, name);
  }
  assert.equal(existsSync(join(t.dataDir, "outside.txt")), false);
  assert.deepEqual(t.skills.list().skills, []);
  assert.deepEqual(t.changes, []);
});
