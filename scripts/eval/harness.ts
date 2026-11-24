/** Real-model checks of the everyday Zirma: one throwaway home node per scenario (its own data directory, a fake
 * writable calendar account, a few todos and events), the user's real model sign-in from the keychain, no Google
 * connection (nothing is delivered anywhere). A scenario says one thing to Zirma and checks what landed: todos,
 * proposals, questions asked, the reply.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  answerRequest, getRun, listOpenProposals, submitRun, updateSettings, withCoreContext, type World,
} from "@zirma/core";
import { createPiEngine } from "@zirma/engine-pi";
import { todoModule, addTodo, listTodos, type Todo } from "@zirma/module-todo";
import { calendarModule } from "@zirma/module-calendar";
import { mailModule } from "@zirma/module-mail";
import { linksModule } from "@zirma/module-links";
import type { GoogleService } from "@zirma/module-kit";
import { openHome } from "../../packages/server/src/home.ts";

export const ACCOUNT = "test@example.com";

export interface Seed {
  todos?: Array<{ title: string; due?: string; at?: string; startDate?: string }>;
  /** Local times "YYYY-MM-DD HH:MM", or `date` for whole days. */
  events?: Array<{ title: string; start?: string; end?: string; date?: string; mine?: boolean; attendees?: number; invite?: boolean; location?: string }>;
}

export interface CalendarStep { op: string; title: string; start?: string; end?: string; date?: string; endDate?: string; location?: string; notes?: string; event?: string; response?: string; repeat?: { every: string; until?: string }; preview: string }
export interface Result {
  id: string;
  goal: string;
  state: string;
  error?: string;
  reply: string;
  tools: string[];
  asks: Array<{ question: string; options: string[]; answer: string }>;
  proposals: Array<{ title: string; summary: string; steps: Array<{ op: string; preview: string; input: unknown }> }>;
  calendar: CalendarStep[];
  todosAdded: Todo[];
  todosChanged: Array<{ before: Todo; after: Todo }>;
  todosGone: Todo[];
  ms: number;
  model?: string;
}

export interface Scenario {
  id: string;
  /** What the user says. A list is one conversation, said in turn. */
  say: string | string[];
  seed?: Seed;
  /** What to answer if Zirma asks; otherwise its first option, or "你看着办". */
  answer?: string;
  /** Problems found, as short lines; empty when it went right. */
  check(result: Result, h: Helpers): string[];
}

export interface Helpers {
  /** Local "YYYY-MM-DD HH:MM" of an instant. */
  local(iso: string): string;
  adds(result: Result): CalendarStep[];
}

const pad = (n: number) => String(n).padStart(2, "0");
export function local(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const at = (value: string) => {
  const [date, time] = value.split(" ");
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  return new Date(y, m - 1, d, h, min).getTime();
};

/** 组会 is tomorrow, whatever day the eval runs: the 明天 scenarios clash with it. */
const TOMORROW = (() => { const at = new Date(); at.setDate(at.getDate() + 1); return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`; })();
export const BASE_SEED: Seed = {
  todos: [
    { title: "买牛奶" },
    { title: "14848 作业 5", due: "2026-11-25" },
    { title: "交房租", due: "2026-11-30" },
  ],
  events: [
    { title: "组会", start: `${TOMORROW} 10:00`, end: `${TOMORROW} 11:00`, mine: true, attendees: 5 },
    { title: "牙医", start: "2026-11-25 15:00", end: "2026-11-25 16:00", mine: true },
    { title: "和张伟同步", start: "2026-11-27 14:00", end: "2026-11-27 15:00", mine: true, attendees: 2 },
    { title: "Thanksgiving", date: "2026-11-26" },
    { title: "Design review", start: "2026-11-24 16:00", end: "2026-11-24 17:00", invite: true, attendees: 6 },
  ],
};

/** A Google that only reads: the seed's calendar, as the calendar sync asks for it. Writing throws (nothing here is
 * accepted, so nothing is delivered). */
function fakeGoogle(s: Seed): GoogleService {
  const iso = (value: string) => new Date(at(value)).toISOString();
  const items = (s.events ?? []).map((event, i) => ({
    id: `seed${i}`, status: "confirmed", summary: event.title, etag: "e1",
    ...(event.location ? { location: event.location } : {}),
    ...(event.date
      ? { start: { date: event.date }, end: { date: new Date(Date.parse(`${event.date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10) }, organizer: { email: "holidays@example.com" } }
      : { start: { dateTime: iso(event.start!) }, end: { dateTime: iso(event.end!) } }),
    ...(event.invite
      ? { organizer: { email: "boss@example.com" }, attendees: [{ email: ACCOUNT, self: true, responseStatus: "needsAction" }, ...Array.from({ length: (event.attendees ?? 2) - 1 }, (_, k) => ({ email: `p${k}@example.com`, responseStatus: "accepted" }))] }
      : event.mine ? { organizer: { email: ACCOUNT, self: true }, ...(event.attendees && event.attendees > 1 ? { attendees: [{ email: ACCOUNT, self: true, organizer: true, responseStatus: "accepted" }, ...Array.from({ length: event.attendees - 1 }, (_, k) => ({ email: `p${k}@example.com`, responseStatus: "accepted" }))] } : {}) } : {}),
  }));
  return {
    accounts: () => [{ email: ACCOUNT, capabilities: ["calRead", "calWrite"] }],
    session: async () => ({
      async get(url: string) {
        if (url.includes("/calendarList")) return { items: [{ id: ACCOUNT, summary: ACCOUNT, primary: true, accessRole: "owner" }] };
        const { searchParams } = new URL(url);
        const min = Date.parse(searchParams.get("timeMin")!), max = Date.parse(searchParams.get("timeMax")!);
        return { items: items.filter((item) => { const t = Date.parse(item.start.dateTime ?? `${item.start.date}T12:00:00`); return t >= min && t < max; }) };
      },
      async send() { throw new Error("The eval never writes to Google"); },
    }),
  };
}

