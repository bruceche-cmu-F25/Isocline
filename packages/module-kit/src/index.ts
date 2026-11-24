/** The module contract. A module is one piece of the user's life (todos, a
 * calendar, a daily brief): its business rules as operations, the agent tools
 * that reach them, its tables, and what devices need to draw it.
 *
 * Modules are first-party code with full Node privileges; installing one means
 * trusting its code. Third parties extend Isocline through MCP and skills instead.
 */
import {
  coreContext, getProposal, getRun, openProposal, runCommand, withCoreContext, type Actor, type Migration, type ProposalStep, type RunTool, type World,
  automationName, createAutomation, listAutomations, updateAutomation, userLocale, type AutomationView,
  addArea, deleteAreaRow, describeAreas, listAreas, type Area,
  addPreference, listPreferences, removePreference, MAX_PREFERENCE,
  claimOutbound, finishOutbound, retryOutbound, type Outbound,
} from "@isocline/core";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

export { Type, type Static, type TSchema };

/** What of the core a module may use: the world and its migrations, recording its own events, the shared areas of
 * life, the user's language, the outbound queue for changes outside Isocline, and amending its own proposed steps.
 * Modules import these from here, never from @isocline/core (packages/server/test/module-types.test.ts holds them to
 * it), so the core can change everything else, run internals included, without touching a module. */
export {
  type World, type Migration, type Locale, type Outbound, type Proposal,
  recordDomainEvent, changedFields, lastChangesOf, withDefaultActor, newId, localDate,
  isArea, unknownArea, areaName, describeAreas,
  userLocale, localeOf, localeTag, acceptLanguage,
  enqueueOutbound, listOutbound,
  getProposal, amendProposal, ProposalStateError,
} from "@isocline/core";

/** How much consent an operation needs (ARCHITECTURE.md §5.2). `external` changes something outside Isocline (the
 * user's Google Calendar, an email sent from their Gmail): a run never does it directly, it can only propose it. */
export const PERMISSION_LEVELS = ["read", "local", "batch", "irreversible", "external"] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];
/** What an unattended run may do without asking. */
export const RUN_LEVELS: readonly PermissionLevel[] = ["read", "local"];

/** A domain operation a device invokes directly (a click, an edit). It has no permission level: a device's own
 * command is the user's decision. Levels say what a run may do, and belong to tools. */
export interface ModuleOp<P extends TSchema = TSchema> {
  /** `<module>.<verb>`, for example `todo.complete`. */
  name: string;
  input: P;
  /** Synchronous: it opens its own world transaction. Returns JSON. */
  run(world: World, input: Static<P>): unknown;
}

/** An operation as an agent reaches it: described for a model, answered in text. */
export interface ModuleTool<P extends TSchema = TSchema> {
  /** `<module>_<verb>`, for example `todo_add`. */
  name: string;
  label: string;
  description: string;
  level: PermissionLevel;
  parameters: P;
  execute(world: World, params: Static<P>): string;
  /** What one call is about, shown as a step ("Hand in report"). */
  describe?(world: World, params: Static<P>): string;
  /** For `irreversible` tools: the question that asks the user to allow this one call. */
  confirm?(world: World, params: Static<P>): string;
  /**
   * For tools a run may propose instead of doing: the device operation this call stands for, pinned to the exact
   * records it names now (ids and revisions, not a title to search later), and the subjects it touches
   * (`todo:<id>`), so the proposal goes stale if they change. Tools without it cannot be proposed.
   */
  pin?(world: World, params: Static<P>): { op: string; input: unknown; subjects?: string[]; preview?: string; detail?: string } | { error: string };
}

/** A view a device can open for a module: a pane beside the conversation, or a page. */
export interface ModuleView {
  /** Unique within the module, e.g. `list`. */
  id: string;
  title: string;
}

