/** The harness's own device commands: what a device asks of Isocline itself, outside any module. Its settings, the
 * user's automations, their decisions on proposals, conversations and sessions, projects, and what becomes of a run.
 *
 * Each is an operation in the module contract's sense (a name, an input that is checked, one change to the world),
 * and `command` runs it the way a module's operation is run (module-kit `runOp`): at most once per request id, and
 * recorded as the user's. So the rules of a device's command are in one place, whatever the command; http.ts only
 * says which address means which command.
 *
 * Three things a device sends are not here, because each already has rules of its own: a new run (replayed by its
 * request id in the runs themselves), an answer to a run's question (accepted once, for the question asked), and
 * words into a working run (they go to the engine, not the world).
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  acceptProposal, addProject, listRunReceipts, listRuns, commandReplay, CONVERSATION_MODEL, coreContext, createAutomation, declineProposal, deleteAutomation, getConversation, getProject,
  ProjectError, recordCommit, recordPublished, removeProject, requestCancel, resumeRun, revokeCommand, runAutomationNow, sessionRoot, startSession, submitRun, supersedeProposal, trustProject,
  addArea, addPreference, removePreference, updatePreference, moveArea, updateArea, updateAutomation, updateConversation, updateSettings, userLocale, withCoreContext, type Locale, type SessionMode, type Speed, type ThinkingLevel, type World,
} from "@isocline/core";
import { syncAssistantName } from "./assistant-name.ts";
import { applyStep, OpInputError, opInput, removeArea, runOp, Type, UnknownOpError, type Static, type TSchema } from "@isocline/module-kit";
import type { Home } from "./home.ts";
import { ASSISTANT_PROFILE, AUTOMATION_PROFILE, DEVELOPER_PROFILE } from "./profiles.ts";
import { branchName, checkoutSessionBranch, createWorktree, publish, releaseNewBranch, removeWorktree, restoreWorktree, snapshot, WorkspaceError, workspaceChanges, type ChangedFile } from "./workspace.ts";
import { reviewCommit } from "./commit-review.ts";

interface Extra<X> {
  /** The command's request id, for a command that starts a run of its own under it. */
  requestId: string;
  /** What `prepare` found. */
  prepared: X;
}

interface HarnessOp<P extends TSchema = TSchema, X = undefined> {
  /** `<what>.<verb>`, as the command is recorded. */
  name: string;
  input: P;
  /** May come without a request id: devices from before it took one send none. It is then done, but a retry of it
   * cannot be told from a second command. */
  unnumbered?: boolean;
  /** What must happen before the change and cannot happen inside a transaction (reading a repository). Not done
   * again when the command is a replay. */
  prepare?(home: Home, input: Static<P>): Promise<X>;
  /** Release a checkout if the database fails to record the prepared command. */
  rollback?(prepared: X): Promise<void>;
  /** The change. Synchronous; it runs inside the command's transaction. Returns JSON. */
  run(home: Home, input: Static<P>, extra: Extra<X>): unknown;
}
const define = <P extends TSchema, X = undefined>(op: HarnessOp<P, X>): HarnessOp => op as unknown as HarnessOp;

/** The profile a new run in this conversation gets: a development session's, or the assistant's. A session whose
 * project was removed or is no longer trusted takes no new requests. */
export function profileFor(world: World, conversationId: string | undefined | null): string {
  if (!conversationId) return ASSISTANT_PROFILE;
  const { projectId } = getConversation(world, conversationId);
  if (!projectId) return ASSISTANT_PROFILE;
  if (!getProject(world, projectId).trustedAt) throw new ProjectError("untrusted");
  return DEVELOPER_PROFILE;
}