function seedTodos(world: World, s: Seed): void {
  withCoreContext({ actor: "user" }, () => { for (const todo of s.todos ?? []) addTodo(world, todo); });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runScenario(scenario: Scenario, options: { root: string; model?: string; thinking?: string; locale?: string; timeoutMs?: number }): Promise<Result> {
  const dataDir = join(options.root, scenario.id);
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const engine = createPiEngine({ cwd: join(dataDir, "engine"), config: dataDir, log: () => {} });
  const google = fakeGoogle(scenario.seed ?? BASE_SEED);
  const home = openHome({ dataDir, engine, modules: [todoModule, calendarModule, mailModule, linksModule], log: () => {}, services: () => ({ google }) });
  const world = home.world;
  const started = Date.now();
  const result: Result = { id: scenario.id, goal: [scenario.say].flat().join(" ⏎ "), state: "", reply: "", tools: [], asks: [], proposals: [], calendar: [], todosAdded: [], todosChanged: [], todosGone: [], ms: 0 };
  try {
    withCoreContext({ actor: "user" }, () => updateSettings(world, {
      locale: options.locale ?? "zh", preferredName: "Bruce", model: options.model ?? "deepseek/deepseek-flash", thinking: options.thinking ?? "low",
    }));
    seedTodos(world, scenario.seed ?? BASE_SEED);
    await home.syncModule("calendar");
    const before = new Map(listTodos(world, { includeDone: true, includeArchived: true }).map((todo) => [todo.id, todo]));
    let conversationId: string | undefined;
    const replies: string[] = [];
    for (const [turn, goal] of [scenario.say].flat().entries()) {
      const { run } = withCoreContext({ actor: "user" }, () => submitRun(world, { requestId: `${scenario.id}-${turn}`, goal, profile: "assistant", conversationId }));
      conversationId = run.conversationId;
      home.kick();
      const deadline = Date.now() + (options.timeoutMs ?? 180_000);
      for (;;) {
        await sleep(400);
        const { run: now } = getRun(world, run.id);
        if (now.state === "waiting_input" && now.request) {
          const answer = scenario.answer ?? now.request.options[0] ?? "你看着办，按最可能的来";
          result.asks.push({ question: now.request.question, options: now.request.options, answer });
          withCoreContext({ actor: "user" }, () => answerRequest(world, run.id, { requestId: now.request!.id, answer }));
          home.kick();
          continue;
        }
        if (now.state === "waiting_permission" && now.request) {
          result.asks.push({ question: `[permission] ${now.request.question}`, options: now.request.options, answer: "allow" });
          withCoreContext({ actor: "user" }, () => answerRequest(world, run.id, { requestId: now.request!.id, answer: "allow" }));
          home.kick();
          continue;
        }
        if (["completed", "failed", "cancelled", "interrupted"].includes(now.state)) {
          result.state = now.state;
          if (now.outcome?.error) result.error = now.outcome.error;
          replies.push(now.outcome?.reply ?? "");
          const { events } = getRun(world, run.id);
          for (const event of events) {
            const payload = event.payload as Record<string, unknown>;
            if (event.kind === "run.step" && payload.status === "started") result.tools.push(`${payload.tool}${payload.about ? `(${String(payload.about).slice(0, 60)})` : ""}`);
            if (event.kind === "run.usage") result.model = String(payload.model);
          }
          break;
        }
        if (Date.now() > deadline) { result.state = "timeout"; break; }
      }
      if (result.state !== "completed") break;
    }
    result.reply = replies.join("\n---\n");
    for (const proposal of listOpenProposals(world)) {
      result.proposals.push({ title: proposal.title, summary: proposal.summary, steps: proposal.steps.map((step) => ({ op: step.op, preview: step.preview, input: step.input })) });
      for (const step of proposal.steps) {
        const input = step.input as Record<string, any>;
        if (!step.op.startsWith("calendar.")) continue;
        const when = input.when as { start?: string; end?: string; date?: string; endDate?: string } | undefined;
        result.calendar.push({
          op: step.op, title: input.title ?? "", preview: step.preview,
          ...(when?.start ? { start: local(when.start), end: local(when.end!) } : {}),
          ...(when?.date ? { date: when.date, endDate: when.endDate } : {}),
          ...(input.location ? { location: input.location } : {}), ...(input.notes ? { notes: input.notes } : {}),
          ...(input.eventId ? { event: input.eventId } : {}), ...(input.response ? { response: input.response } : {}),
          ...(input.repeat ? { repeat: input.repeat } : {}),
        });
      }
    }
    const after = listTodos(world, { includeDone: true, includeArchived: true });
    for (const todo of after) {
      const old = before.get(todo.id);
      if (!old) result.todosAdded.push(todo);
      else if (JSON.stringify(old) !== JSON.stringify(todo)) result.todosChanged.push({ before: old, after: todo });
      before.delete(todo.id);
    }
    result.todosGone = [...before.values()];
  } catch (error) {
    result.state = "harness_error";
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    result.ms = Date.now() - started;
    await engine.close();
    home.close();
  }
  return result;
}

export const helpers: Helpers = { local, adds: (result) => result.calendar.filter((step) => step.op === "calendar.add") };
