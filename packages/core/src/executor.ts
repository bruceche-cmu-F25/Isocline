/** Drives runs through an engine. The engine is a replaceable part: it gets
 * the goal, bounded context and the tools of the run's profile, never ids or
 * lifecycle. Code decides which tools a profile gets, not the model.
 *
 * Around every tool call the executor records a step, so devices can show
 * what Alfred is doing; a tool that needs the user's permission is asked for
 * first, once, for exactly that call.
 */
import { existsSync } from "node:fs";
import { withCoreContext } from "./context.ts";
import { getConversation, updateConversation, type ThinkingLevel } from "./conversations.ts";
import { getProject, listProjects, type SessionMode } from "./projects.ts";
import { commandAllowed, grantCommand, listCommandGrants, simpleCommand, normalizeCommand } from "./shell.ts";
import { appendEvent, recordDomainEvent } from "./events.ts";
import { listRunFiles, type FileInfo } from "./files.ts";
import { newId } from "./ids.ts";
import { getSettings } from "./settings.ts";
import { completionNotification } from "./result-delivery.ts";
import {
  claimNextRun, conversationBefore, finishRun, heartbeatRun, openRequest, RUN_LEASE_MS, runAnswers, sweepRuns,
  type Run, type RunRequest, type ViewContext,
} from "./runs.ts";
import type { World } from "./world.ts";

/** What a tool may ask of the run it is part of. */
export interface RunToolContext {
  /** Stops the run until the user answers; resolves with the answer. */
  ask(request: { kind?: RunRequest["kind"]; question: string; options?: string[] }): Promise<string>;
  /** Records a moment in the run that is not a change to the world (e.g. `view`). */
  note(kind: string, payload: Record<string, unknown>): void;
  /** For a tool that runs a shell command in a development session (a background process): whether it may, asked
   * the way the engine's own shell asks (shown whole; a plain command can be allowed for the session, and one that
   * was runs without asking). Absent outside a session; `deny` in plan mode. */
  command?(question: string, command: string): Promise<"allow" | "deny">;
}

/** A tool as an engine sees it. `parameters` is a JSON Schema object. */
export interface RunTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Returns the text the model reads back. Throws on failure. */
  /** Engines call it with (params, signal); the executor supplies the context. */
  execute(params: Record<string, unknown>, signal: AbortSignal, context?: RunToolContext): Promise<string> | string;
  /** Set for tools the user must allow each time: describes this call, in the user's words. */
  permission?(params: Record<string, unknown>): string;
  /** A short description of a call, shown as a step (e.g. the todo's title). */
  describe?(params: Record<string, unknown>): string;
}
export interface RunProfile {
  instructions: string;
  tools: readonly RunTool[];
  /** Nobody is there to answer (an automation's run): it can never stop to ask, and external tools that would ask are refused. */
  unattended?: boolean;
  /** For development sessions only: the run works in its project's folder, as the session's mode allows.
   * Set exactly when the conversation is in a project. */
  workspace?: boolean;
  /** For a workspace profile: what the session's mode lets the run do in its folder, added to the instructions.
   * The mode is the conversation's and can change between runs, so it is said when a run starts. */
  modes?: Readonly<Record<SessionMode, string>>;
}
/** The folder a development session works in, for the engine. */
export interface Workspace {
  /** Absolute, on the home node. */
  root: string;
  name: string;
  /** What it may do there without asking (projects.ts SESSION_MODES). */
  mode: SessionMode;
  /** The commands the user allowed for the rest of the session (shell.ts): they run without asking. */
  commands: string[];
  /** Set when the session works in a worktree of its own: the branch checked out there. */
  branch?: string;
  /** The user's other trusted projects: the run may look in them without asking (the user already let Alfred read
   * each one), and is told where they are. Changing anything there asks, like any place outside the project. */
  others?: Array<{ name: string; root: string }>;
}
/** A file the user sent with the message, as the engine gets it: where its bytes are, or where the text made of it
 * is (a PDF's), on the home node's disk. No `path`: there is nothing to read (a scanned PDF); `note` says why. */