/** The files a session's runs changed, from their receipts, oldest first. */
export function sessionWrites(home: Home, conversationId: string): ChangedFile[] {
  const runs = listRuns(home.world, { conversationId, limit: 500 }).reverse();
  const receipts = listRunReceipts(home.world, runs.map((run) => run.id));
  return runs.flatMap((run) => receipts[run.id] ?? []).filter((event) => event.kind === "file.changed").map((event) => ({
    path: String(event.payload.path), added: Number(event.payload.added) || 0, removed: Number(event.payload.removed) || 0, created: event.payload.created === true,
  }));
}

const Id = Type.String({ minLength: 1, maxLength: 64 });
const Patch = Type.Record(Type.String(), Type.Unknown());
const Said = Type.String({ pattern: "\\S" });

const OPS: readonly HarnessOp[] = [
  // Preferences that are not secrets (the language, the default model). What a patch may hold is the core's to say.
  define({
    name: "settings.update", input: Type.Object({ patch: Patch }),
    run: (home, input) => { const settings = updateSettings(home.world, input.patch); syncAssistantName(home.world); return settings; },
  }),

  // Areas: the parts of life todos and topics belong to, the user's own list (Settings › General).
  define({
    name: "area.create", input: Type.Object({ name: Type.String(), k: Type.Optional(Type.String()) }),
    run: (home, input) => addArea(home.world, input),
  }),
  define({
    name: "area.update", input: Type.Object({ id: Id, patch: Type.Object({ name: Type.Optional(Type.String()), k: Type.Optional(Type.String()) }) }),
    run: (home, input) => updateArea(home.world, input.id, input.patch),
  }),
  define({
    name: "area.move", input: Type.Object({ id: Id, index: Type.Integer() }),
    run: (home, input) => moveArea(home.world, input.id, input.index),
  }),
  define({
    // What was in it goes to `moveTo`, or to no area; every module moves its own.
    name: "area.delete", input: Type.Object({ id: Id, moveTo: Type.Optional(Type.Union([Id, Type.Null()])) }),
    run: (home, input) => { removeArea(home.world, home.modules, input.id, input.moveTo ?? null); return {}; },
  }),

  // Preferences: what the user has said about how they like things (core preferences.ts). Isocline writes its own
  // through its tools; these are the user's hand.
  define({
    name: "preference.create", input: Type.Object({ text: Type.String() }),
    run: (home, input) => addPreference(home.world, { text: input.text, by: "user" }),
  }),
  define({
    name: "preference.update", input: Type.Object({ id: Id, text: Type.String() }),
    run: (home, input) => updatePreference(home.world, input.id, input.text),
  }),
  define({
    name: "preference.delete", input: Type.Object({ id: Id }),
    run: (home, input) => { removePreference(home.world, input.id); return {}; },
  }),

  // Automations: the user's own rules. Their runs are unattended.
  define({
    name: "automation.create",
    input: Type.Object({
      name: Type.Optional(Type.String()), goal: Type.Optional(Type.String()), schedule: Type.Unknown(), enabled: Type.Optional(Type.Boolean()),
      layout: Type.Optional(Type.String()), keep: Type.Optional(Type.String()), notify: Type.Optional(Type.String()), k: Type.Optional(Type.String()),
    }),
    run: (home, input) => createAutomation(home.world, input),
  }),
  define({
    name: "automation.update", input: Type.Object({ id: Id, patch: Patch }),
    run: (home, input) => updateAutomation(home.world, input.id, input.patch),
  }),
  define({
    name: "automation.delete", input: Type.Object({ id: Id }),
    run: (home, input) => { deleteAutomation(home.world, input.id); return {}; },
  }),
  define({
    name: "automation.run", input: Type.Object({ id: Id }),
    run: (home, input, { requestId }) => runAutomationNow(home.world, input.id, requestId, { profile: AUTOMATION_PROFILE }),
  }),

  // The user's decisions on proposals.
  define({
    name: "proposal.accept", input: Type.Object({ id: Id }),
    // The steps are Isocline's changes, made on the user's yes to this proposal (the context keeps which one).
    run: (home, input) => ({
      proposal: acceptProposal(home.world, input.id, (step) => withCoreContext({ ...coreContext(), actor: "alfred" }, () => applyStep(home.world, home.modules, step))),
    }),
  }),
  define({
    name: "proposal.decline", input: Type.Object({ id: Id }),
    run: (home, input) => ({ proposal: declineProposal(home.world, input.id) }),
  }),
  define({
    // `context`: the page it was changed from and what was picked there (a mail), so that page can show the new version
    // being written where the old one was.
    name: "proposal.revise", input: Type.Object({ id: Id, text: Said, context: Type.Optional(Type.Unknown()) }),
    // The proposal is superseded, and a run in its conversation is asked to propose again with the change.
    run(home, input, { requestId }) {
      const superseded = supersedeProposal(home.world, input.id, input.text);
      // The whole of each step (an email's text), so the new version starts from what the user saw.
      const steps = superseded.steps.map((step) => (step.detail ? `${step.preview}\n${step.detail}` : step.preview));
      const revise: Record<Locale, () => string> = {
        zh: () => `修改你之前的提议「${superseded.title}」：${input.text.trim()}\n原来的提议：${superseded.summary}\n步骤：${steps.join("；")}\n请按修改意见重新提议（用 propose），不要直接改。`,
        en: () => `Change your earlier proposal "${superseded.title}": ${input.text.trim()}\nThe proposal was: ${superseded.summary}\nSteps: ${steps.join("; ")}\nPropose again with the change (use propose); do not make the changes directly.`,
      };
      const goal = revise[userLocale(home.world)]();
      const profile = profileFor(home.world, superseded.conversationId);
      const { run } = submitRun(home.world, {
        requestId: `${requestId}.revise`, goal, profile, conversationId: superseded.conversationId ?? undefined,
        ...(input.context !== undefined && profile === ASSISTANT_PROFILE ? { context: input.context } : {}),
      });
      return { proposal: superseded, run };
    },
  }),

  // Conversations. An everyday one starts with its first message (a run); a development session is started here.
  define({
    name: "conversation.start", unnumbered: true,
    input: Type.Object({
      projectId: Id, title: Said, mode: Type.Optional(Type.Union([Type.Literal("plan"), Type.Literal("ask"), Type.Literal("edits")])),
      model: Type.Optional(Type.Union([Type.String({ pattern: CONVERSATION_MODEL.source }), Type.Null()])),
      /** In a worktree of its own, on a new branch, instead of the project's folder. */
      worktree: Type.Optional(Type.Boolean()),
      branch: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    }),
    async prepare(home, input) {
      // Nothing runs in a folder, not even git, before the user has trusted it.
      const folder = getProject(home.world, input.projectId);
      if (!folder.trustedAt) throw new ProjectError("untrusted");
      if (input.worktree && input.branch) throw new OpInputError("Choose an existing branch or create a new one");
      const dir = home.worktreeDir(folder.id, randomBytes(6).toString("hex"));
      const made = input.branch ? await checkoutSessionBranch(folder.path, dir, input.branch)
        : input.worktree ? await createWorktree(folder.path, dir, branchName(input.title)) : null;
      return {
        projectPath: folder.path,
        createdFrom: made?.createdFrom,
        base: made?.base ?? await snapshot(folder.path),
        worktree: made ? { path: made.path, branch: made.branch } : null,
      };
    },
    async rollback(prepared) {
      if (!prepared.worktree) return;
      await removeWorktree(prepared.projectPath, prepared.worktree.path, false);
      if (prepared.createdFrom) await releaseNewBranch(prepared.projectPath, prepared.worktree.branch, prepared.createdFrom);
    },
    run: (home, input, { prepared }) => startSession(home.world, { projectId: input.projectId, title: input.title, mode: input.mode, model: input.model, base: prepared.base, worktree: prepared.worktree }),
  }),
  define({
    name: "conversation.update", unnumbered: true,
    input: Type.Object({
      id: Id, title: Type.Optional(Type.String()), archived: Type.Optional(Type.Boolean()),
      archiveRuns: Type.Optional(Type.Union([Type.Literal("finish"), Type.Literal("stop")])),
      model: Type.Optional(Type.Union([Type.String(), Type.Null()])), thinking: Type.Optional(Type.Union([Type.String(), Type.Null()])), mode: Type.Optional(Type.String()),
      speed: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      /** A command allowed for the rest of the session, taken back: it asks again. */
      forgetCommand: Type.Optional(Type.String({ maxLength: 300 })),
      /** Archiving a session whose worktree has uncommitted changes: `keep` leaves the folder as it is, `discard`
       * removes it with them. Without one, that archive is refused (`git_dirty`, with the count) for the user to choose. */
      worktree: Type.Optional(Type.Union([Type.Literal("keep"), Type.Literal("discard")])),
    }),
    // A session that leaves: its processes and terminal stop, and its worktree goes unless there is work in it.
    // One that comes back gets its worktree again, on its branch.
    async prepare(home, input) {
      if (input.archived === undefined) return;
      let conversation = getConversation(home.world, input.id);
      if (!conversation.projectId) return;
      if (input.archived) { await home.archives.request(input.id, input.archiveRuns, input.worktree); return; }
      if (conversation.archivePlan) {
        await home.archives.withdraw(input.id);
        conversation = getConversation(home.world, input.id);
      }
      if (conversation.archivedAt && conversation.worktree && conversation.branch && !existsSync(conversation.worktree)) {
        const project = (() => { try { return getProject(home.world, conversation.projectId!); } catch { return null; } })();
        if (project) await restoreWorktree(project.path, conversation.worktree, conversation.branch);
      }
    },
    // Which models, levels and modes there are is the core's to say.
    run: (home, input) => {
      if (input.forgetCommand !== undefined) revokeCommand(home.world, input.id, input.forgetCommand);
      return updateConversation(home.world, input.id, {
        title: input.title, archived: input.archived && getConversation(home.world, input.id).projectId ? undefined : input.archived, model: input.model,
        thinking: input.thinking as ThinkingLevel | null | undefined, speed: input.speed as Speed | null | undefined, mode: input.mode as SessionMode | undefined,
      });
    },
  }),

  // A development session's work, handed on: committed in its folder, then pushed with a pull request. The device
  // shows the user what is sent and asks each time before it sends `session.publish` (outward, not undone).
  define({
    name: "session.commit",
    input: Type.Object({ id: Id, message: Type.String({ pattern: "\\S", maxLength: 5000 }),
      paths: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 1000 }), token: Type.String({ pattern: "^[a-f0-9]{64}$" }) }),
    async prepare(home, input) {
      const conversation = getConversation(home.world, input.id);
      const root = sessionRoot(home.world, conversation);
      if (!root || !existsSync(root)) throw new WorkspaceError("not_git", "This session has no folder to commit in");
      const changes = await workspaceChanges(root, conversation.base, sessionWrites(home, conversation.id));
      const result = await reviewCommit(root, input.paths, changes.files.map((f) => f.path), {
        token: input.token, message: input.message.trim(), base: conversation.base,
      });
      return { commit: result.commit, base: result.base, files: new Set(input.paths).size };
    },
    run: (home, input, { prepared }) => recordCommit(home.world, input.id, { commit: prepared.commit, base: prepared.base, message: input.message, files: prepared.files }),
  }),
  define({
    name: "session.publish",
    input: Type.Object({ id: Id, title: Type.String({ pattern: "\\S", maxLength: 256 }), body: Type.Optional(Type.String({ maxLength: 20_000 })) }),
    async prepare(home, input) {
      const root = sessionRoot(home.world, getConversation(home.world, input.id));
      if (!root || !existsSync(root)) throw new WorkspaceError("not_git", "This session has no folder to push from");
      return publish(root, { title: input.title.trim(), body: input.body ?? "" });
    },
    run: (home, input, { prepared }) => ({ ...prepared, conversation: recordPublished(home.world, input.id, prepared) }),
  }),

  // Projects. http.ts lets only the home node's own machine send these: a folder path means something only there.
  define({
    name: "project.add", unnumbered: true, input: Type.Object({ path: Type.String(), name: Type.Optional(Type.String()) }),
    run: (home, input) => addProject(home.world, { path: input.path, name: input.name }),
  }),
  define({
    name: "project.trust", unnumbered: true, input: Type.Object({ id: Id }),
    run: (home, input) => trustProject(home.world, input.id),
  }),
  define({
    name: "project.remove", unnumbered: true, input: Type.Object({ id: Id }),
    run: (home, input) => { removeProject(home.world, input.id); return {}; },
  }),

  // What becomes of a run.
  define({
    name: "run.cancel", unnumbered: true, input: Type.Object({ id: Id }),
    run: (home, input) => requestCancel(home.world, input.id),
  }),
  define({
    name: "run.resume", unnumbered: true, input: Type.Object({ id: Id }),
    run: (home, input) => resumeRun(home.world, input.id),
  }),
];
const BY_NAME = new Map(OPS.map((op) => [op.name, op]));
// Multiple trusted project folders may refer to the same repository. Serialize session checkout and restore on
// the home node, covering the replay check through the database commit, so two phones cannot claim one branch.
const checkouts = new WeakMap<Home, Promise<unknown>>();

