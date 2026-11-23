/** For upgrade tests: an automation as an older app wrote it, with only the columns every version has, and the event
 * that says it was made (so the shipped ones are not made again). Today's `createAutomation` writes columns an old
 * world does not have yet. */
import { recordDomainEvent, type World } from "../src/index.ts";

export function oldAutomation(world: World, input: { id: string; name?: string; template?: "brief" | "mail_todos"; goal?: string; schedule: { at: string; days: number[] }; enabled: boolean; at: number }): void {
  const when = new Date(input.at).toISOString();
  world.tx((db) => {
    db.prepare(`INSERT INTO core_automations (id, name, template, goal, schedule, enabled, last_slot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
      .run(input.id, input.name ?? null, input.template ?? null, input.goal ?? null, JSON.stringify(input.schedule), input.enabled ? 1 : 0, when, when);
    recordDomainEvent(world, { kind: "automation.created", subject: `automation:${input.id}`, payload: { name: input.name ?? null, template: input.template ?? null, schedule: input.schedule, enabled: input.enabled }, now: input.at });
  });
}
