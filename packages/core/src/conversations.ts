/** A conversation: one thread about one topic. Text, voice and clicks write
 * into it; its runs keep their order inside it, while different conversations
 * proceed side by side. It is not an engine session: engines come and go,
 * the conversation stays.
 */
import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { appendEvent, type CoreEvent } from "./events.ts";
import { iso, newId } from "./ids.ts";
import { getProject, ProjectError, SESSION_MODES, type SessionMode } from "./projects.ts";
import type { World } from "./world.ts";

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  archivePlan: "now" | "finish" | "stop" | null;
  /** `provider/model` this conversation uses; null for the engine's default. */
  model: string | null;
  /** How hard the model thinks; null for the default. */
  thinking: ThinkingLevel | null;
  /** `fast`: faster writing where the model's provider offers it, at a higher price; null for standard. */
  speed: Speed | null;
  /** Runs queued or in progress. */
  busy: number;
  /** Runs that need the user: a question waiting, or interrupted. */
  attention: number;
  /** Latest ordinary reply the user has yet to see, shared across devices. */
  unreadReplyId: string | null;
  /** An automation's transcript before the user has spoken in it: kept out of the conversation list and search. */
  automationOnly: boolean;
  /** The newest request in it, for a list preview. */
  lastGoal: string | null;
  /** The project it works in (a development session); null for an everyday conversation. Fixed at creation. */
  projectId: string | null;
  /** A development session's permission mode; null for an everyday conversation. */
  mode: SessionMode | null;
  /** The commit a development session's changes are measured against; null when its folder is not a git repository. */
  base: string | null;
  /** The commands the user allowed for the rest of a development session (shell.ts). */
  commands: string[];
  /** A development session's own git worktree (an absolute path on the home node), when it was started in one; null
   * when it works in the project's folder itself. */
  worktree: string | null;
  /** The branch checked out in that worktree. */
  branch: string | null;
}

export class ConversationError extends Error {
  override name = "ConversationError";
  readonly code: "missing" | "invalid" | "archive_busy" | "session_closed";
  readonly count?: number;
  constructor(code: ConversationError["code"], message?: string, count?: number) {
    super(message ?? (code === "missing" ? "No such conversation" : "Invalid conversation"));
    this.code = code;
    this.count = count;
  }
}

export const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const SPEEDS = ["fast"] as const;
export type Speed = (typeof SPEEDS)[number];
export const CONVERSATION_MODEL = /^[A-Za-z0-9._-]{1,60}\/[A-Za-z0-9._:@\/-]{1,139}$/;

/** A title from what the user first asked: the start of it, on one line. */
export function titleFrom(goal: string): string {
  const line = goal.replace(/\s+/g, " ").trim();
  return line.length > 40 ? `${line.slice(0, 39)}…` : line || "新对话";
}

const SELECT = `SELECT c.*,
  EXISTS (SELECT 1 FROM core_automations a WHERE a.conversation_id = c.id
    AND NOT EXISTS (SELECT 1 FROM core_runs r WHERE r.conversation_id = c.id AND
      (r.automation_id IS NOT a.id OR EXISTS (SELECT 1 FROM core_events e WHERE e.run_id = r.id
        AND e.actor = 'user' AND e.kind IN ('run.steered', 'run.answered'))))) AS automation_only,
  (SELECT count(*) FROM core_runs r WHERE r.conversation_id = c.id AND r.state IN ('queued', 'running', 'cancelling')) AS busy,
  (SELECT count(*) FROM core_runs r WHERE r.conversation_id = c.id AND r.state IN ('waiting_input', 'waiting_permission', 'interrupted')) AS attention,
  (SELECT r.goal FROM core_runs r WHERE r.conversation_id = c.id ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) AS last_goal
  FROM core_conversations c`;

function toConversation(row: Record<string, unknown>): Conversation {
  return {
    id: row.id as string, title: row.title as string, createdAt: row.created_at as string, updatedAt: row.updated_at as string,
    archivedAt: row.archived_at as string | null, model: row.model as string | null, thinking: row.thinking as ThinkingLevel | null,
    archivePlan: (row.archive_plan as Conversation["archivePlan"]) ?? null,
    speed: (row.speed as Speed | null) ?? null,
    busy: row.busy as number, attention: row.attention as number,
    unreadReplyId: (row.unread_reply_id as string | null) ?? null,
    automationOnly: row.automation_only === 1,
    lastGoal: row.last_goal ? String(row.last_goal).slice(0, 120) : null,
    projectId: (row.project_id as string | null) ?? null,
    mode: (row.mode as SessionMode | null) ?? null,
    base: (row.base as string | null) ?? null,
    commands: (JSON.parse((row.commands as string | undefined) ?? "[]") as Array<{ command: string }>).map((grant) => grant.command),
    worktree: (row.worktree as string | null) ?? null,
    branch: (row.branch as string | null) ?? null,
  };
}

