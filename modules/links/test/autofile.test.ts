/** Filing links on their own, the rules before any model (docs/design/links-autofile.md §2, §4, §5): who filed a
 * link is kept, only links nobody decided about wait to be filed, the switch is the user's, and the user's
 * corrections of Zirma are kept as examples. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CORE_MIGRATIONS, listEvents, openWorld, withCoreContext, type World } from "@zirma/core";
import { invokeOp, runTools } from "@zirma/module-kit";
import {
  AUTO_FILE_PER_DAY, autoFileState, importLinks, linksModule, listClips, listFixes, listPlaces, listTopics, MAX_FIXES, pinPlace, recordPage,
  saveClip, setAutoFile, updateClip, updatePlace, waitingCount, waitingToFile, type LinksSnapshot,
} from "../src/index.ts";

const world = (): World => openWorld(":memory:", [...CORE_MIGRATIONS, ...linksModule.migrations]);
const ok = <T extends object>(result: T | { error: string }): T => { assert.ok(!("error" in result), JSON.stringify(result)); return result as T; };
const signal = new AbortController().signal;
const op = (w: World, name: string, input: unknown, requestId = `${name}-${Math.random()}`) => invokeOp(w, [linksModule], { op: name, requestId, input }).result;
const waiting = (w: World) => waitingToFile(w).map((item) => item.id);
/** Zirma in a chat: its tools, acting as itself. */
const zirma = (w: World) => {
  const tools = runTools(w, [linksModule]);
  return (name: string, params: Record<string, unknown>) => withCoreContext({ actor: "alfred" }, () => String(tools.find((tool) => tool.name === name)!.execute(params, signal)));
};

