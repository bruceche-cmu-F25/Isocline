/** Messages between the home node and an engine worker process.
 *
 * The model runs in the worker; Alfred's tools run in the home node, because
 * they write the world under the run's lease. So a tool call travels to the
 * home node and its result comes back. One worker handles one run at a time.
 */
import type { Attachment, EngineRequest, FileChange, Workspace } from "@alfred/core";

/** A tool as the worker sees it: its description only. */
export interface ToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RunJob {
  /** Opaque to the worker: a key for the conversation's session. */
  thread: string;
  instructions: string;
  /** Keep the user's words separate from context until the worker resolves any selected skill. */
  prompt: Pick<EngineRequest, "today" | "now" | "timezone" | "goal" | "context">;
  /** Earlier turns, for a session that starts empty (a conversation older than its session). */
  history: string | null;
  tools: ToolSpec[];
  /** `provider/model` and thinking level for this conversation; absent for Pi's defaults. */
  model?: string;
  thinking?: string;
  /** `fast`: the provider is asked to write faster, where it offers that (protocol fastSpeed). */
  speed?: "fast";
  /** The user's language: the questions the worker asks before a tool are in it. */
  locale?: "zh" | "en";
  /** A development session's project folder: the session works there, with the file tools its access allows. */
  workspace?: Workspace;
  /** The files the user sent with this turn: images are shown to the model, text is put into the turn (a long one is
   * left on disk for the model to read). */
  attachments?: Attachment[];
}

export type ModelInfo = import("@alfred/core").EngineModel;
export interface UsageInfo {
  model?: string; thinking?: string; tokens?: number; contextWindow?: number; percent?: number;
  /** This turn alone: tokens in and out, cache reads and writes, cost in dollars, and how long it took. */
  input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number; durationMs?: number;
}

export type ExternalStep = {
  id: string; tool: string; label: string; about?: string; status: "started" | "done" | "failed" | "declined";
  /** A command's ending: its exit code (null when it was killed), how long it ran, the end of what it printed. */
  exit?: number | null; ms?: number; output?: string;
};

export type ToParent =
  | { type: "tool"; run: string; call: string; name: string; params: Record<string, unknown> }
  /** The engine's own tools (MCP, read): ask the user, show a step, keep a receipt. */
  | { type: "allow"; run: string; call: string; question: string; detail?: string; inProject?: boolean; command?: string }
  /** A file in the session's project was changed (edit, write): a receipt. */
  | { type: "changed"; run: string; file: FileChange }
  | { type: "step"; run: string; step: ExternalStep }
  | { type: "receipt"; run: string; tool: string; label: string; about?: string }
  | { type: "text"; run: string; text: string }
  | { type: "usage"; run: string; usage: UsageInfo }
  | { type: "steered"; run: string; ok: boolean }
  | { type: "models_result"; id: string; models: ModelInfo[]; error?: string }
  | { type: "done"; run: string; reply: string }
  | { type: "error"; run: string; message: string; code?: string };

export type ToWorker =
  | { type: "run"; run: string; job: RunJob }
  | { type: "tool_result"; run: string; call: string; ok: true; text: string }
  | { type: "tool_result"; run: string; call: string; ok: false; error: string }
  | { type: "allow_result"; run: string; call: string; allowed: boolean }
  | { type: "abort"; run: string }
  /** The user's words, into the turn now running. */
  | { type: "steer"; run: string; text: string }
  /** Close this conversation's warm session: another worker takes it over. */
  | { type: "release"; thread: string }
  | { type: "models"; id: string }
  /** Close every session (and its MCP servers), then exit. */
  | { type: "shutdown" };

function weekday(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-US", { weekday: "long" });
}

const SHORT_DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/** The next two weeks by weekday, so "Thursday", "下周三" or "next Friday" is looked up rather than counted (the
 * model counts wrong now and then), and which week "next week" is gets one reading. */
function comingDays(today: string): string {
  const [year, month, day] = today.split("-").map(Number);
  const days = Array.from({ length: 14 }, (_, i) => new Date(year, month - 1, day + i + 1));
  const monday = days.find((date) => date.getDay() === 1)!;
  const name = (date: Date) => `${SHORT_DAY[date.getDay()]} ${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return `Coming days: ${days.map(name).join(", ")}. Weeks run Monday to Sunday: "next week" (下周) is the week of ${name(monday)}, unless the words say otherwise (put off to 下周一 means a Monday after the original day).`;
}

/** The user's turn as the model reads it: the date and time, the coming days, what they were looking at (context
 * only), then their words. */
export function composePrompt(request: RunJob["prompt"]): string {
  const lines = [
    `Today is ${request.today} (${weekday(request.today)})${request.now ? `, now ${request.now}` : ""}, timezone ${request.timezone}.`,
    comingDays(request.today),
  ];
  const context = request.context;
  // Asked by voice from no page (the Mac's figure, a hotkey): there is no page to mention.
  if (context && context.view !== "core.voice") {
    const page = context.title ? `${context.title} (${context.view})` : context.view;
    lines.push(`The user is looking at the ${page} page${context.summary ? `: ${context.summary}` : ""}.${context.selection ? ` Selected: ${context.selection.title ?? context.selection.id} (${context.selection.id}).` : ""} This is context, not a request.`);
  }
  if (context?.spoken) {
    lines.push("The user said this out loud and it was transcribed, so a word may be misheard: if a name or number looks wrong, check before acting on it. Your reply will be read aloud: one or two short sentences, no lists, tables, links or Markdown. Never say something was done unless it was.");
  }
  // Much of what a run reads (areas, events, the steps it proposes) is in the app's language; a message in a Latin
  // script is answered in its own language all the same (models drift to the language around them).
  if (/\p{Script=Latin}/u.test(request.goal) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(request.goal)) {
    lines.push("The message below is not in Chinese: write your reply, and any title or summary, in its language.");
  }
  return `${lines.join("\n")}\n\n${request.goal}`;
}

/** Earlier turns, only for a session that does not have them yet. Context only. */
export function composeHistory(request: Pick<EngineRequest, "history">): string | null {
  if (!request.history.length) return null;
  return [
    "Earlier in this conversation (context only; do not act on it again):",
    ...request.history.map((turn) => `${turn.role === "user" ? "User" : "Alfred"}: ${turn.text}`),
  ].join("\n");
}
