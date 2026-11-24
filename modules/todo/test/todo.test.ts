import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptProposal, CORE_MIGRATIONS, listEvents, listOpenProposals, openWorld, updateSettings, withCoreContext, type World } from "@isocline/core";
import { applyStep, assistantTools, invokeOp, moduleMigrations, OpInputError, runTools } from "@isocline/module-kit";
import {
  addTodo, completeTodo, formatTodo, listTodos, TodoConflictError, todoModule,
  todoRevision, updateTodo, type Todo, type TodoSnapshot,
} from "../src/index.ts";

function world(): World {
  return openWorld(":memory:", [...CORE_MIGRATIONS, ...moduleMigrations([todoModule])]);
}

test("every change writes its event in the same transaction", () => {
  const w = world();
  const { todo } = addTodo(w, { title: "  Hand in report ", due: "2026-11-20" });
  assert.equal(todo.title, "Hand in report");
  updateTodo(w, { id: todo.id }, { due: "2026-11-21" });
  completeTodo(w, { title: "report" });
  const kinds = listEvents(w).events.map((event) => event.kind);
  assert.deepEqual(kinds, ["todo.added", "todo.updated", "todo.completed"]);
  const updated = listEvents(w).events[1];
  assert.deepEqual((updated.payload.changes as Record<string, unknown>).due, ["2026-11-20", "2026-11-21"]);
  assert.equal(listTodos(w).length, 0);
  assert.equal(listTodos(w, { includeDone: true })[0].done, true);
});

test("invalid input changes nothing and records nothing", () => {
  const w = world();
  assert.throws(() => addTodo(w, { title: "x", due: "2026-02-30" }), /not a real date/);
  assert.throws(() => addTodo(w, { title: "x", startDate: "2026-11-20" }), /due is required/);
  assert.throws(() => addTodo(w, { title: "x", url: "javascript:alert(1)" }), /link/);
  assert.equal(listTodos(w, { includeDone: true }).length, 0);
  assert.equal(listEvents(w).events.length, 0);
});

test("an edit made on a stale copy is refused", () => {
  const w = world();
  const { todo } = addTodo(w, { title: "Call the bank" });
  const stale = todoRevision(todo);
  updateTodo(w, { id: todo.id }, { title: "Call the bank about the card" });
  assert.throws(() => updateTodo(w, { id: todo.id, revision: stale }, { title: "x" }), TodoConflictError);
});

test("a title that matches several todos asks for an id", () => {
  const w = world();
  addTodo(w, { title: "Email Alice" });
  addTodo(w, { title: "Email Bob" });
  const result = completeTodo(w, { title: "email" });
  assert.ok("error" in result && /matches 2 todos/.test(result.error));
});

test("device commands replay by request id and validate their input", () => {
  const w = world();
  const first = invokeOp(w, [todoModule], { op: "todo.add", requestId: "c1", input: { title: "Buy milk" } });
  const again = invokeOp(w, [todoModule], { op: "todo.add", requestId: "c1", input: { title: "Buy milk" } });
  assert.equal(again.replayed, true);
  assert.deepEqual(again.result, first.result);
  assert.equal(listTodos(w).length, 1);
  assert.equal(listEvents(w).events[0].actor, "user");
  assert.throws(() => invokeOp(w, [todoModule], { op: "todo.add", requestId: "c2", input: { title: 3 } }), OpInputError);
});

test("runs use reversible tools directly; deleting asks the user, naming the todo", () => {
  const w = world();
  const { todo } = addTodo(w, { title: "Old receipt" });
  const tools = runTools(w, [todoModule]);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["todo_add", "todo_complete", "todo_delete", "todo_list", "todo_suggest", "todo_update"]);
  assert.deepEqual(tools.filter((tool) => tool.permission).map((tool) => tool.name), ["todo_delete"]);
  const remove = tools.find((tool) => tool.name === "todo_delete")!;
  assert.equal(remove.permission!({ id: todo.id }), "Delete the todo “Old receipt” for good? This can't be undone.");
  updateSettings(w, { locale: "zh" });
  assert.equal(remove.permission!({ id: todo.id }), "永久删除待办「Old receipt」？删除后不能恢复。", "in the user's language once it is set");
  assert.equal(remove.describe!({ id: todo.id }), "Old receipt");
});

test("a todo can belong to an area; unknown areas are refused and an empty one clears it", () => {
  const w = world();
  const { todo } = addTodo(w, { title: "Renew passport", area: "travel" });
  assert.equal(todo.area, "travel");
  assert.match(formatTodo(todo, "2026-11-18"), /\[area: travel\]/);
  assert.throws(() => addTodo(w, { title: "x", area: "space" }), /area must be one of/);
  assert.throws(() => updateTodo(w, { id: todo.id }, { area: "space" }), /area must be one of/);
  updateTodo(w, { id: todo.id }, { area: "" });
  assert.equal(listTodos(w)[0].area, undefined);
  const changes = listEvents(w).events.at(-1)!.payload.changes as Record<string, unknown>;
  assert.deepEqual(changes.area, ["travel", null]);
});

