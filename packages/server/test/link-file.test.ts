/** Zirma's passes that file links, on the home node (docs/design/links-autofile.md §3): a pass is a run under the
 * links' own profile, in a conversation archived from the start, with one tool; the next tick finishes it. The engine
 * here is a stand-in that files every link of the batch under one category. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConversation, getRun, listConversations, listEvents, type EnginePort, type EngineRequest } from "@zirma/core";
import { createLinksModule, currentPass, listClips, QUIET_MS, recordPage, saveClip, setAutoFile } from "@zirma/module-links";
import { openHome } from "../src/index.ts";
import { tickLinkFile } from "../src/link-file.ts";

test("a pass files the batch under the links' own profile, out of the user's chats, and the next tick finishes it", async () => {
  const links = createLinksModule({ fetcher: async (url) => ({ url, title: "A page" }), icons: async () => null, covers: async () => null });
  const seen: EngineRequest[] = [];
  const engine: EnginePort = {
    async submit(request) {
      seen.push(request);
      const file = request.tools.find((tool) => tool.name === "link_file")!;
      const ids = [...request.goal.matchAll(/^id: (\S+)/gm)].map((match) => match[1]);
      const said: string[] = [];
      for (const [i, id] of ids.entries()) said.push(String(await file.execute(i === 0 ? { id, category: "Reading", area: "learn" } : { id, category: "Reading" }, new AbortController().signal)));
      return { reply: said.join("\n") };
    },
  };
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "zirma-link-file-")), engine, modules: [links] });
  try {
    const world = home.world;
    const save = (path: string) => { const clip = saveClip(world, { url: `https://example.com/${path}` }); assert.ok(!("error" in clip)); recordPage(world, clip.clip.id, { title: path }); return clip.clip.id; };
    save("before");
    assert.equal(tickLinkFile(home, Date.now() + QUIET_MS * 2), null, "off until the user turns it on");
    setAutoFile(world, true);
    const ids = [save("a"), save("b")];
    assert.equal(tickLinkFile(home, Date.now()), null, "the last one is not alone a minute yet");
    const runId = tickLinkFile(home, Date.now() + QUIET_MS * 2);
    assert.ok(runId);
    await home.idle();
    for (let i = 0; i < 50 && getRun(world, runId).run.state !== "completed"; i++) { await new Promise((resolve) => setTimeout(resolve, 20)); await home.idle(); }
    const { run } = getRun(world, runId);
    assert.equal(run.state, "completed");
    assert.equal(run.profile, "link-file");
    assert.ok(getConversation(world, run.conversationId).archivedAt);
    assert.ok(!listConversations(world).some((one) => one.id === run.conversationId));
    assert.deepEqual(seen[0].tools.map((tool) => tool.name), ["link_file"], "only its one tool");
    assert.match(seen[0].goal, /<links>/);

    const clips = listClips(world);
    for (const id of ids) assert.equal(clips.find((clip) => clip.id === id)?.filedByZirma, true);
    assert.equal(clips.find((clip) => clip.url.endsWith("/before"))?.topicId, undefined, "saved before it was on: left alone");

    // The next tick finishes the pass; nothing is left to start another.
    assert.ok(currentPass(world));
    assert.equal(tickLinkFile(home, Date.now() + QUIET_MS * 2), null);
    assert.equal(currentPass(world), undefined);
    assert.deepEqual(listEvents(world).events.filter((event) => event.kind === "link.auto_filed").map((event) => event.payload), [{ kind: "auto", filed: 2, made: 1, tried: 2 }]);
  } finally {
    home.close();
  }
});