test("links already filed when the update comes are the user's, and nothing waits", () => {
  const dir = mkdtempSync(join(tmpdir(), "zirma-links-"));
  try {
    const path = join(dir, "world.db");
    const before = linksModule.migrations.filter((migration) => !["link:9", "link:10"].includes(migration.id));
    let w = openWorld(path, [...CORE_MIGRATIONS, ...before]);
    w.db.exec("INSERT INTO link_topics (id, name, area, created_at) VALUES ('t1', 'Reading', 'learn', '2026-11-01T00:00:00Z')");
    w.db.exec(`INSERT INTO link_items (id, kind, url, title, topic_id, saved_at) VALUES
      ('filed', 'clip', 'https://example.com/a', 'A', 't1', '2026-11-01T00:00:00Z'),
      ('loose', 'clip', 'https://example.com/b', 'B', NULL, '2026-11-01T00:00:00Z')`);
    w.close();
    w = openWorld(path, [...CORE_MIGRATIONS, ...linksModule.migrations]);
    const rows = w.db.prepare("SELECT id, filed_by, file_queue FROM link_items WHERE kind = 'clip' ORDER BY id").all();
    assert.deepEqual(rows.map((row) => [row.id, row.filed_by, row.file_queue]), [["filed", "user", 0], ["loose", null, 0]]);
    assert.deepEqual(listTopics(w).map((topic) => topic.byZirma), [undefined], "a category from before is the user's");
    assert.deepEqual(autoFileState(w), { enabled: false, today: 0, perDay: AUTO_FILE_PER_DAY });
    w.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("filing on its own is off until the user turns it on from the page, and turning it on does not reach back", () => {
  const w = world();
  const early = ok(saveClip(w, { url: "https://example.com/early" })).clip;
  recordPage(w, early.id, { title: "Early" });
  assert.equal((linksModule.snapshot!(w) as LinksSnapshot).autoFile?.enabled, false);
  assert.deepEqual(waiting(w), [], "off: nothing waits");

  assert.deepEqual((({ enabled, today, perDay }) => ({ enabled, today, perDay }))(op(w, "link.autofile", { enabled: true }) as { enabled: boolean; today: number; perDay: number }),
    { enabled: true, today: 0, perDay: AUTO_FILE_PER_DAY });
  assert.equal((linksModule.snapshot!(w) as LinksSnapshot).autoFile?.enabled, true);
  assert.deepEqual(waiting(w), [], "what was saved before it was on stays where it is");

  const late = ok(saveClip(w, { url: "https://example.com/late" })).clip;
  assert.deepEqual(waiting(w), [], "a saved thing waits for its page first, to have a title to go by");
  assert.equal(waitingCount(w), 1);
  recordPage(w, late.id, { title: "Late", description: "about something" });
  assert.deepEqual(waiting(w), [late.id]);
  const site = ok(pinPlace(w, { url: "https://news.example.org", title: "News" })).place;
  assert.deepEqual(waiting(w), [late.id, site.id], "a site waits too, with nothing to look up");

  // Off again: nothing waits any more, and on again does not bring those back.
  op(w, "link.autofile", { enabled: false });
  assert.deepEqual(waiting(w), []);
  setAutoFile(w, true);
  assert.deepEqual(waiting(w), []);
  assert.deepEqual(listEvents(w).events.filter((event) => event.kind === "link.autofile_set").map((event) => [event.payload.enabled, event.actor]),
    [[true, "user"], [false, "user"], [true, null]]);
  assert.equal(setAutoFile(w, true).enabled, true, "asking for what is already so changes nothing");
  assert.equal(listEvents(w).events.filter((event) => event.kind === "link.autofile_set").length, 3);
});

test("only links nobody decided about wait: one the user filed, or put back in Unfiled, is left alone", () => {
  const w = world();
  setAutoFile(w, true);
  const filed = ok(saveClip(w, { url: "https://example.com/filed", topic: "Reading", area: "learn" })).clip;
  const loose = ok(saveClip(w, { url: "https://example.com/loose" })).clip;
  const back = ok(saveClip(w, { url: "https://example.com/back" })).clip;
  for (const clip of [filed, loose, back]) recordPage(w, clip.id, { title: clip.url });
  assert.deepEqual(waiting(w), [loose.id, back.id]);

  // The user files one and takes it out again: they want it in Unfiled.
  const reading = listTopics(w)[0];
  op(w, "link.update", { id: back.id, patch: { topicId: reading.id } });
  op(w, "link.update", { id: back.id, patch: { topicId: "" } });
  assert.deepEqual(waiting(w), [loose.id]);
  assert.equal(listClips(w).find((clip) => clip.id === back.id)?.topicId, undefined);

  // The same address saved again with a category: filed by whoever saved it, and no longer waiting.
  saveClip(w, { url: "https://example.com/loose", topicId: reading.id });
  assert.deepEqual(waiting(w), []);
  assert.equal(listClips(w).find((clip) => clip.id === loose.id)?.filedByZirma, undefined);
});

test("what Zirma files is marked until the user moves it; the move is kept as an example", () => {
  const w = world();
  const call = zirma(w);
  assert.match(call("link_save", { url: "https://example.com/rust-book", topic: "Learning", area: "learn" }), /^Saved: .* topic: Learning/);
  const [learning] = listTopics(w);
  assert.equal(learning.byZirma, true, "a category Zirma made is marked");
  const clip = listClips(w)[0];
  assert.equal(clip.filedByZirma, true);
  assert.equal((linksModule.snapshot!(w) as LinksSnapshot).clips[0].filedByZirma, true);

  // The user files something of their own into Zirma's category: it is theirs now too.
  const own = ok(saveClip(w, { url: "https://example.com/own" })).clip;
  op(w, "link.update", { id: own.id, patch: { topicId: learning.id } });
  assert.equal(listTopics(w)[0].byZirma, undefined);

  // The user moves what Zirma filed: no longer marked, and kept as an example, from where to where.
  const tools = ok(saveClip(w, { url: "https://example.com/x", topic: "Tools", area: "work" })).clip;
  op(w, "link.update", { id: clip.id, patch: { topicId: tools.topicId } });
  assert.equal(listClips(w).find((item) => item.id === clip.id)?.filedByZirma, undefined);
  assert.deepEqual(listFixes(w).map(({ at: _at, ...fix }) => fix), [{ title: clip.title, site: "example.com", from: "Learning", to: "Tools" }]);

  // Zirma changing its own mind is not a correction; a site is kept the same way as a saved thing.
  const site = ok(pinPlace(w, { url: "https://docs.example.org", title: "Docs" })).place;
  call("link_update", { id: site.id, topic: "Learning" });
  assert.equal(listPlaces(w).find((place) => place.id === site.id)?.filedByZirma, true);
  call("link_update", { id: site.id, topic: "Tools" });
  assert.equal(listFixes(w).length, 1);
  updatePlace(w, site.id, { topicId: "" });
  assert.deepEqual(listFixes(w)[0], { title: "Docs", site: "docs.example.org", from: "Tools", at: listFixes(w)[0].at });
  assert.equal(listPlaces(w).find((place) => place.id === site.id)?.filedByZirma, undefined);
});

test("a category the user renames is theirs; corrections are kept up to a limit, newest first", () => {
  const w = world();
  const call = zirma(w);
  call("link_save", { url: "https://example.com/1", topic: "Misc", area: "life" });
  const [misc] = listTopics(w);
  op(w, "link.topic", { id: misc.id, name: "Odds and ends" });
  assert.equal(listTopics(w)[0].byZirma, undefined);

  for (let i = 0; i < MAX_FIXES + 5; i++) {
    const clip = ok(saveClip(w, { url: `https://example.com/n${i}`, topicId: misc.id }, "zirma")).clip;
    updateClip(w, clip.id, { topicId: "" });
  }
  const fixes = listFixes(w);
  assert.equal(fixes.length, MAX_FIXES);
  assert.equal(fixes[0].title, "example.com · n34");
});

test("bookmarks come in as the user filed them; what came in without a folder does not wait", () => {
  const w = world();
  setAutoFile(w, true);
  ok(importLinks(w, { importId: "imp1", entries: [
    { url: "https://example.com/in-folder", title: "In a folder", kind: "clip", path: ["Reading"] },
    { url: "https://example.com/no-folder", title: "No folder", kind: "clip" },
    { url: "https://tools.example.com", title: "Tools", kind: "place" },
  ] }));
  assert.deepEqual(waiting(w), [], "an import is the user's old links: only the button reaches them");
  assert.equal(waitingCount(w), 0);
  const filed = listClips(w).find((clip) => clip.title === "In a folder");
  assert.ok(filed?.topicId);
  assert.equal(filed?.filedByZirma, undefined);
  assert.equal(w.db.prepare("SELECT filed_by FROM link_items WHERE id = ?").get(filed!.id)?.filed_by, "user");
});

test("today's count starts again each day", () => {
  const w = world();
  w.db.exec("UPDATE link_autofile SET day = '2000-01-01', count = 12");
  assert.equal(autoFileState(w).today, 0);
  const today = new Date();
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  w.db.prepare("UPDATE link_autofile SET day = ?, count = 12").run(day);
  assert.equal(autoFileState(w, today).today, 12);
});
