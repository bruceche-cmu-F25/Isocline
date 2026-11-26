import { areaName, describeAreas, lastChangesOf, localDate, userLocale, type World, defineModule, defineOp, defineTool, Type } from "@zirma/module-kit";
import {
  acceptTodo, addFromNote, addTodo, sameTodo, todosForProposedEvents, completeTodo, deleteTodo, formatTodo, getTodoSettings, listTodos, MIGRATIONS, moveTodosOutOfArea, resolveTodo, setTodoSettings, suggestTodo, todoRevision,
  updateTodo, type Todo,
} from "./domain.ts";
import type { TodoSnapshot } from "./types.ts";

export * from "./domain.ts";
export type { TodoSnapshot } from "./types.ts";
export { isDayOff, offMatcher, SAMPLE_OFF_WORDS } from "./types.ts";

const Ref = {
  id: Type.Optional(Type.String({ description: "Todo id from todo_list" })),
  title: Type.Optional(Type.String({ description: "A distinctive part of the todo's current title, if the id is unknown" })),
};
const DateField = (description: string) => Type.Optional(Type.String({ description }));
const AtField = (description: string) => Type.Optional(Type.String({ description }));
const Status = Type.Union([Type.Literal("todo"), Type.Literal("doing"), Type.Literal("done")]);

/** What the user reads about a todo change (a proposal's step, a permission question), in their language. */
const SAY = {
  zh: {
    add: (title: string, due?: string) => `添加待办「${title}」${due ? `，截止 ${due}` : ""}`,
    rename: (title: string) => `改名为「${title}」`,
    due: (date: string) => (date ? `截止日改为 ${date}` : "去掉截止日"),
    at: (at: string) => (at ? `截止时间改为 ${at}` : "去掉截止时间"),
    start: (date: string) => (date ? `开始日改为 ${date}` : "去掉开始日"),
    area: (name: string) => (name ? `领域改为${name}` : "去掉领域"),
    status: (status: string) => (status === "doing" ? "标成进行中" : "标回未开始"),
    link: (url: string) => (url ? "换链接" : "去掉链接"),
    update: (title: string, said: string[]) => `把「${title}」${said.join("、")}`,
    complete: (title: string) => `完成待办「${title}」`,
    remove: (title: string) => `永久删除待办「${title}」`,
    confirmRemove: (title: string) => `永久删除待办「${title}」？删除后不能恢复。`,
  },
  en: {
    add: (title: string, due?: string) => `Add the todo “${title}”${due ? `, due ${due}` : ""}`,
    rename: (title: string) => `rename it “${title}”`,
    due: (date: string) => (date ? `move its due date to ${date}` : "remove its due date"),
    at: (at: string) => (at ? `make it due by ${at}` : "remove its hour"),
    start: (date: string) => (date ? `move its start to ${date}` : "remove its start date"),
    area: (name: string) => (name ? `put it under ${name}` : "take it out of its area"),
    status: (status: string) => (status === "doing" ? "mark it in progress" : "mark it not started"),
    link: (url: string) => (url ? "change its link" : "remove its link"),
    update: (title: string, said: string[]) => `For “${title}”: ${said.join(", ")}`,
    complete: (title: string) => `Complete the todo “${title}”`,
    remove: (title: string) => `Delete the todo “${title}” for good`,
    confirmRemove: (title: string) => `Delete the todo “${title}” for good? This can't be undone.`,
  },
};
const say = (world: World) => SAY[userLocale(world)];

const AreaField = Type.Optional(Type.String({
  description: "The id of one of the user's areas (the parts of life their todos belong to; your instructions list them). An empty string removes it.",
}));

function snapshot(world: World): TodoSnapshot {
  // Provenance from the log: Zirma's own latest change to a todo is shown as such.
  const todos = listTodos(world, { includeDone: true });
  const changes = lastChangesOf(world, todos.map((todo) => `todo:${todo.id}`));
  return {
    today: localDate(),
    settings: getTodoSettings(world),
    todos: todos.map((todo) => {
      const last = changes.get(`todo:${todo.id}`);
      return { ...todo, revision: todoRevision(todo), ...(last?.actor === "alfred" ? { changedBy: { actor: "alfred" as const, kind: last.kind, at: last.at } } : {}) };
    }),
  };
}