/** Only inside a world transaction. */
export function createConversation(db: DatabaseSync, input: { title: string; now: number; projectId?: string; mode?: SessionMode; base?: string | null; worktree?: SessionWorktree | null; model?: string | null }): string {
  if (input.model != null && !CONVERSATION_MODEL.test(input.model)) throw new ConversationError("invalid", "A model is written provider/model");
  const id = newId();
  const worktree = input.projectId ? input.worktree ?? null : null;
  db.prepare("INSERT INTO core_conversations (id, title, created_at, updated_at, project_id, mode, base, worktree, branch, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.title.slice(0, 200), iso(input.now), iso(input.now), input.projectId ?? null, input.projectId ? input.mode ?? "edits" : null, input.base ?? null,
      worktree?.path ?? null, worktree?.branch ?? null, input.model ?? null);
  appendEvent(db, {
    kind: "conversation.created", subject: `conversation:${id}`, runId: null, now: input.now,
    payload: { title: input.title.slice(0, 200), ...(input.projectId ? { projectId: input.projectId } : {}), ...(worktree ? { branch: worktree.branch } : {}) },
  });
  return id;
}

/** Where a development session's worktree is and which branch it has checked out. */
export interface SessionWorktree { path: string; branch: string }

const COMMIT = /^[0-9a-f]{4,64}$/;
// A Git branch may contain Unicode and punctuation. Only the home node chooses the checkout path and
// verifies the exact local ref with Git before passing it here.
const BRANCH = /^(?![-/])(?!.*(?:\.\.|@\{|\/\/))(?!.*[./]$)[^\x00-\x20\x7f~^:?*\[\\]{1,4096}$/u;

/** A development session in a trusted project, created before its first message (an everyday conversation is
 * created by its first message instead). The title comes from what the user is about to ask. `worktree`: the
 * worktree made for it (the home node makes it before this; the session then works there, not in the project). */
export function startSession(world: World, input: { projectId: string; title: string; mode?: SessionMode; base?: string | null; worktree?: SessionWorktree | null; model?: string | null; now?: number }): Conversation {
  const now = input.now ?? Date.now();
  if (input.mode !== undefined && !SESSION_MODES.includes(input.mode)) throw new ConversationError("invalid", "Unknown permission mode");
  if (input.base !== undefined && input.base !== null && !COMMIT.test(input.base)) throw new ConversationError("invalid", "A base is a commit id");
  if (input.worktree && (!isAbsolute(input.worktree.path) || !BRANCH.test(input.worktree.branch))) throw new ConversationError("invalid", "A worktree is an absolute path and a branch");
  const id = world.tx((db) => {
    const project = getProject(world, input.projectId);
    if (!project.trustedAt) throw new ProjectError("untrusted");
    if (input.mode && input.mode !== project.defaultMode) {
      db.prepare("UPDATE core_projects SET default_mode = ? WHERE id = ?").run(input.mode, project.id);
      appendEvent(db, { kind: "project.default_mode_set", subject: `project:${project.id}`, payload: { mode: input.mode }, runId: null, now });
    }
    return createConversation(db, { title: titleFrom(input.title), now, projectId: project.id, mode: input.mode ?? project.defaultMode, base: input.base, worktree: input.worktree, model: input.model });
  });
  return getConversation(world, id);
}

/** The folder a development session works in: its worktree, or its project's folder. Null for an everyday
 * conversation, or when its project was removed. */
export function sessionRoot(world: World, conversation: Pick<Conversation, "projectId" | "worktree">): string | null {
  if (!conversation.projectId) return null;
  if (conversation.worktree) return conversation.worktree;
  try { return getProject(world, conversation.projectId).path; } catch { return null; }
}

/** The user committed a development session's changes (from its changes panel): from now on its changes are
 * measured from `base`, the folder as it stood just after the commit. */
export function recordCommit(world: World, id: string, input: { commit: string; base: string | null; message: string; files: number; now?: number }): Conversation {
  const now = input.now ?? Date.now();
  if (!COMMIT.test(input.commit) || (input.base !== null && !COMMIT.test(input.base))) throw new ConversationError("invalid", "A commit id is hexadecimal");
  world.tx((db) => {
    const row = db.prepare("SELECT project_id FROM core_conversations WHERE id = ?").get(id);
    if (!row) throw new ConversationError("missing");
    if (!row.project_id) throw new ConversationError("invalid", "Only a development session commits");
    db.prepare("UPDATE core_conversations SET base = ?, updated_at = ? WHERE id = ?").run(input.base, iso(now), id);
    appendEvent(db, {
      kind: "conversation.committed", subject: `conversation:${id}`, runId: null, now,
      payload: { commit: input.commit, message: input.message.split("\n")[0].slice(0, 200), files: input.files },
    });
  });
  return getConversation(world, id);
}

/** The user pushed a development session's branch and opened (or updated) its pull request. */
export function recordPublished(world: World, id: string, input: { branch: string; url: string | null; created: boolean; now?: number }): Conversation {
  const now = input.now ?? Date.now();
  world.tx((db) => {
    const row = db.prepare("SELECT project_id FROM core_conversations WHERE id = ?").get(id);
    if (!row) throw new ConversationError("missing");
    if (!row.project_id) throw new ConversationError("invalid", "Only a development session publishes");
    appendEvent(db, {
      kind: input.created ? "conversation.pr_opened" : "conversation.pushed", subject: `conversation:${id}`, runId: null, now,
      payload: { branch: input.branch.slice(0, 200), ...(input.url ? { url: input.url.slice(0, 500) } : {}) },
    });
  });
  return getConversation(world, id);
}

/** Only inside a world transaction: the conversation exists and has just been active. */
export function touchConversation(db: DatabaseSync, id: string, now: number): void {
  const changed = db.prepare("UPDATE core_conversations SET updated_at = ? WHERE id = ?").run(iso(now), id);
  if (changed.changes === 0) throw new ConversationError("missing");
}

/** No new run can enter a coding session once archiving starts. Previously interrupted work may resume when
 * the user asked to finish it before archiving. Read in the same transaction that queues the run. */
export function requireOpenSession(db: DatabaseSync, id: string, resume = false): void {
  const row = db.prepare("SELECT * FROM core_conversations WHERE id = ?").get(id);
  if (row?.project_id && (row.archived_at || (row.archive_plan && !(resume && row.archive_plan === "finish")))) {
    throw new ConversationError("session_closed", "This session is archived or waiting to archive");
  }
}

export function setArchivePlan(world: World, id: string, plan: Conversation["archivePlan"]): void {
  world.tx((db) => {
    const changed = db.prepare("UPDATE core_conversations SET archive_plan = ? WHERE id = ? AND archive_plan IS NOT ?").run(plan, id, plan);
    if (changed.changes) appendEvent(db, { kind: "conversation.archive_plan", subject: `conversation:${id}`, runId: null, payload: { plan }, now: Date.now() });
  });
}

/** Called inside the run's completion transaction; that event also refreshes the conversation list. */
export function recordUnreadReply(db: DatabaseSync, conversationId: string, runId: string): void {
  db.prepare(`UPDATE core_conversations SET unread_reply_id = ?
    WHERE id = ? AND archived_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM core_proposals WHERE run_id = ? AND state = 'open')`).run(runId, conversationId, runId);
}

/** A slow read from another device must never clear a newer reply. Reading does not reorder the conversation. */
export function markConversationReplyRead(world: World, conversationId: string, runId: string): void {
  world.tx((db) => {
    if (!db.prepare("SELECT 1 FROM core_conversations WHERE id = ?").get(conversationId)) throw new ConversationError("missing");
    const changed = db.prepare("UPDATE core_conversations SET unread_reply_id = NULL WHERE id = ? AND unread_reply_id = ?").run(conversationId, runId);
    if (changed.changes) appendEvent(db, { kind: "conversation.read", subject: `conversation:${conversationId}`, actor: "user", runId, payload: {}, now: Date.now() });
  });
}

export function getConversation(world: World, id: string): Conversation {
  const row = world.db.prepare(`${SELECT} WHERE c.id = ?`).get(id);
  if (!row) throw new ConversationError("missing");
  return toConversation(row);
}

/** Whether a conversation is a development session (it belongs to a project). */
export function isSession(world: World, conversationId: string | null | undefined): boolean {
  return !!conversationId && !!world.db.prepare("SELECT 1 FROM core_conversations WHERE id = ? AND project_id IS NOT NULL").get(conversationId);
}

/** Whether a run is one of a development session's. */
export function runInSession(world: World, runId: string): boolean {
  return !!world.db.prepare("SELECT 1 FROM core_runs r JOIN core_conversations c ON c.id = r.conversation_id WHERE r.id = ? AND c.project_id IS NOT NULL").get(runId);
}

/** The conversations that are development sessions. */
export function sessionIds(world: World): Set<string> {
  return new Set(world.db.prepare("SELECT id FROM core_conversations WHERE project_id IS NOT NULL").all().map((row) => row.id as string));
}

/** Whether an event came out of a development session: recorded under one of its runs, or about the session itself. */
export function sessionEvent(world: World, event: Pick<CoreEvent, "runId" | "subject">): boolean {
  if (event.runId) return runInSession(world, event.runId);
  return !!event.subject?.startsWith("conversation:") && isSession(world, event.subject.slice("conversation:".length));
}

/** Most recently active first. */
export function listConversations(world: World, options: { includeArchived?: boolean; limit?: number } = {}): Conversation[] {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
  return world.db.prepare(`${SELECT} WHERE (? = 1 OR c.archived_at IS NULL) ORDER BY c.updated_at DESC, c.rowid DESC LIMIT ?`)
    .all(options.includeArchived ? 1 : 0, limit).map(toConversation);
}

/** The archive only needs enough metadata to identify and restore a conversation. */
export function listArchivedConversations(world: World, options: { includeSessions: boolean }) {
  return world.db.prepare(`SELECT id, title, project_id, archived_at FROM core_conversations
    WHERE archived_at IS NOT NULL AND (? OR project_id IS NULL)
    ORDER BY archived_at DESC, rowid DESC`).all(Number(options.includeSessions)).map((row) => ({
      id: row.id as string, title: row.title as string, projectId: row.project_id as string | null,
      archivedAt: row.archived_at as string,
    }));
}

export function updateConversation(
  world: World,
  id: string,
  change: { title?: string; archived?: boolean; model?: string | null; thinking?: ThinkingLevel | null; speed?: Speed | null; mode?: SessionMode; now?: number },
): Conversation {
  const now = change.now ?? Date.now();
  if (change.model !== undefined && change.model !== null && !CONVERSATION_MODEL.test(change.model)) throw new ConversationError("invalid", "A model is written provider/model");
  if (change.thinking !== undefined && change.thinking !== null && !THINKING_LEVELS.includes(change.thinking)) throw new ConversationError("invalid", "Unknown thinking level");
  if (change.speed !== undefined && change.speed !== null && !SPEEDS.includes(change.speed)) throw new ConversationError("invalid", "Unknown speed");
  world.tx((db) => {
    const row = db.prepare("SELECT title, archived_at, archive_plan, model, thinking, speed, project_id, mode FROM core_conversations WHERE id = ?").get(id);
    if (!row) throw new ConversationError("missing");
    if (change.mode !== undefined && change.mode !== row.mode) {
      if (!row.project_id) throw new ConversationError("invalid", "Only a development session has a permission mode");
      if (!SESSION_MODES.includes(change.mode)) throw new ConversationError("invalid", "Unknown permission mode");
      db.prepare("UPDATE core_conversations SET mode = ? WHERE id = ?").run(change.mode, id);
      appendEvent(db, { kind: "conversation.mode_set", subject: `conversation:${id}`, payload: { from: row.mode ?? null, to: change.mode }, runId: null, now });
    }
    for (const field of ["model", "thinking", "speed"] as const) {
      const value = change[field];
      if (value === undefined || value === row[field]) continue;
      db.prepare(`UPDATE core_conversations SET ${field} = ? WHERE id = ?`).run(value, id);
      appendEvent(db, { kind: `conversation.${field}_set`, subject: `conversation:${id}`, payload: { from: row[field] ?? null, to: value }, runId: null, now });
    }
    if (change.title !== undefined) {
      const title = change.title.replace(/\s+/g, " ").trim();
      if (!title || title.length > 200) throw new ConversationError("invalid", "A title is 1–200 characters");
      if (title !== row.title) {
        db.prepare("UPDATE core_conversations SET title = ? WHERE id = ?").run(title, id);
        appendEvent(db, { kind: "conversation.renamed", subject: `conversation:${id}`, payload: { from: row.title, to: title }, runId: null, now });
      }
    }
    if (change.archived !== undefined && change.archived !== (row.archived_at !== null)) {
      db.prepare("UPDATE core_conversations SET archived_at = ?, archive_plan = NULL, unread_reply_id = NULL WHERE id = ?").run(change.archived ? iso(now) : null, id);
      // Include an old conversation in the bounded recent list when the user brings it back.
      if (!change.archived) touchConversation(db, id, now);
      appendEvent(db, { kind: change.archived ? "conversation.archived" : "conversation.restored", subject: `conversation:${id}`, payload: row.archive_plan === "finish" || row.archive_plan === "stop" ? { deferred: true } : {}, runId: null, now });
    }
  });
  return getConversation(world, id);
}