export interface IsoclineModule {
  /** Lowercase; prefixes its ops, tools, event kinds and tables. */
  id: string;
  title: string;
  migrations: readonly Migration[];
  ops: readonly ModuleOp[];
  /** Reads a device makes that are too big for the snapshot (one mail's body). Not commands: nothing is recorded. */
  queries?: readonly ModuleQuery[];
  tools: readonly ModuleTool[];
  /** Views devices know how to draw from the snapshot. */
  views?: readonly ModuleView[];
  /** How a run should use this module's tools. Appended to the run's instructions. A function for words that depend
   * on the user's own data (their areas), read again for each run. */
  guidance?: string | ((world: World) => string);
  /** The user removed an area: move what of this module's was in it to `moveTo`, or to no area. Runs in the same
   * transaction as the removal (`removeArea`). */
  areaRemoved?(world: World, id: string, moveTo: string | null): void;
  /** A run has just proposed these steps (any module's), replacing the steps of `replaced` if it corrects earlier
   * proposals. A module may act on them at once (a proposed meeting goes on the todo list) and say what it did in
   * a line the run reads. */
  proposed?(world: World, proposal: { id: string; steps: readonly ProposalStep[]; replaced: readonly ProposalStep[] }): string | void;
  /** What a device needs to draw this module right now. JSON. */
  snapshot?(world: World): unknown;
  /** For a module that mirrors an outside service (a calendar, a mailbox): the home node calls `run` now and then,
   * and when a device asks for fresh data. It reads through `services` and writes its own tables; a failure is the
   * module's to record (say, per account) so its page can say what went wrong. Never called concurrently. */
  sync?: {
    everyMs: number;
    /** Event kinds after which a pass should run soon, not at the next scheduled one (a link was saved: look its
     * page up now). The module's own events, usually. */
    onEvents?: readonly string[];
    run(world: World, services: ModuleServices, signal: AbortSignal): Promise<void>;
  };
  /** A small file the module keeps and a device shows (a site's icon): GET /api/modules/<id>/files/<name>. Only
   * images are served, as the bytes say they are; null when there is none by that name. */
  file?(world: World, name: string): { type: string; bytes: Uint8Array } | null;
  /** For a module that changes an outside service (adds an event, sends an email): how ONE accepted change is
   * delivered. The module only says how it went; the queue is not its business. The home node takes each change
   * waiting for the module (core outbound.ts), calls this, and records the ending (`deliverQueued`). It may throw a
   * ServiceError instead of answering. Never called concurrently for one module. */
  deliver?(world: World, outbound: Outbound, services: ModuleServices, signal: AbortSignal): Promise<Delivered>;
}

/** How one delivery went, as the module that made it knows. */
export type Delivered =
  | { state: "done"; result?: unknown }
  /** The service refused, or the user took the permission away: it did not happen, and trying again would not help. */
  | { state: "failed"; error: string }
  /** No clear answer: the service could not be reached, or answered with an error of its own. It may or may not
   * have happened. What that means is the queue's rule, not the module's: a change that is safe to deliver again
   * waits for the next pass; one that is not (an email) is marked unknown, and the user is asked to check. */
  | { state: "unclear"; error: string };

/** The outside services the user has connected, as the home node hands them to modules' syncs. */
export interface ModuleServices {
  google?: GoogleService;
}

/** Google, for reading: the accounts the user connected (ones that need reconnecting are left out), and a session
 * per account that makes authorised GETs. One session per pass: getting it may refresh the account's token. */