/** The todo a tool call names, for steps and confirmations. */
function named(world: World, params: { id?: string; title?: string }): string {
  const todo = params.id ? listTodos(world, { includeDone: true, includeArchived: true }).find((candidate) => candidate.id === params.id) : undefined;
  return todo?.title ?? params.title ?? params.id ?? "";
}

function failed(result: { error: string } | object): result is { error: string } {
  return "error" in result;
}

/** For proposals: the todo a call names, pinned by id and revision, as the subject it touches. */
function pinned(world: World, params: { id?: string; title?: string }, make: (todo: Todo, revision: string) => { op: string; input: unknown; preview: string }) {
  const todo = resolveTodo(world, params);
  if (failed(todo)) return todo;
  return { ...make(todo, todoRevision(todo)), subjects: [`todo:${todo.id}`] };
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export const todoModule = defineModule({
  id: "todo",
  title: "Todos",
  migrations: MIGRATIONS,
  snapshot,
  views: [{ id: "list", title: "Todos" }],
  guidance: (world) => [
    "Todos: when the user mentions something they intend to do later, record it with todo_add instead of only acknowledging it.",
    "A todo has a due date, and `at` when the user names the hour it must be done by (\"before 9pm\"). Leave due out when they name no day.",
    "Something that happens at a time, with someone or somewhere (a meeting, a meal, an appointment, a flight), goes in the calendar and on the todo list both. With a calendar connected, propose the event: proposing it puts its todo on the list by itself (the propose result says so), so do not add one with todo_add. With none connected, add a todo with its title, due its day, with `at` its start time when it has one.",
    "Add a todo for something to do beforehand only when the user names it (\"remind me to prepare slides\"); do not think of preparations for them.",
    "Resolve relative dates (\"Friday\", \"tomorrow\") against the local date you were given.",
    "For a task spanning several days, set startDate to its first day and due to its last day: one ranged todo, not one per day.",
    "Before editing or completing a todo you have not seen in this run, call todo_list to find its id.",
    "todo_suggest is for something you found yourself, in a mail, that the user did not ask you to add: it waits on the Todos page as a suggestion for them to keep or drop. When the user asks for a todo, use todo_add.",
    "Todos marked \"from the calendar\" follow the user's calendar by themselves; do not add a todo for an event already in the calendar.",
    `Set a todo's area when it is clear which part of life it belongs to; leave it out when unsure. The user's areas (id and name): ${describeAreas(world)}.`,
  ].join("\n"),
  areaRemoved: (world, id, moveTo) => { moveTodosOutOfArea(world, id, moveTo); },
  proposed: (world, proposal) => todosForProposedEvents(world, proposal.steps, proposal.replaced).join("\n") || undefined,

  ops: [
    defineOp({
      name: "todo.add",
      input: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 500 }),
        due: Type.Optional(Type.String()), at: Type.Optional(Type.String()), startDate: Type.Optional(Type.String()),
        plannedOn: Type.Optional(Type.String()), url: Type.Optional(Type.String()), area: Type.Optional(Type.String()),
        // A to-do from one of the user's notes, put on the list from the note (never twice).
        source: Type.Optional(Type.Object({ kind: Type.Literal("note"), ref: Type.String({ minLength: 1, maxLength: 1200 }), label: Type.String({ maxLength: 300 }) }, { additionalProperties: false })),
      }),
      run: (world, { source, ...input }) => (source ? addFromNote(world, { title: input.title, source }).todo : addTodo(world, input).todo),
    }),
    defineOp({
      name: "todo.update",
      input: Type.Object({
        id: Type.String(), revision: Type.Optional(Type.String()),
        patch: Type.Object({
          title: Type.Optional(Type.String()), done: Type.Optional(Type.Boolean()), status: Type.Optional(Status),
          due: Type.Optional(Type.String()), at: Type.Optional(Type.String()), startDate: Type.Optional(Type.String()),
          plannedOn: Type.Optional(Type.String()), url: Type.Optional(Type.String()), area: Type.Optional(Type.String()),
        }, { additionalProperties: false }),
      }),
      run: (world, input) => updateTodo(world, { id: input.id, revision: input.revision }, input.patch),
    }),
    defineOp({
      name: "todo.complete",
      input: Type.Object({ id: Type.String(), revision: Type.Optional(Type.String()) }),
      run: (world, input) => completeTodo(world, input),
    }),
    defineOp({
      // The user keeps one of Zirma's suggestions.
      name: "todo.accept",
      input: Type.Object({ id: Type.String(), revision: Type.Optional(Type.String()) }),
      run: (world, input) => acceptTodo(world, input),
    }),
    defineOp({
      // What becomes a todo by itself: which calendar events, and which of them are days off instead.
      name: "todo.sources",
      input: Type.Object({
        fromCalendar: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("allday"), Type.Literal("all")])),
        // The words a day off is named by.
        offWords: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 50 })),
      }),
      run: (world, input) => setTodoSettings(world, input),
    }),
    defineOp({
      // Permanent. A device's explicit delete is the user's own decision; a run must ask first, every time (todo_delete).
      name: "todo.delete",
      input: Type.Object({ id: Type.String(), revision: Type.Optional(Type.String()) }),
      run: (world, input) => deleteTodo(world, input),
    }),
  ],

  tools: [
    defineTool({
      name: "todo_list", label: "List todos", level: "read",
      description: "List the user's todos with their ids, which the other todo tools accept. States the user's local date.",
      parameters: Type.Object({
        includeDone: Type.Optional(Type.Boolean({ description: "Include completed todos (default false)" })),
      }),
      execute(world, params) {
        const today = localDate();
        const todos = listTodos(world, { includeDone: params.includeDone });
        const header = `Today is ${today} (user's local date).`;
        return todos.length ? `${header}\n${todos.map((todo) => formatTodo(todo, today)).join("\n")}` : `${header}\nNo ${params.includeDone ? "" : "open "}todos.`;
      },
    }),
    defineTool({
      name: "todo_add", label: "Add todo", level: "local",
      description: "Add a task to the user's personal todo list.",
      parameters: Type.Object({
        title: Type.String({ description: "Short description of the task" }),
        due: DateField("Due date, or last day of a multi-day task, as YYYY-MM-DD in the user's local timezone"),
        at: AtField("The hour it is due by on its due day, as HH:MM (24-hour, local), when the user names one (\"by 9pm\" → 21:00). Only with due; keep it out of the title."),
        startDate: DateField("First day of a multi-day task as YYYY-MM-DD. Only with due."),
        url: Type.Optional(Type.String({ description: "Link to where the task is actually done (http, https or mailto)" })),
        area: AreaField,
        again: Type.Optional(Type.Boolean({ description: "true only when the user wants a second todo like one already on the list" })),
      }),
      describe: (_world, params) => params.title,
      pin: (world, { again: _again, ...params }) => ({ op: "todo.add", input: params, preview: say(world).add(params.title, params.due) }),
      execute(world, { again, ...params }) {
        try {
          // A model that did not look at the list first would add what is there already ("月底前把房租交了").
          const twin = again ? undefined : sameTodo(world, params);
          if (twin) return `Not added: the list already has ${formatTodo(twin)}. Tell the user it is there (todo_update changes it). Only if they want a second one, call todo_add again with again: true.`;
          const { todo, open } = addTodo(world, params);
          return `Added ${formatTodo(todo)}\n${open} open todo(s).`;
        } catch (error) {
          return message(error);
        }
      },
    }),
    defineTool({
      name: "todo_suggest", label: "Suggest todo", level: "local",
      description: [
        "Suggest a todo you picked out of one of the user's mails: something that mail asks the user to do, or a deadline it sets for them.",
        "It appears on the Todos page marked as your suggestion, with the mail it came from, and becomes a todo only if the user keeps it.",
        "One suggestion per mail and thing to do; a mail already suggested from, or one the user said no to, is refused.",
      ].join(" "),
      parameters: Type.Object({
        title: Type.String({ maxLength: 200, description: "What the user has to do, as a short todo in their language (not the mail's subject)" }),
        due: DateField("The date it has to be done by, as YYYY-MM-DD in the user's local timezone, when the mail gives one"),
        area: AreaField,
        mailId: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$", description: "The message's id, from mail_list" }),
        subject: Type.String({ maxLength: 200, description: "The message's subject, as mail_list gave it" }),
      }),
      describe: (_world, params) => params.title,
      execute(world, params) {
        try {
          const result = suggestTodo(world, {
            title: params.title, due: params.due, area: params.area,
            source: { kind: "mail", ref: `mail:${params.mailId}`, label: params.subject || params.title },
          });
          return failed(result) ? result.error : `Suggested ${formatTodo(result)}`;
        } catch (error) {
          return message(error);
        }
      },
    }),
    defineTool({
      name: "todo_update", label: "Update todo", level: "local",
      description: "Edit a todo's title, dates or link, or set it in progress. Identify it by id or by a distinctive part of its title.",
      parameters: Type.Object({
        ...Ref,
        newTitle: Type.Optional(Type.String({ description: "Replacement title" })),
        due: DateField("Replacement due date as YYYY-MM-DD, or an empty string to remove it"),
        at: AtField("Replacement hour it is due by, as HH:MM, or an empty string to remove it"),
        startDate: DateField("Replacement first day as YYYY-MM-DD, or an empty string to remove it"),
        url: Type.Optional(Type.String({ description: "Replacement link, or an empty string to remove it" })),
        area: AreaField,
        status: Type.Optional(Type.Union([Type.Literal("todo"), Type.Literal("doing")], { description: "todo or doing (in progress). Use todo_complete to finish." })),
      }),
      describe: (world, params) => named(world, params),
      pin: (world, params) => {
        const { id, title, newTitle, ...rest } = params;
        const patch = Object.fromEntries(Object.entries({ ...rest, ...(newTitle !== undefined ? { title: newTitle } : {}) }).filter(([, value]) => value !== undefined));
        if (!Object.keys(patch).length) return { error: "Nothing to change." };
        const text = say(world), locale = userLocale(world), said: string[] = [];
        if (patch.title !== undefined) said.push(text.rename(String(patch.title)));
        if (patch.due !== undefined) said.push(text.due(String(patch.due)));
        if (patch.at !== undefined) said.push(text.at(String(patch.at)));
        if (patch.startDate !== undefined) said.push(text.start(String(patch.startDate)));
        if (patch.area !== undefined) said.push(text.area(patch.area ? areaName(world, String(patch.area), locale) ?? String(patch.area) : ""));
        if (patch.status !== undefined) said.push(text.status(String(patch.status)));
        if (patch.url !== undefined) said.push(text.link(String(patch.url)));
        return pinned(world, { id, title }, (todo, revision) => ({ op: "todo.update", input: { id: todo.id, revision, patch }, preview: text.update(todo.title, said) }));
      },
      execute(world, params) {
        const { id, title, newTitle, ...rest } = params;
        if (newTitle === undefined && Object.values(rest).every((value) => value === undefined)) return "Provide a newTitle, due, at, startDate, url, area or status to update.";
        try {
          const result = updateTodo(world, { id, title }, { ...rest, ...(newTitle !== undefined ? { title: newTitle } : {}) });
          return failed(result) ? result.error : `Updated ${formatTodo(result)}`;
        } catch (error) {
          return message(error);
        }
      },
    }),
    defineTool({
      name: "todo_complete", label: "Complete todo", level: "local",
      description: "Mark a todo as done. Identify it by id or by a distinctive part of its title.",
      parameters: Type.Object(Ref),
      describe: (world, params) => named(world, params),
      pin: (world, params) => pinned(world, params, (todo, revision) => ({ op: "todo.complete", input: { id: todo.id, revision }, preview: say(world).complete(todo.title) })),
      execute(world, params) {
        const result = completeTodo(world, params);
        if (failed(result)) return result.error;
        return `${result.alreadyDone ? "Already done" : "Completed"} ${formatTodo(result.todo)}`;
      },
    }),
    defineTool({
      name: "todo_delete", label: "Delete todo", level: "irreversible",
      description: "Permanently delete a todo. The user is asked to allow each deletion; only use it when they asked to delete or remove it, not to complete it.",
      parameters: Type.Object(Ref),
      describe: (world, params) => named(world, params),
      confirm: (world, params) => say(world).confirmRemove(named(world, params)),
      pin: (world, params) => pinned(world, params, (todo, revision) => ({ op: "todo.delete", input: { id: todo.id, revision }, preview: say(world).remove(todo.title) })),
      execute(world, params) {
        const result = deleteTodo(world, params);
        return failed(result) ? result.error : `Deleted "${result.title}".`;
      },
    }),
  ],
});
