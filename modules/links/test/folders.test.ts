import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CORE_MIGRATIONS, openWorld, type World } from "@isocline/core";
import { invokeOp } from "@isocline/module-kit";
import { groupPlaces, linksModule, listFolders, listPlaces, MIGRATIONS, movePlace, orderPlaces, pinPlace, removeLink, type LinksSnapshot } from "../src/index.ts";

function ok<T extends object>(value: T | { error: string }): T {
  assert.ok(!("error" in value), JSON.stringify(value));
  return value;
}

function rootOrder(world: World): string[] {
  return [...listPlaces(world).filter((site) => !site.folderId), ...listFolders(world)]
    .sort((a, b) => a.position! - b.position!).map((tile) => tile.id);
}

test("deleting a folder releases its sites in order at the original folder position", (t) => {
  const world = openWorld(":memory:", [...CORE_MIGRATIONS, ...linksModule.migrations]);
  t.after(() => world.close());
  const last = ok(pinPlace(world, { url: "https://example.org", title: "Site" })).place.id;
  const addresses = listPlaces(world).map(({ id, url }) => [id, url]).sort();
  const { folder } = ok(groupPlaces(world, { id: "place-3", targetId: "place-2", title: "Daily" }));
  ok(movePlace(world, { id: "place-3", folderId: folder.id, beforeId: "place-2" }));
  const request = { op: "link.ungroup", requestId: "dissolve", input: { id: folder.id } };
  assert.deepEqual(invokeOp(world, [linksModule], request).result, { id: folder.id });
  assert.deepEqual(invokeOp(world, [linksModule], request).result, { id: folder.id });
  assert.deepEqual(rootOrder(world), ["place-1", "place-3", "place-2", last]);
  assert.deepEqual(listPlaces(world).map(({ id, url }) => [id, url]).sort(), addresses);
  assert.equal(listFolders(world).length, 0);
});

test("existing bookmarks survive the upgrade; moving the last member back to Places survives a restart", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "alfred-link-folders-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "world.db");
  const old = openWorld(path, [...CORE_MIGRATIONS, ...MIGRATIONS.slice(0, 2)]);
  old.db.prepare("UPDATE link_items SET position = 5, title = 'Mail' WHERE id = 'place-2'").run();
  old.close();
  const migrations = [...CORE_MIGRATIONS, ...linksModule.migrations];
  const world = openWorld(path, migrations);
  assert.deepEqual(rootOrder(world), ["place-1", "place-3", "place-2"]);
  const input = { id: "place-1", targetId: "place-2", title: "Work" };
  const grouped = invokeOp(world, [linksModule], { op: "link.group", requestId: "group-1", input });
  const { folder } = ok(groupPlaces(world, input));
  assert.deepEqual(grouped.result, { folder });
  assert.deepEqual(rootOrder(world), ["place-3", folder.id]);
  assert.deepEqual(listPlaces(world).filter((p) => p.folderId === folder.id).map((p) => p.title), ["Mail", "Google"]);
  invokeOp(world, [linksModule], { op: "link.rename", requestId: "name", input: { id: folder.id, title: "School" } });
  const move = { id: "place-2", beforeId: "place-3" };
  invokeOp(world, [linksModule], { op: "link.move", requestId: "move", input: move });
  ok(movePlace(world, move));
  assert.deepEqual(rootOrder(world), ["place-2", "place-3", folder.id]);
  assert.equal(listFolders(world)[0].title, "School");
  world.close();
  const resumed = openWorld(path, migrations);
  t.after(() => resumed.close());
  assert.equal(listPlaces(resumed).find((p) => p.id === "place-1")?.folderId, folder.id);
  ok(movePlace(resumed, { id: "place-1" }));
  const snapshot = linksModule.snapshot!(resumed) as LinksSnapshot;
  assert.deepEqual(snapshot.folders, []);
  assert.deepEqual(rootOrder(resumed), ["place-2", "place-3", "place-1"]);
  assert.equal(snapshot.places.find((p) => p.id === "place-1")?.url, "https://www.google.com");
});

test("moves reorder siblings and reject stale or nested destinations without losing sites", (t) => {
  const world = openWorld(":memory:", [...CORE_MIGRATIONS, ...linksModule.migrations]);
  t.after(() => world.close());
  const { folder } = ok(groupPlaces(world, { id: "place-2", targetId: "place-1", title: "Apps" }));
  const canvas = ok(pinPlace(world, { url: "canvas.example.com" })).place;
  ok(movePlace(world, { id: folder.id }));
  assert.deepEqual(rootOrder(world), ["place-3", canvas.id, folder.id]);
  movePlace(world, { id: "place-3", folderId: folder.id, beforeId: "place-2" });
  assert.deepEqual(listPlaces(world).filter((p) => p.folderId).map((p) => p.id), ["place-1", "place-3", "place-2"]);
  const before = linksModule.snapshot!(world);
  for (const input of [
    { id: folder.id, folderId: folder.id }, { id: "place-3", folderId: "absent" },
    { id: canvas.id, folderId: folder.id, beforeId: canvas.id }, { id: "place-3", beforeId: "place-1" },
  ]) assert.ok("error" in movePlace(world, input));
  assert.ok("error" in groupPlaces(world, { id: canvas.id, targetId: "place-2", title: "Stale" }));
  assert.deepEqual(linksModule.snapshot!(world), before);
  ok(movePlace(world, { id: "place-2", beforeId: folder.id }));
  orderPlaces(world, ["place-2", "place-1", canvas.id]);
  assert.deepEqual(rootOrder(world), ["place-2", canvas.id, folder.id]);
  ok(removeLink(world, "place-3"));
  assert.equal(listFolders(world).length, 1);
  ok(removeLink(world, "place-1"));
  assert.deepEqual(listFolders(world), []);
});
