/** The goals module (docs/design/goals.md): a long-term goal the user defines, in one place. G1: a goal is a folder
 * in the notes with three pages (the goal, its big picture, its route); the pages are read by their headings, and
 * written by hand in the notes' own editor. Nothing here asks a model for anything yet.
 *
 * The module holds no goal of its own: every goal, its words, its deadline and its steps are the user's. */
import { defineModule, defineOp, defineQuery, Type, userLocale, type World, type ZirmaModule } from "@zirma/module-kit";
import type { Library } from "@zirma/module-notes";
import { createGoal, ensurePage, goalDetail, GoalError, indexGoals, LibraryError, listGoals, MIGRATIONS, removeGoal, restoreGoal, setStep, updateGoal, type Lang } from "./domain.ts";
import type { GoalsSnapshot } from "./types.ts";

export * from "./types.ts";
export * from "./format.ts";
export { createGoal, goalDetail, indexGoals, listGoals, nameFrom, removeGoal, restoreGoal, setStep, updateGoal, GoalError } from "./domain.ts";

export interface GoalsOptions {
  /** The notes, where the goals' folders are: the library as it is now. */
  notes: { library(world: World): { library: Library; id: string } };
  /** A goal's folder was renamed: the home node lets what points at its pages follow. */
  onMoved?(world: World, from: string, to: string): void;
}

const GoalId = Type.String({ minLength: 1, maxLength: 64 });

/** What a device learns when a rule refuses something. */
function refused(error: unknown): { error: string; code: string } {
  if (error instanceof GoalError || error instanceof LibraryError) return { error: error.message, code: error.code };
  throw error;
}

export function createGoalsModule(options: GoalsOptions): ZirmaModule {
  const lang = (world: World): Lang => (userLocale(world) === "zh" ? "zh" : "en");
  const notes = (world: World) => options.notes.library(world);
  const snapshot = (world: World): GoalsSnapshot => ({ goals: listGoals(world) });

  return defineModule({
    id: "goal",
    title: "Goals",
    migrations: MIGRATIONS,
    views: [{ id: "home", title: "Goals" }],
    ops: [
      defineOp({
        name: "goal.create",
        input: Type.Object({ sentence: Type.String({ minLength: 1, maxLength: 500 }), name: Type.Optional(Type.String({ maxLength: 120 })) }),
        run: (world, input) => {
          try { return createGoal(world, notes(world).library, lang(world), input); } catch (error) { return refused(error); }
        },
      }),
      defineOp({
        name: "goal.update",
        input: Type.Object({
          id: GoalId,
          name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
          sentence: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
          why: Type.Optional(Type.String({ maxLength: 4000 })),
          deadline: Type.Optional(Type.Union([Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), Type.Null()])),
          pace: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 7 }), Type.Null()])),
        }),
        run: (world, input) => {
          const { library, id } = notes(world);
          const { id: goal, ...patch } = input;
          try { return updateGoal(world, library, id, lang(world), goal, patch, (from, to) => options.onMoved?.(world, from, to)); } catch (error) { return refused(error); }
        },
      }),
      defineOp({
        // "This step is done", or not after all: the user's word.
        name: "goal.step",
        input: Type.Object({ id: GoalId, step: Type.String({ minLength: 1, maxLength: 64 }), done: Type.Boolean() }),
        run: (world, input) => {
          const { library, id } = notes(world);
          try { return setStep(world, library, id, input.id, input.step, input.done); } catch (error) { return refused(error); }
        },
      }),
      defineOp({
        // The page to write the big picture or the route in, made if the goal's folder does not have it.
        name: "goal.page",
        input: Type.Object({ id: GoalId, which: Type.Union([Type.Literal("picture"), Type.Literal("route")]) }),
        run: (world, input) => {
          try { return ensurePage(world, notes(world).library, lang(world), input.id, input.which); } catch (error) { return refused(error); }
        },
      }),
      defineOp({
        // The goal's folder goes to the notes' trash; `goal.restore` with the entry it answers puts it back.
        name: "goal.remove",
        input: Type.Object({ id: GoalId }),
        run: (world, input) => {
          try { return removeGoal(world, notes(world).library, input.id); } catch (error) { return refused(error); }
        },
      }),
      defineOp({
        name: "goal.restore",
        input: Type.Object({ entry: Type.String({ minLength: 1, maxLength: 64 }) }),
        run: (world, input) => {
          try { return restoreGoal(world, notes(world).library, input.entry); } catch (error) { return refused(error); }
        },
      }),
    ],
    queries: [
      defineQuery({
        name: "goal.detail",
        input: Type.Object({ id: GoalId }),
        run: (world, input) => {
          try { return goalDetail(world, notes(world).library, input.id); } catch (error) { return refused(error); }
        },
      }),
    ],
    tools: [],
    snapshot,
    sync: {
      // The folders are read again a moment after a page of the notes is saved, made, renamed or deleted here, or
      // read in after another app changed it (a goal's pages are pages of the notes); and now and then besides.
      everyMs: 5 * 60_000,
      onEvents: ["note.saved", "note.edited", "note.indexed", "note.created", "note.renamed", "note.deleted", "note.undone", "note.redone"],
      run: async (world) => { indexGoals(world, notes(world).library); },
    },
  });
}
