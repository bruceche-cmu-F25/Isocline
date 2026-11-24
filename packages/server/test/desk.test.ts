import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addProject, answerRequest, getRun, startSession, submitRun, trustProject, type EnginePort } from "@isocline/core";
import { todoModule } from "@isocline/module-todo";
import { createHttpServer, Desk, DeskError, isLocalPage, openHome, type BrowserPage, type DeskRequest } from "../src/index.ts";

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test("a request waits for the Mac app to come for it, and fails at once when there is no app", async () => {
  const desk = new Desk();
  await assert.rejects(desk.ask("browser.read"), (error: DeskError) => error.code === "absent");
  // The app is waiting: the request goes straight to it.
  const poll = desk.next(5000);
  const asked = desk.ask<{ n: number }>("add", { a: 1 });
  const request = (await poll)!;
  assert.deepEqual([request.type, request.params], ["add", { a: 1 }]);
  assert.equal(desk.answer(request.id, { ok: true, result: { n: 2 } }), true);
  assert.deepEqual(await asked, { n: 2 });
  assert.equal(desk.answer(request.id, { ok: true, result: {} }), false, "answered once");
  // Asked while the app is between two waits: it gets it on its next one. A failure and a silence both end the wait.
  const failing = desk.ask("x");
  const second = (await desk.next(5000))!;
  desk.answer(second.id, { ok: false, error: "no pane" });
  await assert.rejects(failing, (error: DeskError) => error.code === "failed" && error.message === "no pane");
  await assert.rejects(desk.ask("slow", {}, 40), (error: DeskError) => error.code === "timeout");
  assert.equal(await desk.next(20), null, "nothing came");
  desk.close();
});

test("a page on this machine is the user's own app; anything else is a website", () => {
  for (const url of ["http://localhost:5173/", "http://127.0.0.1:3000/a", "http://[::1]:8080/", "http://app.localhost:3000"]) assert.equal(isLocalPage(url), true, url);
  for (const url of ["https://example.com", "http://localhost.evil.com", "http://192.168.1.4:3000", "file:///etc/passwd", "nonsense"]) assert.equal(isLocalPage(url), false, url);
});

test("Isocline reads the browser pane through the Mac app: its own app freely, a website only on the user's yes", async () => {
  const replies: string[] = [];
  const engine: EnginePort = {
    async submit(request) {
      const tool = request.tools.find((candidate) => candidate.name === "browser_read");
      if (tool) replies.push(String(await tool.execute({}, new AbortController().signal)));
      return { reply: "ok" };
    },
  };
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "alfred-")), engine, modules: [todoModule] });
  const server: Server = createHttpServer(home, { port: 0, uiDir: "/nonexistent" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // A stand-in for the Mac app: it takes requests over HTTP and answers with what is in its pane.
  let page: BrowserPage = { open: false };
  let running = true;
  const app = (async () => {
    while (running) {
      const { request } = await (await fetch(`${base}/api/desktop/requests`)).json() as { request: DeskRequest | null };
      if (!request) continue;
      const result = request.type === "browser.where" ? { open: page.open, url: page.url } : page;
      await fetch(`${base}/api/desktop/requests/${request.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, result }) });
    }
  })();
  try {
    const project = trustProject(home.world, addProject(home.world, { path: realpathSync(mkdtempSync(join(tmpdir(), "alfred-web-"))), name: "Shop" }).id);
    const session = startSession(home.world, { projectId: project.id, title: "Check the page" });
    const ask = async (requestId: string) => { const { run } = submitRun(home.world, { requestId, goal: "look at the page", profile: "developer", conversationId: session.id }); home.kick(); return run; };
    await tick(100);

    await ask("b1");
    await home.idle();
    assert.match(replies[0], /not open/);

    page = { open: true, url: "http://localhost:5173/cart", title: "Cart", text: "Your cart is empty", console: ["error TypeError: total is undefined (cart.js:12)"] };
    await ask("b2");
    await home.idle();
    assert.match(replies[1], /^Page: Cart — http:\/\/localhost:5173\/cart\n\nWarnings and errors it logged:\n {2}error TypeError: total is undefined \(cart\.js:12\)\n\nVisible text:\nYour cart is empty$/);

    // A website: the user is asked first, with the address; a no reads nothing.
    page = { open: true, url: "https://mail.example.com/inbox", title: "Inbox", text: "private letters", console: [] };
    const run = await ask("b3");
    await tick(200);
    const waiting = getRun(home.world, run.id).run;
    assert.equal(waiting.state, "waiting_permission");
    assert.match(waiting.request!.question, /https:\/\/mail\.example\.com\/inbox/);
    answerRequest(home.world, run.id, { requestId: waiting.request!.id, answer: "deny" });
    await home.idle();
    assert.match(replies[2], /did not allow/);
    assert.ok(!replies[2].includes("private letters"));
  } finally { running = false; server.close(); server.closeAllConnections(); home.close(); await app.catch(() => {}); }
});
