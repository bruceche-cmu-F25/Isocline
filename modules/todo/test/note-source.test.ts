/** To-dos from notes (docs/research/notes-editor.md 3.5, test 8): put on the list one at a time by the user, never
 * twice, and following their page when it moves. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_MIGRATIONS, openWorld, withCoreContext, type World } from "@zirma/core";
import { addFromNote, deleteTodo, listTodos, moveNoteSources, noteTodos, setNoteTodoDone, todoModule } from "../src/index.ts";

const world = (): World => openWorld(":memory:", [...CORE_MIGRATIONS, ...todoModule.migrations]);
const ref = (page: string, key = "0123456789abcdef", nth = 0) => `note:lib1:${page}#${key}:${nth}`;

test("a to-do from a note is on the list once, however often it is put there", () => {
  const w = world();
  withCoreContext({ actor: "user" }, () => {
    const first = addFromNote(w, { title: "周五前发许可证对比", source: { kind: "note", ref: ref("周会"), label: "周会" } });
    const again = addFromNote(w, { title: "周五前发许可证对比", source: { kind: "note", ref: ref("周会"), label: "周会" } });
    assert.equal(first.existing, false);
    assert.equal(again.existing, true);
    assert.equal(again.todo.id, first.todo.id);
    assert.deepEqual(first.todo.source, { kind: "note", ref: ref("周会"), label: "周会" });
    // The second "联系客户" on the same page is another to-do.
    const second = addFromNote(w, { title: "周五前发许可证对比", source: { kind: "note", ref: ref("周会", "0123456789abcdef", 1), label: "周会" } });
    assert.notEqual(second.todo.id, first.todo.id);
    assert.equal(listTodos(w).length, 2);
    // Removed from the list, it comes back when the user asks again.
    deleteTodo(w, { id: first.todo.id });
    const back = addFromNote(w, { title: "周五前发许可证对比", source: { kind: "note", ref: ref("周会"), label: "周会" } });
    assert.equal(back.existing, false);
    assert.equal(listTodos(w).length, 2);
    assert.throws(() => addFromNote(w, { title: "x", source: { kind: "note", ref: "calendar:a:b", label: "x" } }), /note/);
  });
});

test("when a note moves, its to-dos and those of the pages under it follow", () => {
  const w = world();
  withCoreContext({ actor: "user" }, () => {
    const own = addFromNote(w, { title: "a", source: { kind: "note", ref: ref("旧名"), label: "旧名" } }).todo;
    const under = addFromNote(w, { title: "b", source: { kind: "note", ref: ref("旧名/子页"), label: "子页" } }).todo;
    const other = addFromNote(w, { title: "c", source: { kind: "note", ref: ref("旧名字"), label: "旧名字" } }).todo;
    assert.equal(moveNoteSources(w, "旧名", "文件夹/新名"), 2);
    const byId = new Map(listTodos(w).map((todo) => [todo.id, todo]));
    assert.deepEqual(byId.get(own.id)!.source, { kind: "note", ref: ref("文件夹/新名"), label: "新名" });
    assert.deepEqual(byId.get(under.id)!.source, { kind: "note", ref: ref("文件夹/新名/子页"), label: "子页" });
    assert.equal(byId.get(other.id)!.source!.ref, ref("旧名字"), "a page whose name only starts the same stays");
    // Asking again under the new path finds the same todo.
    assert.equal(addFromNote(w, { title: "a", source: { kind: "note", ref: ref("文件夹/新名"), label: "新名" } }).todo.id, own.id);
  });
});

test("ticked or unticked in its note, a to-do on the list finishes or reopens; others are left alone", () => {
  const w = world();
  withCoreContext({ actor: "user" }, () => {
    const todo = addFromNote(w, { title: "a", source: { kind: "note", ref: ref("周会"), label: "周会" } }).todo;
    assert.equal(setNoteTodoDone(w, ref("周会"), true), true);
    assert.equal(listTodos(w, { includeDone: true }).find((one) => one.id === todo.id)!.done, true);
    assert.equal(setNoteTodoDone(w, ref("周会"), true), false, "already done");
    assert.equal(setNoteTodoDone(w, ref("周会"), false), true);
    assert.equal(listTodos(w).find((one) => one.id === todo.id)!.done, false);
    assert.equal(setNoteTodoDone(w, ref("别的页"), true), false, "a to-do never put on the list: nothing");
    assert.deepEqual(noteTodos(w).map((one) => [one.ref, one.done]), [[ref("周会"), false]]);
  });
});