test("the snapshot says when Isocline made the latest change to a todo, from the event log", () => {
  const w = world();
  const mine = addTodo(w, { title: "Mine" }).todo;
  const its = withCoreContext({ actor: "alfred" }, () => addTodo(w, { title: "Isocline's" }).todo);
  const snapshot = () => todoModule.snapshot!(w) as TodoSnapshot;
  const by = (id: string) => snapshot().todos.find((todo) => todo.id === id)!.changedBy;
  assert.equal(by(mine.id), undefined);
  assert.equal(by(its.id)?.kind, "todo.added");
  withCoreContext({ actor: "alfred" }, () => updateTodo(w, { id: mine.id }, { area: "work" }));
  assert.equal(by(mine.id)?.kind, "todo.updated");
  // The user's own later change is the latest: no longer shown as Isocline's.
  withCoreContext({ actor: "user" }, () => updateTodo(w, { id: mine.id }, { title: "Mine, renamed" }));
  assert.equal(by(mine.id), undefined);
});


test("a run proposes todo changes; accepting runs them pinned to the todos it saw", () => {
  const w = world();
  updateSettings(w, { locale: "zh" });
  const { todo } = addTodo(w, { title: "Hand in report", due: "2026-11-01" });
  addTodo(w, { title: "Old idea" });
  const propose = assistantTools(w, [todoModule]).find((tool) => tool.name === "propose")!;
  const said = withCoreContext({ actor: "alfred" }, () => propose.execute({
    title: "清掉两条？", summary: "都过了很久了。",
    calls: [{ tool: "todo_delete", params: { title: "report" } }, { tool: "todo_complete", params: { title: "Old idea" } }],
  }, new AbortController().signal)) as string;
  assert.match(said, /Proposed "清掉两条？" \(2 steps\)/);
  const [proposal] = listOpenProposals(w);
  assert.deepEqual(proposal.steps.map((step) => step.op), ["todo.delete", "todo.complete"]);
  assert.deepEqual(proposal.steps.map((step) => step.preview), ["永久删除待办「Hand in report」", "完成待办「Old idea」"], "previews name the todos found, not the search text");
  assert.equal((proposal.steps[0].input as { id: string }).id, todo.id, "the title was resolved to an id when proposed");
  assert.deepEqual(proposal.subjects.length, 2);
  assert.equal(listTodos(w).length, 2, "proposing changes nothing");

  const done = acceptProposal(w, proposal.id, (step) => applyStep(w, [todoModule], step));
  assert.equal(done.state, "executed");
  assert.deepEqual(listTodos(w, { includeDone: true }).map((item) => [item.title, item.done]), [["Old idea", true]]);
});

test("editing a todo after Isocline proposed a change to it makes the proposal stale", () => {
  const w = world();
  const { todo } = addTodo(w, { title: "Call the bank" });
  const propose = assistantTools(w, [todoModule]).find((tool) => tool.name === "propose")!;
  propose.execute({ title: "删掉？", summary: "", calls: [{ tool: "todo_delete", params: { id: todo.id } }] }, new AbortController().signal);
  updateTodo(w, { id: todo.id }, { title: "Call the bank about the card" });
  const [proposal] = listOpenProposals(w);
  assert.equal(proposal.stale, true);
  assert.equal(acceptProposal(w, proposal.id, (step) => applyStep(w, [todoModule], step)).state, "stale");
  assert.equal(listTodos(w).length, 1);
  assert.equal(proposal.steps[0].preview, "Delete the todo “Call the bank” for good", "in English until the user's language is set");
  // A bad call is refused before anything is proposed.
  const refused = propose.execute({ title: "x", summary: "", calls: [{ tool: "todo_delete", params: { title: "nothing like this" } }] }, new AbortController().signal);
  assert.match(String(refused), /No todo matching/);
});

test("a run adding what the list already has is told so, unless it says the user wants a second one", async () => {
  const w = world();
  addTodo(w, { title: "交房租", due: "2026-11-30" });
  addTodo(w, { title: "买牛奶" });
  const add = runTools(w, [todoModule]).find((tool) => tool.name === "todo_add")!;
  const run = (params: Record<string, unknown>) => Promise.resolve(add.execute(params, new AbortController().signal));
  assert.match(await run({ title: "交房租。", due: "2026-11-30" }), /^Not added: the list already has .*交房租/);
  assert.match(await run({ title: "月底交房租", due: "2026-11-30" }), /^Not added/);
  // Naming another task, or another day, is a new todo.
  assert.match(await run({ title: "买牛奶和鸡蛋" }), /^Added/);
  assert.match(await run({ title: "交房租押金", due: "2026-12-15" }), /^Added/);
  assert.match(await run({ title: "交房租", due: "2026-11-30", again: true }), /^Added/);
  assert.equal(listTodos(w).filter((todo) => todo.title === "交房租").length, 2);
});