export interface GoogleService {
  accounts(includeBroken?: boolean): Array<{ email: string; capabilities: readonly string[] }>;
  session(email: string): Promise<GoogleSession>;
}
export interface GoogleSession {
  /** A read; throws ServiceError unless Google answers 2xx. */
  get(url: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  /** A change. Answers whatever status Google gave (a 409 or 412 means something to the caller); throws ServiceError
   * only when Google could not be asked or refused the account (401). */
  send(method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, body?: unknown, options?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<{ status: number; body: Record<string, unknown> }>;
}

/** Why an outside service could not be read: `reconnect` (the user must sign in again in Settings) or `unavailable`. */
export class ServiceError extends Error {
  override name = "ServiceError";
  readonly code: "reconnect" | "unavailable";
  readonly status?: number;
  constructor(code: "reconnect" | "unavailable", message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** The services as one pass sees them: an account's session is got once and shared by every change in the pass
 * (getting one may refresh the account's token). */
function forOnePass(services: ModuleServices): ModuleServices {
  const google = services.google;
  if (!google) return services;
  const sessions = new Map<string, Promise<GoogleSession>>();
  return {
    ...services,
    google: {
      accounts: (includeBroken) => google.accounts(includeBroken),
      session(email) {
        let session = sessions.get(email);
        if (!session) sessions.set(email, session = google.session(email));
        return session;
      },
    },
  };
}

/** One pass over the changes waiting for `module`: each is claimed, handed to the module's `deliver`, and ended as
 * the module says, oldest first, once per pass (one that must wait is tried again in a later pass, not this one).
 * A ServiceError thrown instead of an answer is read the same way for every module: `reconnect` means the account
 * no longer lets Isocline in, so it did not happen; anything else is unclear. Stops between changes when `signal`
 * says the home node is closing. Returns how many changes it handled. */
export async function deliverQueued(world: World, module: IsoclineModule, services: ModuleServices, signal: AbortSignal = new AbortController().signal): Promise<number> {
  if (!module.deliver) return 0;
  const pass = forOnePass(services);
  const tried = new Set<string>();
  for (;;) {
    if (signal.aborted) break;
    const outbound = claimOutbound(world, module.id, tried);
    if (!outbound) break;
    tried.add(outbound.id);
    let outcome: Delivered;
    try {
      outcome = await module.deliver(world, outbound, pass, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = error instanceof ServiceError && error.code === "reconnect" ? { state: "failed", error: message } : { state: "unclear", error: message };
    }
    if (outcome.state === "unclear") retryOutbound(world, outbound.id, outcome.error);
    else finishOutbound(world, outbound.id, outcome);
  }
  return tried.size;
}

/** A read a device makes on demand (POST /api/queries/<name>): `<module>.<noun>`, synchronous, changes nothing. */
export interface ModuleQuery<P extends TSchema = TSchema> {
  name: string;
  input: P;
  run(world: World, input: Static<P>): unknown;
}
export const defineQuery = <P extends TSchema>(query: ModuleQuery<P>): ModuleQuery => query as unknown as ModuleQuery;

/** Answers a device's query; the input is checked like an op's. */
export function runQuery(modules: readonly IsoclineModule[], world: World, name: string, input: unknown): unknown {
  const query = modules.flatMap((module) => module.queries ?? []).find((candidate) => candidate.name === name);
  if (!query) throw new UnknownOpError(name);
  return query.run(world, checked(query.input, input ?? {}, `input for ${query.name}`));
}

/** Keeps each op's and tool's parameter types while building a module. */
export const defineOp = <P extends TSchema>(op: ModuleOp<P>): ModuleOp => op as unknown as ModuleOp;
export const defineTool = <P extends TSchema>(tool: ModuleTool<P>): ModuleTool => tool as unknown as ModuleTool;

export function defineModule(module: IsoclineModule): IsoclineModule {
  if (!/^[a-z][a-z0-9]{0,31}$/.test(module.id)) throw new Error(`Invalid module id: ${module.id}`);
  for (const migration of module.migrations) {
    if (!migration.id.startsWith(`${module.id}:`)) throw new Error(`Migration ${migration.id} must be named ${module.id}:<n>`);
  }
  for (const op of module.ops) {
    if (!op.name.startsWith(`${module.id}.`)) throw new Error(`Op ${op.name} must be named ${module.id}.<verb>`);
  }
  for (const query of module.queries ?? []) {
    if (!query.name.startsWith(`${module.id}.`)) throw new Error(`Query ${query.name} must be named ${module.id}.<noun>`);
  }
  for (const tool of module.tools) {
    if (!tool.name.startsWith(`${module.id}_`)) throw new Error(`Tool ${tool.name} must be named ${module.id}_<verb>`);
  }
  return module;
}

export class OpInputError extends Error {
  override name = "OpInputError";
}

function checked<P extends TSchema>(schema: P, input: unknown, what: string): Static<P> {
  if (Value.Check(schema, input)) return input as Static<P>;
  const first = [...Value.Errors(schema, input)][0];
  throw new OpInputError(`Invalid ${what}${first ? `: ${first.instancePath || "input"} ${first.message}` : ""}`);
}

export class UnknownOpError extends Error {
  override name = "UnknownOpError";
  constructor(name: string) { super(`No such operation: ${name}`); }
}

/** An operation's input as a device sent it, checked against the operation's schema. */
export function opInput<P extends TSchema>(op: Pick<ModuleOp<P>, "name" | "input">, input: unknown): Static<P> {
  return checked(op.input, input ?? {}, `input for ${op.name}`);
}

/** Runs one operation as a device's command, and this is the only way one is run: its input is checked, it happens
 * at most once per request id (core `runCommand`), and what it changes is recorded as the user's (or `actor`'s).
 * A module's operations and the harness's own (server commands.ts) both come through here. */
export function runOp(world: World, op: ModuleOp, request: { requestId: string; input: unknown; actor?: Actor }): { result: unknown; replayed: boolean } {
  const input = opInput(op, request.input);
  return withCoreContext({ actor: request.actor ?? "user" }, () =>
    runCommand(world, { requestId: request.requestId, command: op.name, input }, () => op.run(world, input)));
}

/** A device's command to a module, by the operation's name. */
export function invokeOp(
  world: World,
  modules: readonly IsoclineModule[],
  request: { op: string; requestId: string; input: unknown; actor?: Actor },
): { result: unknown; replayed: boolean } {
  const op = modules.flatMap((module) => module.ops).find((candidate) => candidate.name === request.op);
  if (!op) throw new UnknownOpError(request.op);
  return runOp(world, op, request);
}

/** The tools a run may use, bound to the world. Code decides this, never the
 * model: `levels` run directly; `askFor` levels run only after the user allows
 * each call (the core asks). Everything else is not offered at all.
 */
export function runTools(
  world: World,
  modules: readonly IsoclineModule[],
  policy: { levels?: readonly PermissionLevel[]; askFor?: readonly PermissionLevel[] } = {},
): RunTool[] {
  const levels = policy.levels ?? RUN_LEVELS;
  const askFor = policy.askFor ?? ["irreversible"];
  return modules.flatMap((module) => module.tools).filter((tool) => levels.includes(tool.level) || askFor.includes(tool.level)).map((tool) => {
    const parse = (params: Record<string, unknown>) => checked(tool.parameters, params, `parameters for ${tool.name}`);
    const safely = (text: () => string | undefined) => { try { return text(); } catch { return undefined; } };
    const runTool: RunTool = {
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters as unknown as Record<string, unknown>,
      execute: (params) => tool.execute(world, parse(params)),
      ...(tool.describe ? { describe: (params) => safely(() => tool.describe!(world, parse(params))) ?? "" } : {}),
    };
    if (!levels.includes(tool.level)) {
      runTool.permission = (params) => safely(() => tool.confirm?.(world, parse(params))) ?? `${tool.label}？`;
    }
    return runTool;
  });
}

/** Runs one proposal step as the device operation it is, with the same input checks as a click. Throws on failure
 * (including an operation that answers with `{ error }`), so the proposal's steps roll back together. */
export function applyStep(world: World, modules: readonly IsoclineModule[], step: ProposalStep): unknown {
  const op = modules.flatMap((module) => module.ops).find((candidate) => candidate.name === step.op);
  if (!op) throw new UnknownOpError(step.op);
  const result = op.run(world, checked(op.input, step.input, `input for ${op.name}`));
  if (result && typeof result === "object" && typeof (result as { error?: unknown }).error === "string") throw new Error((result as { error: string }).error);
  return result;
}

/** Shared by interactive sessions. Asking a question requires no access to personal modules. */
export function askUserTool(): RunTool {
  return {
    name: "ask_user",
    label: "Ask",
    description: "Ask the user a short question when you cannot go on without their choice. A last resort: use it only when there is nothing sensible to guess and a wrong guess could not be put right afterwards; otherwise act on your best guess and say what you assumed. Ask about one thing, and offer 2–4 short options that each answer the whole question. Returns their answer.",
    parameters: Type.Object({
      question: Type.String({ description: "One short question about one thing, in the language the user wrote in" }),
      options: Type.Optional(Type.Array(Type.String(), { maxItems: 6, description: "Suggested answers" })),
    }) as unknown as Record<string, unknown>,
    describe: (params) => String(params.question ?? "").slice(0, 120),
    async execute(params, _signal, context) {
      if (!context) throw new Error("ask_user needs a run");
      const answer = await context.ask({ question: String(params.question ?? ""), options: Array.isArray(params.options) ? params.options.map(String) : [] });
      return `The user answered: ${answer}`;
    },
  };
}

/** A module's guidance as a run reads it now. */
export function moduleGuidance(world: World, modules: readonly IsoclineModule[]): string {
  return modules.map((module) => (typeof module.guidance === "function" ? module.guidance(world) : module.guidance)).filter(Boolean).join("\n\n");
}

/** Removes one of the user's areas, and moves what every module had in it to `moveTo` or to no area, at once. */
export function removeArea(world: World, modules: readonly IsoclineModule[], id: string, moveTo: string | null = null): Area {
  return world.tx(() => {
    const removed = deleteAreaRow(world, id, moveTo);
    for (const module of modules) module.areaRemoved?.(world, id, moveTo);
    return removed;
  });
}

/** The everyday assistant's tools for questions, proposals, automations and opening views. */
export function assistantTools(world: World, modules: readonly IsoclineModule[]): RunTool[] {
  const tools = [askUserTool()];
  const proposable = modules.flatMap((module) => module.tools).filter((tool) => tool.pin && tool.level !== "read");
  if (proposable.length) {
    tools.push({
      name: "propose",
      label: "Propose",
      description: [
        "Prepare changes for the user to approve later, instead of making them now. Use it for what only happens on the user's yes",
        "(anything in their calendar or mail), for deleting, for anything you are unsure they want, or when they asked you to suggest rather than do.",
        "What you may simply do (adding or changing a todo) you do directly, not in a proposal, even when the same request also has something to propose.",
        "The user sees your title and summary in their inbox, with the exact steps, and can accept, decline or ask for a change;",
        "accepting runs exactly these steps, once. Do not also make these changes yourself. After proposing you can finish and say what you proposed.",
        "When the user corrects something you proposed earlier in this conversation (another time, another title), propose the corrected whole with replaces: true; the earlier proposal is withdrawn.",
        `Each call names one of these tools with its parameters, as \`calls\` describes them: ${proposable.map((tool) => tool.name).join(", ")}.`,
      ].join(" "),
      parameters: Type.Object({
        title: Type.String({ maxLength: 120, description: "The decision as a short question, in the language the user wrote in (e.g. 删掉 3 条逾期很久的待办？ / Delete 3 long-overdue todos?)" }),
        summary: Type.String({ maxLength: 1200, description: "What will change and why, briefly, in the language the user wrote in" }),
        replaces: Type.Optional(Type.Boolean({ description: "true when this corrects a proposal you made earlier in this conversation; the earlier one is withdrawn" })),
        // One shape per tool, with that tool's own parameters and what it does: a run is never offered some of them
        // directly (anything `external`), so this is the only place it learns how to call them.
        calls: Type.Array(Type.Union(proposable.map((tool) => Type.Object({
          tool: Type.Literal(tool.name),
          params: tool.parameters,
        }, { description: tool.description }))), { minItems: 1, maxItems: 20 }),
      }) as unknown as Record<string, unknown>,
      describe: (params) => String(params.title ?? "").slice(0, 120),
      execute(params) {
        const calls = Array.isArray(params.calls) ? params.calls as Array<{ tool?: unknown; params?: unknown }> : [];
        if (!calls.length) return "Give at least one call to propose.";
        const steps: ProposalStep[] = [];
        const subjects: string[] = [];
        for (const [index, call] of calls.entries()) {
          const tool = proposable.find((candidate) => candidate.name === call.tool);
          if (!tool) return `Call ${index + 1}: ${String(call.tool)} cannot be proposed. Use one of: ${proposable.map((candidate) => candidate.name).join(", ")}.`;
          let parsed: unknown;
          try { parsed = checked(tool.parameters, call.params ?? {}, `parameters for ${tool.name}`); } catch (error) { return `Call ${index + 1}: ${(error as Error).message}`; }
          const pinned = tool.pin!(world, parsed as never);
          if ("error" in pinned) return `Call ${index + 1}: ${pinned.error}`;
          const op = modules.flatMap((module) => module.ops).find((candidate) => candidate.name === pinned.op);
          if (!op) return `Call ${index + 1}: no operation ${pinned.op}.`;
          try { checked(op.input, pinned.input, `input for ${op.name}`); } catch (error) { return `Call ${index + 1}: ${(error as Error).message}`; }
          // What the user reads: the module's own words for the pinned step, else the tool and what it names.
          let preview = pinned.preview ?? tool.label;
          if (!pinned.preview) try { preview = tool.describe ? `${tool.label}：${tool.describe(world, parsed as never)}` : tool.label; } catch { /* keep the label */ }
          steps.push({ op: pinned.op, input: pinned.input, preview, ...(pinned.detail ? { detail: pinned.detail.slice(0, 8000) } : {}) });
          subjects.push(...(pinned.subjects ?? []));
        }
        const run = coreContext()?.run;
        const conversationId = run ? getRun(world, run.id).run.conversationId : null;
        const proposal = openProposal(world, { title: String(params.title ?? ""), summary: String(params.summary ?? ""), steps, subjects, conversationId, replaces: params.replaces === true });
        const replaced = proposal.replaced?.length ? ` It replaces ${proposal.replaced.length} earlier proposal${proposal.replaced.length > 1 ? "s" : ""}, now withdrawn.` : "";
        // What modules did about it at once (a proposed meeting on the todo list). One that fails leaves the proposal be.
        const earlier = (proposal.replaced ?? []).flatMap((id) => getProposal(world, id).steps);
        const done = modules.flatMap((module) => {
          try { return [module.proposed?.(world, { id: proposal.id, steps, replaced: earlier })].filter((line): line is string => !!line); } catch { return []; }
        });
        // The steps as the user reads them: what they add (an overlap with another event, say) is for the reply too.
        return `Proposed "${proposal.title}" (${steps.length} step${steps.length > 1 ? "s" : ""}). It waits in the user's inbox for their decision; nothing has changed yet.${replaced}\nSteps: ${steps.map((step) => step.preview).join(" | ")}${done.length ? `\n${done.join("\n")}` : ""}`;
      },
    });
  }
  // The user's automations, so "every Monday morning, go over my todos" can be said, not only clicked.
  const days = Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), { minItems: 1, maxItems: 7, description: "Weekdays, 1 Monday to 7 Sunday; every day if left out" }));
  const at = Type.String({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", description: "Time of day, HH:MM, 24-hour, the user's local time" });
  const options = {
    layout: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("sections")], { description: "sections: its results are shown like the morning brief, a lead then one block per heading, rows linked to what they are about; for a digest or review. text otherwise" })),
    keep: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("latest")], { description: "latest: only its newest result stays in the inbox; for something that replaces itself, like a daily digest" })),
    notify: Type.Optional(Type.Union([Type.Literal("always"), Type.Literal("changes")], { description: "changes: tell the user only when a run changed or proposed something; for a watcher that is usually quiet" })),
  };
  const chosen = (params: Record<string, unknown>) => Object.fromEntries((["layout", "keep", "notify"] as const).filter((key) => params[key] !== undefined).map((key) => [key, params[key]]));
  const sayAutomation = (automation: AutomationView) => [
    `${automation.id}: ${automationName(automation, userLocale(world))}`,
    `${automation.schedule.days.length === 7 ? "every day" : `weekdays ${automation.schedule.days.join(",")}`} at ${automation.schedule.at}`,
    automation.enabled ? `on, next ${automation.nextAt}` : "off",
    `results ${automation.layout === "sections" ? "in sections" : "as text"}, ${automation.keep === "latest" ? "only the latest kept" : "all kept"}, ${automation.notify === "changes" ? "told only on changes" : "told every time"}`,
    ...(automation.goal ? [`does: ${automation.goal}`] : []),
  ].join(" | ");
  const attempt = (action: () => string) => { try { return action(); } catch (error) { return `Not done: ${(error as Error).message}`; } };
  tools.push({
    name: "automation_list",
    label: "Automations",
    description: "List the user's automations (what you do on your own on a schedule, like the morning brief): id, name, when, on or off, what each does.",
    parameters: Type.Object({}) as unknown as Record<string, unknown>,
    execute: () => listAutomations(world).map(sayAutomation).join("\n") || "No automations.",
  }, {
    name: "automation_add",
    label: "New automation",
    description: [
      "Make an automation: something you will do on your own, on a schedule, when the user asks for something recurring (\"every Monday morning, go over my todos\").",
      "Its runs are unattended: they read and make reversible changes, and propose anything else. It starts switched on.",
    ].join(" "),
    parameters: Type.Object({
      name: Type.String({ maxLength: 60, description: "A short name, in the user's language" }),
      goal: Type.String({ maxLength: 2000, description: "What to do each time, as the instruction you will be given then, in the user's language" }),
      at, days, ...options,
    }) as unknown as Record<string, unknown>,
    describe: (params) => String(params.name ?? "").slice(0, 60),
    execute: (params) => attempt(() => {
      const made = createAutomation(world, {
        name: String(params.name ?? ""), goal: String(params.goal ?? ""),
        schedule: { at: params.at, days: Array.isArray(params.days) ? params.days : [1, 2, 3, 4, 5, 6, 7] }, ...chosen(params),
      });
      return `Made the automation "${made.name}" (${made.id}). It is on; the user can change or switch it off on the Automations page.`;
    }),
  }, {
    name: "automation_update",
    label: "Change automation",
    description: "Change one of the user's automations: rename it, reword what it does, move its time or days, or switch it on or off. Get its id from automation_list.",
    parameters: Type.Object({
      id: Type.String(),
      name: Type.Optional(Type.String({ maxLength: 60 })),
      goal: Type.Optional(Type.String({ maxLength: 2000 })),
      at: Type.Optional(at), days,
      enabled: Type.Optional(Type.Boolean()), ...options,
    }) as unknown as Record<string, unknown>,
    describe: (params) => String(params.id ?? ""),
    execute: (params) => attempt(() => {
      const current = listAutomations(world).find((automation) => automation.id === params.id);
      if (!current) return `No automation ${String(params.id)}. Use automation_list.`;
      const changed = updateAutomation(world, current.id, {
        ...(params.name !== undefined ? { name: params.name } : {}),
        ...(params.goal !== undefined ? { goal: params.goal } : {}),
        ...(params.at !== undefined || params.days !== undefined ? { schedule: { at: params.at ?? current.schedule.at, days: params.days ?? current.schedule.days } } : {}),
        ...(params.enabled !== undefined ? { enabled: params.enabled } : {}), ...chosen(params),
      });
      return `Changed: ${sayAutomation({ ...current, ...changed })}.`;
    }),
  });
  // The user's areas: the parts of life todos and topics belong to. Making one is easy to undo, so it needs no question;
  // renaming and removing are the user's, in Settings.
  tools.push({
    name: "area_list",
    label: "Areas",
    description: "List the user's areas (the parts of life their todos and link topics belong to): id and name, in their order.",
    parameters: Type.Object({}) as unknown as Record<string, unknown>,
    execute: () => listAreas(world).map((area) => `${area.id}: ${area.name}`).join("\n") || "The user has no areas.",
  }, {
    name: "area_add",
    label: "New area",
    description: "Make a new area when the user asks for one (\"add an area for my kids\"). Not for sorting a single thing: use an area the user already has, or none.",
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 40, description: "Its name, in the user's language" }),
    }) as unknown as Record<string, unknown>,
    describe: (params) => String(params.name ?? "").slice(0, 40),
    execute: (params) => attempt(() => {
      const made = addArea(world, { name: params.name });
      return `Made the area "${made.name}" (${made.id}). The user can rename, recolour or remove it in Settings. Areas now: ${describeAreas(world)}.`;
    }),
  }, {
    name: "preference_add",
    label: "Remember",
    description: [
      "Write down something lasting the user has said about how they like things: how to answer, what to call things, habits and rules",
      "(\"keep answers short\", \"my week starts on Monday\", \"no meetings before 10\"). Only what they said or plainly asked you to remember,",
      "in their words and language, one thing each; not a one-off request, not a guess about them, never a secret.",
      "The user sees every one in Settings and can change or remove it. Say in your reply that you noted it.",
    ].join(" "),
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: MAX_PREFERENCE, description: "The preference, one sentence, in the user's language" }),
    }) as unknown as Record<string, unknown>,
    describe: (params) => String(params.text ?? "").slice(0, 80),
    execute: (params) => attempt(() => {
      const kept = addPreference(world, { text: params.text, by: "alfred" });
      return `Noted (${kept.id}): ${kept.text}. The user can change or remove it in Settings.`;
    }),
  }, {
    name: "preference_remove",
    label: "Forget",
    description: "Remove a preference when the user says it no longer holds or asks you to forget it. Ids are in the list at the start of your instructions.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, maxLength: 64 }),
    }) as unknown as Record<string, unknown>,
    describe: (params) => listPreferences(world).find((preference) => preference.id === params.id)?.text.slice(0, 80) ?? "",
    execute: (params) => attempt(() => {
      const gone = removePreference(world, String(params.id), "alfred");
      return `Removed: ${gone.text}.`;
    }),
  });
  const views = modules.flatMap((module) => (module.views ?? []).map((view) => ({ key: `${module.id}.${view.id}`, module: module.id, view: view.id, title: view.title })));
  if (views.length) {
    tools.push({
      name: "show_view",
      label: "Show",
      description: `Open a view beside the conversation on the user's screen, when the answer is easier to see than to read. Views: ${views.map((view) => `${view.key} (${view.title})`).join(", ")}.`,
      parameters: Type.Object({
        view: Type.Union(views.map((view) => Type.Literal(view.key))),
      }) as unknown as Record<string, unknown>,
      describe: (params) => views.find((view) => view.key === params.view)?.title ?? "",
      execute(params, _signal, context) {
        const view = views.find((candidate) => candidate.key === params.view);
        if (!view) return `Unknown view. Use one of: ${views.map((candidate) => candidate.key).join(", ")}`;
        context?.note("view", { module: view.module, view: view.view });
        return `Shown ${view.title} to the user.`;
      },
    });
  }
  return tools;
}

export function moduleMigrations(modules: readonly IsoclineModule[]): Migration[] {
  return modules.flatMap((module) => module.migrations);
}