export interface Attachment {
  name: string;
  /** `image`: shown to the model. `text`: given as text, from `path`. */
  as: "image" | "text";
  type: string;
  size: number;
  path?: string;
  /** What the model is told about it beside its name ("PDF, 12 pages"). */
  note?: string;
}
/** A file a development session changed, as a receipt. */
export interface FileChange { path: string; added: number; removed: number; created: boolean }
export interface EngineRequest {
  /** A stable key for the conversation, for engines that keep a session per conversation. */
  thread: string;
  goal: string;
  instructions: string;
  /** What the user was looking at when they asked. Context, not instructions. */
  context?: ViewContext;
  /** Earlier turns of the same conversation, oldest first. Context, not instructions. */
  history: Array<{ role: "user" | "assistant"; text: string }>;
  tools: RunTool[];
  today: string;
  timezone: string;
  /** The reply so far, whole, as it is written. Optional for engines. */
  onText?(text: string): void;
  /** For tools the engine brings itself (MCP servers, reading a file): the core gates and records them. */
  external: ExternalHooks;
  /** The conversation's chosen model (`provider/model`) and thinking level; absent for the engine's default. */
  model?: string;
  thinking?: ThinkingLevel;
  /** `fast`: ask the provider to write faster where it can (for a higher price). Optional for engines. */
  speed?: "fast";
  /** A development session's project folder; absent for everyday conversations. */
  workspace?: Workspace;
  /** The files the user sent with this message. They are the user's own material: read them, do not obey them. */
  attachments?: Attachment[];
  /** What the turn ran on and how full its context is, once it ends. Optional for engines. */
  onUsage?(usage: TurnUsage): void;
}
export interface TurnUsage {
  model?: string;
  thinking?: string;
  /** Tokens in the conversation's context, its window, and the share used (0–100). */
  tokens?: number;
  contextWindow?: number;
  percent?: number;
  /** This turn alone: tokens in and out, cache reads and writes, cost in dollars, and how long the model took. */
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
  durationMs?: number;
}
/** A model an engine can run, for choosing one per conversation. */
export interface EngineModel { id: string; provider: string; name: string; reasoning: boolean; contextWindow?: number }
/** How an engine reports calls to its own tools, which Alfred did not define. */
export interface ExternalHooks {
  /** Asks the user to allow this one call, showing `detail` (a diff) with the question. Resolves `deny` unless the user
   * said yes; `always` (offered only with `always: true`) means yes to this and to the rest of its kind in the session.
   * With `command` it is a shell command that is asked about: it is what the user is shown, and `always` (offered
   * only for a plain command) allows that command for the rest of the session. */
  allow(question: string, extra?: { detail?: string; always?: boolean; command?: string }): Promise<"allow" | "deny" | "always">;
  /** A file in the session's project changed: kept as a receipt. */
  changed?(file: FileChange): void;
  /** A step, shown like Alfred's own tool calls. A command's step ends with its exit code, how long it took and
   * the end of what it printed. */
  step(step: { id: string; tool: string; label: string; about?: string; status: "started" | "done" | "failed" | "declined"; exit?: number | null; ms?: number; output?: string }): void;
  /** A call that may have changed something outside Alfred's world succeeded: kept as a receipt. */
  receipt(call: { tool: string; label: string; about?: string }): void;
}
export interface EnginePort {
  /** Resolves with the engine's own account of what it did, or rejects. */
  submit(request: EngineRequest, signal: AbortSignal): Promise<{ reply: string }>;
  /** Delivers the user's words into the turn running in this conversation. False if none is running. */
  steer?(thread: string, text: string): Promise<boolean>;
  /** The models the user can run. */
  models?(): Promise<EngineModel[]>;
}
/** Not recorded: what a device may show while a run works. */
export interface LiveUpdate { runId: string; conversationId: string; text: string }
export interface ExecuteOptions {
  owner: string;
  profiles: Readonly<Record<string, RunProfile>>;
  leaseMs?: number;
  heartbeatMs?: number;
  /** Where a run's files are for the engine (the home node keeps the bytes). Left out, files are not passed on. */
  attach?: (files: readonly FileInfo[]) => Attachment[];
  /** For the operator's log. The run itself keeps only a short code. */
  onEngineError?: (run: Run, error: unknown) => void;
  onLive?: (update: LiveUpdate) => void;
}

class Stop extends Error {
  readonly reason: "cancel" | "lease";
  constructor(reason: "cancel" | "lease") { super(reason); this.reason = reason; }
}

export function localDate(at: Date = new Date()): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

