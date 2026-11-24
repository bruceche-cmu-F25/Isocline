import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addArea, AreaError, CORE_MIGRATIONS, isArea, listAreas, listEvents, moveArea, openWorld, updateArea, updateSettings, type World,
} from "@zirma/core";
import { assistantTools, moduleGuidance, moduleMigrations, removeArea } from "@zirma/module-kit";
import { linksModule, ensureTopic, listTopics } from "@zirma/module-links";
import { addTodo, listTodos, todoModule } from "../src/index.ts";

const MODULES = [todoModule, linksModule];
const world = (): World => openWorld(":memory:", [...CORE_MIGRATIONS, ...moduleMigrations(MODULES)]);

test("a new world has the seven sample areas, named in the user's language until renamed", () => {
  const w = world();
  assert.deepEqual(listAreas(w, "en").map((area) => area.name), ["Work", "Life", "Learning", "Travel", "Health", "Money", "People"]);
  assert.equal(listAreas(w, "zh")[0].name, "工作");
  assert.ok(listAreas(w).every((area) => area.sample));
  const renamed = updateArea(w, "work", { name: "Job" });
  assert.deepEqual([renamed.name, renamed.sample], ["Job", false]);
  updateSettings(w, { locale: "zh" });
  assert.equal(listAreas(w)[0].name, "Job", "the user's own name does not follow the language");
});

test("the user makes, renames, recolours and orders areas; names stay distinct", () => {
  const w = world();
  const kids = addArea(w, { name: "  Kids " });
  assert.deepEqual([kids.name, kids.sample, isArea(w, kids.id)], ["Kids", false, true]);
  assert.notEqual(kids.k, "gray", "a new area gets a colour, not gray");
  assert.throws(() => addArea(w, { name: "kids" }), AreaError);
  assert.throws(() => addArea(w, { name: "学习" }), /already an area/, "a sample's name in either language is taken");
  assert.throws(() => addArea(w, { name: "" }), AreaError);
  assert.throws(() => updateArea(w, kids.id, { k: "purple" }), /colour must be one of/);
  assert.equal(updateArea(w, kids.id, { k: "gray" }).k, "gray");
  assert.deepEqual(moveArea(w, kids.id, 0).map((area) => area.id).slice(0, 2), [kids.id, "work"]);
  assert.deepEqual(listEvents(w).events.filter((event) => event.kind.startsWith("area.")).map((event) => event.kind), ["area.created", "area.updated", "area.moved"]);
});

test("todos and topics take only the user's areas", () => {
  const w = world();
  const kids = addArea(w, { name: "Kids" });
  assert.equal(addTodo(w, { title: "School forms", area: kids.id }).todo.area, kids.id);
  assert.throws(() => addTodo(w, { title: "x", area: "space" }), /area must be one of: work, life, .*, [\w-]+$/);
  assert.match((ensureTopic(w, { name: "Rust", area: "space" }) as { error: string }).error, /area must be one of/);
});

test("removing an area moves what was in it, in every module, to another area or to none", () => {
  const w = world();
  const kids = addArea(w, { name: "Kids" });
  addTodo(w, { title: "School forms", area: kids.id });
  addTodo(w, { title: "Renew passport", area: "travel" });
  const topic = ensureTopic(w, { name: "Parenting", area: kids.id }) as { id: string };

  assert.throws(() => removeArea(w, MODULES, kids.id, kids.id), AreaError);
  assert.equal(listTodos(w).find((todo) => todo.title === "School forms")!.area, kids.id, "a refused removal changes nothing");
  removeArea(w, MODULES, kids.id, "life");
  assert.equal(listTodos(w).find((todo) => todo.title === "School forms")!.area, "life");
  assert.equal(listTopics(w).find((each) => each.id === topic.id)!.area, "life");

  removeArea(w, MODULES, "travel");
  assert.equal(listTodos(w).find((todo) => todo.title === "Renew passport")!.area, undefined);
  assert.ok(!listAreas(w).some((area) => area.id === "travel" || area.id === kids.id));
  assert.equal(listEvents(w).events.filter((event) => event.kind === "area.removed").length, 2);
});

test("a run is told the user's areas as they are now, and can make one", async () => {
  const w = world();
  assert.match(moduleGuidance(w, MODULES), /work \(Work\)/);
  const add = assistantTools(w, MODULES).find((tool) => tool.name === "area_add")!;
  assert.match(String(await add.execute({ name: "Garden" }, new AbortController().signal)), /Made the area "Garden"/);
  assert.match(moduleGuidance(w, MODULES), /\(Garden\)/);
});