/** The names of the harness's commands. */
export const HARNESS_COMMANDS: readonly string[] = OPS.map((op) => op.name);

/**
 * A device's command to the harness. `sent` is the request's body (its `requestId` and the command's own fields);
 * `where` is what the address said (which automation, which run), and wins over the body.
 * Resolves with the command's result and whether it was a replay; throws what the operation throws.
 */
export async function command(home: Home, name: string, sent: Record<string, unknown>, where: Record<string, unknown> = {}): Promise<{ result: unknown; replayed: boolean }> {
  const op = BY_NAME.get(name);
  if (!op) throw new UnknownOpError(name);
  const { requestId: given, ...fields } = sent;
  if (given !== undefined && typeof given !== "string") throw new OpInputError("requestId must be text");
  if (given === undefined && !op.unnumbered) throw new OpInputError("requestId is required");
  const requestId = typeof given === "string" ? given : `home.${randomBytes(12).toString("hex")}`;
  const input = opInput(op, { ...fields, ...where }) as Record<string, unknown>;
  const execute = () => executeCommand(home, op, requestId, input);
  if (name !== "conversation.start" && !(name === "conversation.update" && input.archived === false)) return execute();
  const pending = (checkouts.get(home) ?? Promise.resolve()).then(execute, execute);
  checkouts.set(home, pending);
  try { return await pending; } finally { if (checkouts.get(home) === pending) checkouts.delete(home); }
}

async function executeCommand(home: Home, op: HarnessOp, requestId: string, input: Record<string, unknown>) {
  const done = commandReplay(home.world, { requestId, command: op.name, input });
  if (done) return { result: done.result, replayed: true };
  const release = op.name === "session.commit" || op.name === "session.publish" ? home.archives.beginWorkspaceOperation((input as { id: string }).id) : undefined;
  try {
    const prepared = op.prepare ? await op.prepare(home, input) : undefined;
    let outcome;
    try {
      outcome = runOp(home.world, { name: op.name, input: op.input, run: () => op.run(home, input, { requestId, prepared }) }, { requestId, input });
    } catch (error) {
      await op.rollback?.(prepared);
      throw error;
    }
    // Whatever it was, there may now be a run to start or an accepted change to send.
    home.kick();
    home.deliver();
    return outcome;
  } finally {
    release?.();
  }
}
