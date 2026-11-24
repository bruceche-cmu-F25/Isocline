import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addPreference, CORE_MIGRATIONS, describePreferences, listEvents, listPreferences, openWorld, removePreference, updatePreference, updateSettings,
} from "../src/index.ts";

const world = () => openWorld(":memory:", CORE_MIGRATIONS);

test("preferences are the user's words: added by them or by Zirma, changed by hand, removed, each change an event", () => {
  const w = world();
  assert.equal(describePreferences(w), "", "nothing to say yet");
  const short = addPreference(w, { text: "  Keep answers   short  ", by: "alfred" });
  assert.equal(short.text, "Keep answers short");
  assert.equal(short.by, "alfred");
  assert.equal(addPreference(w, { text: "keep answers short" }).id, short.id, "said twice is one");
  const week = addPreference(w, { text: "我的一周从周一开始" });
  assert.deepEqual(listPreferences(w).map((p) => p.text), ["Keep answers short", "我的一周从周一开始"]);
  const edited = updatePreference(w, short.id, "Keep answers very short");
  assert.equal(edited.by, "user", "changed by hand, it is the user's");
  removePreference(w, week.id);
  assert.deepEqual(listPreferences(w).map((p) => p.text), ["Keep answers very short"]);
  assert.deepEqual(listEvents(w).events.filter((e) => e.kind.startsWith("preference.")).map((e) => e.kind),
    ["preference.added", "preference.added", "preference.updated", "preference.removed"]);
  assert.throws(() => addPreference(w, { text: "" }), /1 to/);
  assert.throws(() => updatePreference(w, "nope", "x"), /No such/);
});

test("Zirma is told the name the user goes by and every preference, with ids to forget one by", () => {
  const w = world();
  updateSettings(w, { preferredName: "Sam" });
  const kept = addPreference(w, { text: "No meetings before 10" });
  const said = describePreferences(w);
  assert.match(said, /called "Sam"/);
  assert.ok(said.includes(`- [${kept.id}] No meetings before 10`));
});

test("the sidebar layout is page keys, checked, kept once each", () => {
  const w = world();
  const saved = updateSettings(w, { pages: { order: ["mail.inbox", "todo.list", "mail.inbox"], hidden: ["link.list"] } });
  assert.deepEqual(saved.pages, { order: ["mail.inbox", "todo.list"], hidden: ["link.list"] });
  assert.throws(() => updateSettings(w, { pages: { order: ["not a key"], hidden: [] } }));
  assert.equal(updateSettings(w, { pages: null }).pages, null);
});
