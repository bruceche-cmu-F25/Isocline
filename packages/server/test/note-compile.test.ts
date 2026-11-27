/** Zirma's passes through the notes on the home node (notes-two-layers.md 4.5): a pass is a run under the notes' own
 * profile, in a conversation of its own that is archived from the start, with only the notes' compile tools; what
 * it writes lands in Zirma's folder and nowhere else. The engine here is a stand-in that writes one page. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConversation, getRun, listConversations, type EnginePort, type EngineRequest } from "@zirma/core";
import { createNotesModule, indexLibrary, ZIRMA_DIR } from "@zirma/module-notes";
import { openHome } from "../src/index.ts";
import { tickNoteCompile } from "../src/note-compile.ts";

test("a pass runs under the notes' profile, out of the user's chats, and writes only Zirma's page", async () => {
  const root = mkdtempSync(join(tmpdir(), "zirma-compile-notes-"));
  const notes = createNotesModule({ defaultRoot: root });
  const seen: EngineRequest[] = [];
  const engine: EnginePort = {
    async submit(request) {
      seen.push(request);
      const keep = request.tools.find((tool) => tool.name === "note_keep")!;
      const said = await keep.execute({ title: "咖啡", sections: [{ lines: [{ text: "粉水比 1:15", sources: ["V60 参数"] }] }], why: "第一次整理" }, new AbortController().signal);
      return { reply: said };
    },
  };
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "zirma-compile-")), engine, modules: [notes] });
  try {
    const { library } = notes.library(home.world);
    writeFileSync(join(root, "V60 参数.md"), "粉水比 1:15\n");
    indexLibrary(home.world, library);
    const runId = tickNoteCompile(home, Date.now(), 0);
    assert.ok(runId);
    await home.idle();
    for (let i = 0; i < 50 && getRun(home.world, runId).run.state !== "completed"; i++) { await new Promise((resolve) => setTimeout(resolve, 20)); await home.idle(); }
    const { run } = getRun(home.world, runId);
    assert.equal(run.state, "completed");
    assert.equal(run.profile, "note-compile");
    // Not among the user's chats; kept in the archive.
    assert.ok(getConversation(home.world, run.conversationId).archivedAt);
    assert.ok(!listConversations(home.world).some((one) => one.id === run.conversationId));
    // Only the compile tools.
    assert.deepEqual(seen[0].tools.map((tool) => tool.name).sort(), ["note_keep", "note_list", "note_read", "note_remember", "note_search", "note_suggest_edit", "note_suggest_move"]);
    assert.match(seen[0].goal, /first pass/);
    assert.match(readFileSync(join(root, ZIRMA_DIR, "咖啡.md"), "utf8"), /- 粉水比 1:15(（| \()\[\[V60 参数\]\][）)]/);
    assert.ok(!existsSync(join(root, "咖啡.md")));
    // Nothing changed since: no second pass.
    assert.equal(tickNoteCompile(home, Date.now() + 1000, 0), null);
  } finally {
    home.close();
  }
});
