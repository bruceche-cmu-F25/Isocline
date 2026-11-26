/** The modules this UI knows how to draw, and what each hands devices: its snapshot (StateResponse.modules[id]) and
 * the operations a device may ask of it. The wire carries snapshots as `unknown`; this is the one place that says
 * which type each one is, so pages read them through `snapshotOf` instead of casting.
 *
 * Each module's own `types` entry defines both. The home node's tests check the operation lists against the modules
 * themselves (packages/server/test/module-types.test.ts); each module's `snapshot()` is declared with its type.
 */
import type { CalendarOp, CalendarSnapshot } from "@zirma/module-calendar/types";
import type { LinkOp, LinksSnapshot } from "@zirma/module-links/types";
import type { MailOp, MailSnapshot } from "@zirma/module-mail/types";
import type { NoteOp, NotesSnapshot } from "@zirma/module-notes/types";
import type { TodoOp, TodoSnapshot } from "@zirma/module-todo/types";

export interface ModuleSnapshots {
  todo: TodoSnapshot;
  calendar: CalendarSnapshot;
  mail: MailSnapshot;
  link: LinksSnapshot;
  note: NotesSnapshot;
}
export type ModuleId = keyof ModuleSnapshots;

/** An operation a device may ask of a module (POST /api/ops/<name>). */
export type OpName = TodoOp | CalendarOp | MailOp | LinkOp | NoteOp;

/** A module's snapshot as the state holds it; undefined when this home node has no such module, or has not sent it. */
export function snapshotOf<K extends ModuleId>(state: { modules: Record<string, unknown> } | null | undefined, id: K): ModuleSnapshots[K] | undefined {
  return state?.modules[id] as ModuleSnapshots[K] | undefined;
}
