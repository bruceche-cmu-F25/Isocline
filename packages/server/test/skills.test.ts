import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnginePort } from "@zirma/core";
import { Skills } from "@zirma/engine-pi";
import { todoModule } from "@zirma/module-todo";
import type { SkillInfo, SkillsResponse } from "@zirma/protocol";
import { createHttpServer, openHome } from "../src/index.ts";

test("the skills routes list, show, switch and remove Zirma's skills, and add one found on this machine", async () => {
  const base = mkdtempSync(join(tmpdir(), "alfred-skills-http-"));
  const dataDir = join(base, "data"), userHome = join(base, "home");
  const put = (root: string, name: string) => {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: What ${name} is for.\n---\n\n# ${name}\n`);
  };
  put(join(dataDir, "skills"), "notes");
  put(join(userHome, ".claude", "skills"), "tdd");
  const engine: EnginePort = { async submit() { return { reply: "" }; } };
  const home = openHome({ dataDir, engine, modules: [todoModule] });
  const skills = new Skills({ dataDir, home: userHome, fetcher: (async () => new Response("{}", { status: 503 })) as typeof fetch });
  const server: Server = createHttpServer(home, { port: 0, uiDir: "/nonexistent", skills });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(`${at}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const listed = await (await fetch(`${at}/api/skills`)).json() as SkillsResponse;
    assert.deepEqual(listed.skills, [{ id: "notes", name: "notes", description: "What notes is for.", enabled: true }]);
    assert.deepEqual(listed.found.map((skill) => [skill.name, skill.place]), [["tdd", "~/.claude/skills"]]);
    assert.deepEqual(await (await fetch(`${at}/api/skills/content?id=notes`)).json(), { content: "# notes" });
    assert.equal((await fetch(`${at}/api/skills/content?id=..%2F..%2Fsecrets`)).status, 404);

    const off = await post("/api/skills/disable", { id: "notes" });
    assert.equal(((await off.json()) as SkillInfo).enabled, false);
    assert.match(readFileSync(join(dataDir, "skills", "notes", "SKILL.md"), "utf8"), /disable-model-invocation: true/);
    assert.equal((await post("/api/skills/enable", { id: "nope" })).status, 404);
    assert.equal((await post("/api/skills/enable", {})).status, 400);
    // A body is read here as at every other address: JSON, sent as JSON.
    assert.equal((await fetch(`${at}/api/skills/enable`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "notes" })).status, 415);
    assert.equal((await fetch(`${at}/api/skills/enable`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status, 400);

    const added = await post("/api/skills/add", { path: listed.found[0].path });
    assert.equal(((await added.json()) as SkillInfo).id, "tdd");
    assert.equal((await post("/api/skills/add", { path: join(userHome, ".ssh") })).status, 404);
    // skills.sh is away: said as such, not as a fault of Zirma's.
    assert.equal((await post("/api/skills/search", { query: "pdf" })).status, 502);

    assert.equal((await post("/api/skills/remove", { id: "notes" })).status, 200);
    assert.deepEqual(((await (await fetch(`${at}/api/skills`)).json()) as SkillsResponse).skills.map((skill) => skill.id), ["tdd"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    home.close?.();
  }
});
