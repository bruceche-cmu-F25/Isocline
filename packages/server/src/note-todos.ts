/** To-dos in notes and the todo list, both ways (docs/research/notes-editor.md 3.5): a to-do the user put on the list
 * is finished there when they tick it in the note, and its box in the note is ticked when they finish it on the list
 * (unticked when reopened). Only what the user did is mirrored; nothing is ticked by itself.
 *
 * The one place that knows both modules, as todo-sources.ts is for the calendar: neither reads the other's tables. */
import { onEvents, withCoreContext, type World } from "@zirma/core";
import { setTaskChecked, taskChanges, type Library } from "@zirma/module-notes";
import { noteTodos, setNoteTodoDone } from "@zirma/module-todo";

interface NotesHandle { library(world: World): { library: Library; id: string } }

/** A page was saved from the editor: its ticked and unticked to-dos finish or reopen their todos. */
export function mirrorNoteTicks(world: World, libraryId: string, page: string, before: string, after: string, log: (message: string) => void): void {
  for (const change of taskChanges(libraryId, page, before, after)) {
    // A todo that went meanwhile answers false; a throw is something else, and the list now disagrees with the note.
    try { withCoreContext({ actor: "user" }, () => setNoteTodoDone(world, change.ref, change.checked)); } catch (error) {
      log(`notes: a to-do ticked in "${page}" could not follow on the todo list: ${(error as Error).message}`);
    }
  }
}

/** A todo from a note finished or reopened on the list: its box in the note follows. */
export function watchNoteTodos(world: World, notes: NotesHandle | undefined, log: (message: string) => void): () => void {
  if (!notes) return () => {};
  const known = new Map(noteTodos(world).map((todo) => [todo.id, todo.done]));
  return onEvents(world, (kinds) => {
    if (![...kinds].some((kind) => kind === "todo.completed" || kind === "todo.updated" || kind === "todo.added")) return;
    // After the commit that told of it, not inside it.
    setImmediate(() => {
      if (!world.db.isOpen) return;
      for (const todo of noteTodos(world)) {
        const was = known.get(todo.id);
        known.set(todo.id, todo.done);
        if (was === undefined || was === todo.done) continue;
        try {
          const { library, id } = notes.library(world);
          setTaskChecked(world, library, id, todo.ref, todo.done);
        } catch (error) {
          log(`notes: could not tick a to-do: ${(error as Error).message}`);
        }
      }
    });
  });
}
