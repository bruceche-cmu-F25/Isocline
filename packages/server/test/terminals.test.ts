import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addProject, startSession, submitRun, trustProject, type EnginePort } from "@isocline/core";
import { todoModule } from "@isocline/module-todo";
import { createHttpServer, openHome, plainLines, Terminals, type TerminalEvent } from "../src/index.ts";

const until = async (done: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!done()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((resolve) => setTimeout(resolve, 30)); } };

test("what a terminal printed is read as plain lines: no colours, and a redrawn line as it last stood", () => {
  assert.deepEqual(plainLines("\u001b[1m\u001b[31merror\u001b[0m: build failed\r\n  at \u001b[4msrc/app.ts\u001b[0m:12\r\n"), ["error: build failed", "  at src/app.ts:12", ""]);
  assert.deepEqual(plainLines("downloading 10%\rdownloading 55%\rdownloading 100%\ndone\n"), ["downloading 100%", "done", ""]);
  assert.deepEqual(plainLines("\u001b]0;window title\u0007prompt % \u001b[?2004h"), ["prompt %"]);
});

test("a session's terminal is a real shell in its folder: it takes input, keeps what it printed, and ends when closed", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "alfred-term-")));
  const terminals = new Terminals();
  try {
    const opened = terminals.open("s1", cwd, { cols: 90, rows: 20 });
    assert.deepEqual([opened.cwd, opened.exited], [cwd, false]);
    assert.equal(terminals.open("s1", cwd).offset >= 0, true, "opening again answers the one already open");
    const seen: TerminalEvent[] = [];
    const stop = terminals.follow("s1", 0, (event) => seen.push(event));
    terminals.write("s1", "echo sum-$((40 + 2)); pwd\r");
    const text = () => seen.map((event) => (event.type === "output" ? event.data : "")).join("");
    await until(() => text().includes("sum-42") && text().includes(cwd));
    stop();
    // What it printed is kept: a page that comes back gets it again, and Isocline can read the end of it.
    const again: string[] = [];
    terminals.follow("s1", 0, (event) => { if (event.type === "output") again.push(event.data); })();
    assert.ok(again.join("").includes("sum-42"));
    assert.match(terminals.tail("s1", 40)!, /sum-42/);
    assert.equal(terminals.tail("other", 40), null);
    terminals.resize("s1", 120, 30);
    assert.throws(() => terminals.write("nope", "x"), /No terminal is open/);
    assert.throws(() => terminals.open("s2", join(cwd, "missing")), /folder is not there/);
    terminals.close("s1");
    assert.equal(terminals.has("s1"), false);
  } finally { terminals.closeAll(); }
});

test("the terminal is opened over HTTP for a trusted session's folder, and Isocline reads it but cannot type into it", async () => {
  const seenTools: string[][] = [];
  let read = "";
  const engine: EnginePort = {
    async submit(request) {
      seenTools.push(request.tools.map((tool) => tool.name));
      const tool = request.tools.find((candidate) => candidate.name === "terminal_read");
      if (tool) read = String(await tool.execute({ lines: 20 }, new AbortController().signal));
      return { reply: "ok" };
    },
  };
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine, modules: [todoModule] });
  const server: Server = createHttpServer(home, { port: 0, uiDir: "/nonexistent" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "alfred-term-")));
    const project = trustProject(home.world, addProject(home.world, { path: folder, name: "Shop" }).id);
    const session = startSession(home.world, { projectId: project.id, title: "Fix the build" });
    const daily = submitRun(home.world, { requestId: "d1", goal: "hello", profile: "assistant" }).run;

    assert.equal((await post(`/api/conversations/${daily.conversationId}/terminal`, {})).status, 404, "an everyday conversation has no terminal");
    assert.equal((await post(`/api/conversations/${session.id}/terminal/input`, { data: "ls\r" })).status, 404, "not before it is opened");
    const opened = await post(`/api/conversations/${session.id}/terminal`, { cols: 80, rows: 24 });
    assert.deepEqual([opened.status, (await opened.json() as { cwd: string }).cwd], [200, folder]);
    assert.equal((await post(`/api/conversations/${session.id}/terminal/input`, { data: "echo build-$((6 * 7))-failed\r" })).status, 200);
    await until(() => /build-42-failed/.test(home.terminals.tail(session.id, 20) ?? ""));

    // The stream replays what was printed, then follows.
    const stream = await fetch(`${base}/api/conversations/${session.id}/terminal/stream?from=0`);
    const reader = stream.body!.getReader();
    let got = "";
    while (!got.includes("build-42-failed")) { const { value, done } = await reader.read(); if (done) break; got += new TextDecoder().decode(value); }
    await reader.cancel();
    assert.match(got, /event: output\ndata: \{"type":"output"/);

    // A run in the session can read the terminal's last lines; it has no tool that writes to it.
    submitRun(home.world, { requestId: "s1", goal: "why did the build fail?", profile: "developer", conversationId: session.id });
    home.kick();
    await home.idle();
    assert.match(read, /^The user's terminal, last lines \(output only\):\n[\s\S]*build-42-failed/);
    // The everyday conversation's run came first and has no such tool; the session's has the one that reads.
    assert.deepEqual(seenTools.map((names) => names.filter((name) => name.startsWith("terminal"))), [[], ["terminal_read"]]);

    assert.equal((await post(`/api/conversations/${session.id}/terminal/close`, {})).status, 200);
    assert.equal(home.terminals.has(session.id), false);
  } finally { server.close(); server.closeAllConnections(); home.close(); }
});
