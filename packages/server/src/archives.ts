import { existsSync } from "node:fs";
import { ConversationError, getConversation, getProject, requestCancel, requireOpenSession, setArchivePlan, updateConversation, withCoreContext, type World } from "@isocline/core";
import type { Processes } from "./processes.ts";
import type { Terminals } from "./terminals.ts";
import { removeWorktree, uncommitted, WorkspaceError } from "./workspace.ts";

type RunChoice = "finish" | "stop";
type FolderChoice = "keep" | "discard";

/** The single home node owns these transitions. A persisted plan closes admission before any asynchronous
 * cleanup. Deferred archives retain their worktree so edits arriving while a run finishes are preserved. */
export class SessionArchives {
  readonly #workspaceOperations = new Map<string, number>();
  readonly #closing = new Map<string, Promise<void>>();
  readonly #unsubscribe: () => void;
  #scheduled: NodeJS.Immediate | undefined;

  readonly world: World;
  readonly processes: Processes;
  readonly terminals: Terminals;
  readonly log?: (message: string) => void;

  constructor(world: World, processes: Processes, terminals: Terminals, log?: (message: string) => void) {
    this.world = world;
    this.processes = processes;
    this.terminals = terminals;
    this.log = log;
    // Older home nodes could leave work scheduled on an already archived session.
    for (const row of world.db.prepare(`SELECT DISTINCT r.conversation_id FROM core_runs r JOIN core_conversations c ON c.id=r.conversation_id
      WHERE c.project_id IS NOT NULL AND c.archived_at IS NOT NULL AND r.state IN ('queued','running','waiting_input','waiting_permission','interrupted')`).all()) {
      this.#cancel(String(row.conversation_id));
    }
    this.#unsubscribe = world.onCommit(() => this.#schedule());
    this.#schedule();
  }

  #schedule() {
    if (!this.world.db.isOpen) return;
    this.#scheduled ??= setImmediate(() => { this.#scheduled = undefined; this.#reconcile(); });
  }

  /** A commit or publish already in progress finishes before its working directory can be removed. */
  beginWorkspaceOperation(id: string): () => void {
    requireOpenSession(this.world.db, id);
    this.#workspaceOperations.set(id, (this.#workspaceOperations.get(id) ?? 0) + 1);
    return () => {
      const remaining = (this.#workspaceOperations.get(id) ?? 1) - 1;
      if (remaining) this.#workspaceOperations.set(id, remaining);
      else this.#workspaceOperations.delete(id);
      this.#schedule();
    };
  }

  async request(id: string, choice?: RunChoice, folder?: FolderChoice): Promise<void> {
    const current = this.#closing.get(id);
    if (current) return current;
    const conversation = getConversation(this.world, id);
    if (conversation.archivedAt) return;
    const active = conversation.busy + conversation.attention + (this.#workspaceOperations.get(id) ?? 0);
    if (active && !choice) throw new ConversationError("archive_busy", "This session still has unfinished tasks", active);
    // Retrying 'finish' cannot turn off a cancellation the user has already requested.
    const plan = conversation.archivePlan === "stop" ? "stop" : choice ?? conversation.archivePlan ?? "now";
    withCoreContext({ actor: "user" }, () => this.world.tx(() => {
      setArchivePlan(this.world, id, plan);
      if (plan === "stop") this.#cancel(id);
    }));
    const latest = getConversation(this.world, id);
    if (!latest.busy && !latest.attention && !this.#workspaceOperations.has(id)) await this.#finish(id, plan === "now" ? folder : "keep");
  }

  async withdraw(id: string): Promise<void> {
    const closing = this.#closing.get(id);
    if (closing) await closing;
    setArchivePlan(this.world, id, null);
  }

  #cancel(id: string) {
    const waiting = this.world.db.prepare(`SELECT id FROM core_runs WHERE conversation_id = ?
      AND state IN ('queued','running','waiting_input','waiting_permission','interrupted')`).all(id);
    for (const row of waiting) requestCancel(this.world, String(row.id));
  }

  #reconcile() {
    const rows = this.world.db.prepare("SELECT id FROM core_conversations WHERE archive_plan IS NOT NULL").all();
    for (const row of rows) {
      const id = String(row.id);
      if (this.#closing.has(id) || this.#workspaceOperations.has(id)) continue;
      const current = getConversation(this.world, id);
      // On restart a stopped executor is interrupted. Honour the outstanding stop request for it too.
      if (current.archivePlan === "stop") this.#cancel(id);
      const latest = getConversation(this.world, id);
      if (latest.busy || latest.attention) continue;
      void this.#finish(id, latest.archivePlan === "now" ? undefined : "keep")
        .catch((error) => this.log?.(`Could not archive session ${id}: ${String(error)}`));
    }
  }

  #finish(id: string, folder?: FolderChoice): Promise<void> {
    const existing = this.#closing.get(id);
    if (existing) return existing;
    const task = this.#cleanup(id, folder).catch((error) => {
      if (this.world.db.isOpen) setArchivePlan(this.world, id, null);
      throw error;
    }).finally(() => this.#closing.delete(id));
    this.#closing.set(id, task);
    return task;
  }

  async #cleanup(id: string, folder?: FolderChoice) {
    const conversation = getConversation(this.world, id);
    const worktree = conversation.worktree;
    const project = worktree && folder !== "keep"
      ? (() => { try { return getProject(this.world, conversation.projectId!); } catch { return null; } })() : null;
    if (worktree && project && !folder && existsSync(worktree)) {
      // Before stopping a terminal or watcher, let the user choose what to do with their edits.
      const count = await uncommitted(worktree);
      if (count) throw new WorkspaceError("dirty", `${count} file(s) in the worktree are not committed`, count);
    }
    await Promise.all([this.processes.stopSession(id), this.terminals.closeForArchive(id)]);
    if (!this.world.db.isOpen) return;
    if (worktree && project) await removeWorktree(project.path, worktree, folder === "discard");
    if (this.world.db.isOpen) withCoreContext({ actor: "user" }, () => updateConversation(this.world, id, { archived: true }));
  }

  close() {
    this.#unsubscribe();
    if (this.#scheduled) clearImmediate(this.#scheduled);
  }
}
