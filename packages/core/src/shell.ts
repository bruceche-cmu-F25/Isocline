/** Command-specific grants in a development session's ask mode. A grant covers a plain command with optional
 * trailing arguments (`npm test` also allows `npm test -- foo`). Chains, pipes and redirects require separate
 * approval unless the user switches the whole session to `edits`. */
import { appendEvent } from "./events.ts";
import { ConversationError } from "./conversations.ts";
import type { SessionMode } from "./projects.ts";
import type { World } from "./world.ts";

/** What a shell reads as more than one command, or as somewhere else to read from or write to. */
const SHELL_SYNTAX = /[;&|<>`\n\r]|\$\(|\$\{/;
const MAX_GRANT = 300;
const MAX_GRANTS = 50;

/** A command as it is compared: trimmed, with runs of spaces as one. */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/[ \t]+/g, " ");
}

/** One plain command with its arguments: the only kind a session-wide yes can cover. */
export function simpleCommand(command: string): boolean {
  const text = normalizeCommand(command);
  return text.length > 0 && text.length <= MAX_GRANT && !SHELL_SYNTAX.test(text);
}

/** Whether a grant covers this command: the same words, or the same words with more arguments after them. */
export function commandAllowed(grants: Iterable<string>, command: string): boolean {
  if (!simpleCommand(command)) return false;
  const text = normalizeCommand(command);
  for (const grant of grants) if (text === grant || text.startsWith(`${grant} `)) return true;
  return false;
}

export interface CommandGrant {
  /** The command the user allowed for the session. */
  command: string;
  /** Who said so: `home` for the home node's own machine, else the paired device's id. */
  by: string;
  at: string;
}

/** The current session policy, read before each edit or command. */
export function sessionPermissions(world: World, conversationId: string): { projectId: string | null; mode: SessionMode | null; grants: CommandGrant[] } {
  const row = world.db.prepare("SELECT project_id, mode, commands FROM core_conversations WHERE id = ?").get(conversationId);
  if (!row) throw new ConversationError("missing");
  return { projectId: row.project_id as string | null, mode: row.mode as SessionMode | null, grants: JSON.parse(row.commands as string) as CommandGrant[] };
}

/** The commands the user allowed for the rest of this session, oldest first. */
export function listCommandGrants(world: World, conversationId: string): CommandGrant[] {
  return sessionPermissions(world, conversationId).grants;
}

/** The user allowed this command for the rest of the session. Only a plain command can be; granting twice is a no-op. */
export function grantCommand(world: World, conversationId: string, command: string, by: string, now: number = Date.now()): CommandGrant[] {
  if (!simpleCommand(command)) throw new ConversationError("invalid", "Only a plain command can be allowed for a session");
  const text = normalizeCommand(command);
  return world.tx((db) => {
    const { projectId, grants } = sessionPermissions(world, conversationId);
    if (!projectId) throw new ConversationError("invalid", "Only a development session runs commands");
    if (grants.some((grant) => grant.command === text)) return grants;
    const next = [...grants, { command: text, by, at: new Date(now).toISOString() }].slice(-MAX_GRANTS);
    db.prepare("UPDATE core_conversations SET commands = ? WHERE id = ?").run(JSON.stringify(next), conversationId);
    appendEvent(db, { kind: "conversation.command_allowed", subject: `conversation:${conversationId}`, payload: { command: text, by }, runId: null, now });
    return next;
  });
}

/** The user took a session-wide yes back: that command asks again. */
export function revokeCommand(world: World, conversationId: string, command: string, now: number = Date.now()): CommandGrant[] {
  const text = normalizeCommand(command);
  return world.tx((db) => {
    const { grants } = sessionPermissions(world, conversationId);
    const next = grants.filter((grant) => grant.command !== text);
    if (next.length === grants.length) return grants;
    db.prepare("UPDATE core_conversations SET commands = ? WHERE id = ?").run(JSON.stringify(next), conversationId);
    appendEvent(db, { kind: "conversation.command_revoked", subject: `conversation:${conversationId}`, payload: { command: text }, runId: null, now });
    return next;
  });
}

/** A device lost its say over development sessions (revoked, or its `dev` scope turned off): what it allowed for a
 * session no longer holds. Only inside a world transaction. Returns how many grants were dropped. */
export function dropGrantsBy(world: World, device: string, now: number = Date.now()): number {
  let dropped = 0;
  for (const row of world.db.prepare("SELECT id, commands FROM core_conversations WHERE commands != '[]'").all()) {
    const grants = JSON.parse(row.commands as string) as CommandGrant[];
    const next = grants.filter((grant) => grant.by !== device);
    if (next.length === grants.length) continue;
    world.db.prepare("UPDATE core_conversations SET commands = ? WHERE id = ?").run(JSON.stringify(next), row.id as string);
    for (const grant of grants) {
      if (grant.by !== device) continue;
      dropped++;
      appendEvent(world.db, { kind: "conversation.command_revoked", subject: `conversation:${row.id as string}`, payload: { command: grant.command, device }, runId: null, now });
    }
  }
  return dropped;
}