const DENIED = "The user did not allow this. Nothing was changed; do not try it another way.";

/** Returns the finished run, or the run as it stood when this executor lost
 * its lease (it then writes nothing more; the sweep records the interruption).
 */
async function drive(world: World, run: Run, engine: EnginePort, options: ExecuteOptions, finishSteering?: () => Promise<void>): Promise<Run> {
  const leaseMs = options.leaseMs ?? RUN_LEASE_MS;
  const profile = Object.hasOwn(options.profiles, run.profile) ? options.profiles[run.profile] : undefined;
  if (!profile) return finishRun(world, run.id, options.owner, { status: "failed", error: "unknown_profile" });
  const conversation = getConversation(world, run.conversationId);
  // A development session runs only with a workspace profile, and only while its project is there and trusted.
  if (!!profile.workspace !== !!conversation.projectId) return finishRun(world, run.id, options.owner, { status: "failed", error: "wrong_profile" });
  let workspace: Workspace | undefined;
  if (conversation.projectId) {
    const project = (() => { try { return getProject(world, conversation.projectId!); } catch { return null; } })();
    if (!project?.trustedAt) return finishRun(world, run.id, options.owner, { status: "failed", error: "project_unavailable" });
    // A session started in a worktree works there; once that worktree is gone (archived), it works nowhere.
    if (conversation.worktree && !existsSync(conversation.worktree)) return finishRun(world, run.id, options.owner, { status: "failed", error: "worktree_missing" });
    workspace = {
      root: conversation.worktree ?? project.path, name: project.name, mode: conversation.mode ?? "plan",
      commands: listCommandGrants(world, conversation.id).map((grant) => grant.command),
      ...(conversation.branch ? { branch: conversation.branch } : {}),
    };
    const others = listProjects(world).filter((other) => other.trustedAt && other.id !== project.id).slice(0, 40).map((other) => ({ name: other.name, root: other.path }));
    if (others.length) workspace.others = others;
  }

  const context = { actor: "alfred" as const, run: { id: run.id, owner: options.owner } };
  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    try {
      if (heartbeatRun(world, run.id, options.owner, { leaseMs }).cancelRequested) controller.abort(new Stop("cancel"));
    } catch {
      controller.abort(new Stop("lease"));
    }
  }, options.heartbeatMs ?? Math.floor(leaseMs / 3));
  // A heartbeat alone never keeps the process alive.
  heartbeat.unref();

  const note = (kind: string, payload: Record<string, unknown>) => {
    try {
      world.tx((db) => appendEvent(db, { kind: `run.${kind}`, subject: `run:${run.id}`, runId: run.id, actor: "alfred", payload }));
    } catch { /* a note is not worth failing the run */ }
  };
  /** Who gave the latest answer (`home`, or a paired device): an `always` is that device's to have given. */
  let answeredBy = "home";
  const ask = (request: Parameters<RunToolContext["ask"]>[0] & { detail?: string; detailKind?: "command"; grant?: string; always?: boolean }): Promise<string> => {
    // Unattended: a question would wait for no one. The profile offers no tool that asks; this is the backstop.
    if (profile.unattended) return Promise.reject(new Error("This run is unattended: nobody can answer. Propose the change instead."));
    const opened = openRequest(world, run.id, options.owner, {
      kind: request.kind ?? "input", question: request.question, options: request.options,
      detail: request.detail, detailKind: request.detailKind, grant: request.grant, always: request.always,
    });
    return new Promise<string>((resolve, reject) => {
      const onAnswer = (runId: string, requestId: string, answer: string, by: string | undefined) => {
        if (runId !== run.id || requestId !== opened.id) return;
        cleanup();
        answeredBy = by ?? "home";
        resolve(answer);
      };
      const onAbort = () => { cleanup(); reject(controller.signal.reason); };
      const cleanup = () => { runAnswers.off("answer", onAnswer); controller.signal.removeEventListener("abort", onAbort); };
      runAnswers.on("answer", onAnswer);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
  };
  const toolContext: RunToolContext = { ask, note };
  const external: ExternalHooks = {
    allow: async (question, extra) => {
      if (profile.unattended) return "deny";
      if (extra?.command !== undefined) {
        // A shell command: only in a session, shown whole; a plain one can be allowed for the rest of the session.
        if (!workspace) return "deny";
        const plain = simpleCommand(extra.command);
        const answer = await ask({ kind: "permission", question, detail: extra.command, detailKind: "command", always: plain, ...(plain ? { grant: normalizeCommand(extra.command) } : {}) });
        if (answer === "always" && plain) {
          try { withCoreContext({ actor: "user" }, () => grantCommand(world, conversation.id, extra.command!, answeredBy)); } catch { /* the run goes on */ }
        }
        return answer === "allow" || answer === "always" ? answer : "deny";
      }
      const answer = await ask({ kind: "permission", question, detail: extra?.detail, always: extra?.always && !!workspace });
      // "Don't ask again" in a session: its mode becomes `edits`, from now on.
      if (answer === "always" && workspace) {
        try { withCoreContext({ actor: "user" }, () => updateConversation(world, conversation.id, { mode: "edits" })); } catch { /* the run goes on */ }
      }
      return answer === "allow" || answer === "always" ? answer : "deny";
    },
    changed: (file) => {
      withCoreContext(context, () => world.tx(() => recordDomainEvent(world, {
        kind: "file.changed", subject: `file:${file.path}`.slice(0, 160),
        payload: { path: file.path.slice(0, 500), added: file.added, removed: file.removed, created: file.created },
      })));
    },
    step: (step) => note("step", {
      step: step.id, tool: step.tool, label: step.label, about: step.about?.slice(0, 200), status: step.status,
      ...(step.exit !== undefined ? { exit: step.exit } : {}), ...(step.ms !== undefined ? { ms: step.ms } : {}),
      ...(step.output ? { output: step.output.slice(-8000) } : {}),
    }),
    receipt: (call) => {
      // Under the run's lease, like any change: a lapsed executor records nothing.
      withCoreContext(context, () => world.tx(() => recordDomainEvent(world, {
        kind: "external.called", subject: `tool:${call.tool}`.slice(0, 160), payload: { tool: call.tool, label: call.label, about: call.about?.slice(0, 200) },
      })));
    },
  };

  if (workspace) {
    const shell = workspace;
    toolContext.command = async (question, command) => {
      if (shell.mode === "plan") return "deny";
      // Read now, not when the run started: a yes given earlier in this run counts.
      if (commandAllowed(listCommandGrants(world, conversation.id).map((grant) => grant.command), command)) return "allow";
      const answer = await external.allow(question, { command });
      return answer === "deny" ? "deny" : "allow";
    };
  }

  // Bind every tool to this run explicitly, so its writes are fenced by the
  // run's lease even if an engine loses the async context, and record each call.
  const tools = profile.tools.map((tool): RunTool => ({
    ...tool,
    execute: async (params, signal) => {
      const step = newId();
      const about = (() => { try { return tool.describe?.(params)?.slice(0, 200); } catch { return undefined; } })();
      if (tool.permission) {
        const answer = await ask({ kind: "permission", question: tool.permission(params) });
        if (answer !== "allow") {
          note("step", { step, tool: tool.name, label: tool.label, about, status: "declined" });
          return DENIED;
        }
      }
      note("step", { step, tool: tool.name, label: tool.label, about, status: "started" });
      try {
        const result = await withCoreContext(context, () => tool.execute(params, signal, toolContext));
        note("step", { step, tool: tool.name, label: tool.label, about, status: "done" });
        return result;
      } catch (error) {
        note("step", { step, tool: tool.name, label: tool.label, about, status: "failed" });
        throw error;
      }
    },
  }));
  // The conversation's own choice, else the user's default model and thinking (settings).
  const preferred = getSettings(world);
  const model = conversation.model ?? preferred.model, thinking = conversation.thinking ?? preferred.thinking;
  const files = options.attach ? listRunFiles(world, [run.id])[run.id] ?? [] : [];
  const attachments = files.length ? options.attach!(files) : [];
  const request: EngineRequest = {
    ...(workspace ? { workspace } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(conversation.speed ? { speed: conversation.speed } : {}),
    onUsage: (usage) => note("usage", { ...usage }),
    thread: run.conversationId,
    goal: run.goal,
    ...(run.context ? { context: run.context } : {}),
    instructions: workspace && profile.modes ? `${profile.instructions}\n\n${profile.modes[workspace.mode]}` : profile.instructions,
    history: conversationBefore(world, run),
    tools,
    today: localDate(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    onText: options.onLive ? (text) => options.onLive!({ runId: run.id, conversationId: run.conversationId, text }) : undefined,
    external,
  };
  try {
    // An engine that finished despite a cancel request reports what it actually did.
    const { reply } = await withCoreContext(context, () => engine.submit(request, controller.signal));
    await finishSteering?.();
    return finishRun(world, run.id, options.owner, { status: "completed", reply });
  } catch (error) {
    const stop = controller.signal.reason instanceof Stop ? controller.signal.reason.reason : null;
    if (!stop) options.onEngineError?.(run, error);
    if (stop === "lease") return { ...run, state: "interrupted" };
    try {
      await finishSteering?.();
      return finishRun(world, run.id, options.owner, stop === "cancel" ? { status: "cancelled" } : { status: "failed", error: errorCode(error) });
    } catch {
      return { ...run, state: "interrupted" };
    }
  } finally {
    clearInterval(heartbeat);
  }
}

/** The oldest startable queued run, or null when there is none. */
export async function executeNextRun(world: World, engine: EnginePort, options: ExecuteOptions): Promise<Run | null> {
  const run = claimNextRun(world, options.owner, { leaseMs: options.leaseMs });
  return run ? drive(world, run, engine, options) : null;
}

/** One drain per home node. Conversations run side by side, up to
 * `concurrency` engines at once; inside one conversation, runs go in order.
 * A run waiting for the user does not hold an engine slot. The queue lives in
 * the world, so a restart loses nothing.
 */
export interface RunDrain {
  kick(): Promise<void>;
  /** Delivers the user's words into a running run. False when it is not running here or the engine cannot. */
  steer(runId: string, text: string): Promise<boolean>;
}

export function createRunDrain(world: World, engine: EnginePort, options: ExecuteOptions & { concurrency?: number }): RunDrain {
  const concurrency = options.concurrency ?? 3;
  const active = new Map<string, Promise<unknown>>();
  const steering = new Map<string, Set<Promise<boolean>>>();
  const working = () => (world.db.prepare(`SELECT count(*) AS n FROM core_runs WHERE lease_owner = ? AND state IN ('running', 'cancelling')`)
    .get(options.owner)!.n as number);

  const pump = () => {
    if (!world.db.isOpen) return; // the home node is shutting down
    sweepRuns(world);
    while (working() < concurrency) {
      const run = claimNextRun(world, options.owner, { leaseMs: options.leaseMs });
      if (!run) break;
      const pending = new Set<Promise<boolean>>();
      steering.set(run.id, pending);
      const job = drive(world, run, engine, options, async () => {
        // An accepted last-minute steer can change the destination of the result.
        steering.delete(run.id);
        await Promise.allSettled(pending);
      })
        .catch((error: unknown) => options.onEngineError?.(run, error))
        .finally(() => { steering.delete(run.id); active.delete(run.id); pump(); });
      active.set(run.id, job);
    }
  };
  // An answered run is working again and may hold an engine slot; only this
  // drain's own runs concern it.
  runAnswers.on("answer", (runId) => { if (active.has(runId)) setImmediate(pump); });
  return {
    async kick() {
      pump();
      while (active.size) await Promise.race(active.values());
    },
    async steer(runId, text) {
      const words = text.trim().slice(0, 8000);
      const pending = steering.get(runId);
      if (!words || !pending || !engine.steer) return false;
      const run = world.db.prepare("SELECT state, conversation_id FROM core_runs WHERE id = ?").get(runId);
      // A run waiting on a question takes an answer, not more words.
      if (!run || run.state !== "running") return false;
      const accepted = engine.steer(String(run.conversation_id), words).then((ok) => {
        if (ok) world.tx((db) => appendEvent(db, { kind: "run.steered", subject: `run:${runId}`, runId, actor: "user",
          payload: { text: words.slice(0, 2000), notifyOnCompletion: completionNotification(words) } }));
        return ok;
      });
      pending.add(accepted);
      try { return await accepted; }
      finally { pending.delete(accepted); }
    },
  };
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.name === "RunLeaseLostError") return "lease_lost";
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return "timeout";
  if (error instanceof Error && error.name === "EngineUnavailableError") return "engine_unavailable";
  if (error instanceof Error && error.name === "EngineCrashedError") return "engine_crashed";
  return "engine_failed";
}
