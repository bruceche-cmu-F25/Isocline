/** Read the sources a completed automation run actually used (the morning brief's, or any other's shown in
 * sections) from its persisted Pi turn.
 * The rule, attempt timestamps, exact prompt, returned reply and tool call IDs all come from that edition.
 * The live mail/calendar mirrors and today's timezone are never consulted. */
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { CONVERSATION_ID, listAreas, type Area, type Run, type World } from "@zirma/core";
import type { RunSources } from "@zirma/protocol";
import { readSources, type SourceRead } from "./source-reads.ts";

interface Part { type?: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> }
interface Message { role?: string; content?: Part[]; toolName?: string; toolCallId?: string; isError?: boolean }
interface SessionEntry { id: string; parentId?: string; timestamp: string; type?: string; message?: Message }

const SOURCE_TOOL = new Set(["calendar_list", "todo_list", "mail_list", "mail_read"]);
const parts = (message?: Message): Part[] => Array.isArray(message?.content) ? message.content : [];
const words = (message?: Message): string => parts(message).filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("");

function promptDate(prompt: string, goal: string): { date: string; timezone: string } | null {
  if (!prompt.endsWith(`\n\n${goal}`)) return null;
  // On a cold worker the current prompt can follow an earlier conversation summary.
  const header = /(?:^|\n\n---\n\n)Today is (\d{4}-\d\d-\d\d) \([A-Za-z]+\), timezone ([\w/+.:_-]+)\.$/.exec(prompt.slice(0, -(goal.length + 2)));
  if (!header) return null;
  try { new Intl.DateTimeFormat("en", { timeZone: header[2] }); } catch { return null; }
  return { date: header[1], timezone: header[2] };
}

function fromBranch(entries: Map<string, SessionEntry>, end: SessionEntry, goal: string, areas: readonly Area[]): RunSources | null {
  const branch: Message[] = [], seen = new Set<string>();
  for (let entry: SessionEntry | undefined = end; entry && !seen.has(entry.id); entry = entry.parentId ? entries.get(entry.parentId) : undefined) {
    seen.add(entry.id);
    const message = entry.type === "message" ? entry.message : undefined;
    if (!message) continue;
    if (message.role === "user") {
      const header = promptDate(words(message), goal);
      if (!header) continue; // A user's steer can follow the initial prompt within the same attempt.
      const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
      const reads: SourceRead[] = [];
      for (const item of branch.reverse()) {
        if (item.role === "assistant") {
          for (const p of parts(item)) {
            if (p?.type === "toolCall" && p.id && p.name && SOURCE_TOOL.has(p.name)) calls.set(p.id, { name: p.name, args: p.arguments ?? {} });
          }
        } else if (item.role === "toolResult" && item.toolCallId && !item.isError) {
          const call = calls.get(item.toolCallId);
          if (call && call.name === item.toolName) reads.push({ ...call, text: words(item) });
        }
      }
      return readSources(header.date, header.timezone, reads, areas);
    }
    branch.push(message);
  }
  return null;
}

/** Streams a single session without loading its whole history. Only the completed attempt's entries are retained. */
async function sessionEvidence(file: string, run: Run, started: string, ended: string, areas: readonly Area[]): Promise<RunSources | null> {
  const entries = new Map<string, SessionEntry>();
  const final: SessionEntry[] = [];
  const saved = run.outcome?.reply;
  if (!saved) return null;
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry: SessionEntry;
      try { entry = JSON.parse(line) as SessionEntry; } catch { continue; }
      if (!entry || typeof entry.timestamp !== "string" || typeof entry.id !== "string") continue;
      if (entry.timestamp < started) continue;
      if (entry.timestamp > ended) break; // Pi appends these envelopes in time order.
      entries.set(entry.id, entry);
      if (entry.type === "message" && entry.message?.role === "assistant") {
        const text = words(entry.message).trim();
        // Versions without core_run_replies saved at most the first 4,000 characters.
        if (text === saved || (saved.length === 4000 && text.startsWith(saved))) final.push(entry);
      }
    }
  } finally { lines.close(); input.destroy(); }
  return final.length === 1 ? fromBranch(entries, final[0], run.goal, areas) : null;
}

export async function runSources(world: Pick<World, "db" | "path">, run: Run): Promise<RunSources | null> {
  if (run.state !== "completed" || !run.automationId || !CONVERSATION_ID.test(run.conversationId) || world.path === ":memory:") return null;
  const times = world.db.prepare(`SELECT
    (SELECT at FROM core_events WHERE run_id = ? AND kind = 'run.started' ORDER BY seq DESC LIMIT 1) AS started,
    (SELECT at FROM core_events WHERE run_id = ? AND kind = 'run.completed' ORDER BY seq DESC LIMIT 1) AS ended`).get(run.id, run.id);
  if (typeof times?.started !== "string" || typeof times.ended !== "string") return null;

  const dir = join(dirname(world.path), "engine", "sessions", run.conversationId);
  try {
    if (!(await lstat(dir)).isDirectory()) return null;
    let found: RunSources | null = null;
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (!item.isFile() || !item.name.endsWith(".jsonl")) continue;
      const evidence = await sessionEvidence(join(dir, item.name), run, times.started, times.ended, listAreas(world as World));
      if (evidence && found) return null;
      if (evidence) found = evidence;
    }
    return found;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

/** Where the edition's things are today. What the run read stays as it was read; this only adds identity for
 * things that still exist: an event's colour slot, and the Mail page key of each message the reply names by id.
 * A message or event that has since gone gets nothing, and the page shows it without colour or link. */
export function sourcesToday(evidence: RunSources, reply: string, now: {
  events?: Array<{ id: string; k: string }>;
  messages?: Array<{ id: string; account: string; from: string; subject: string }>;
}): RunSources {
  const colours = new Map(now.events?.map((event) => [event.id, event.k]));
  const calendar = evidence.calendar?.map((event) => (colours.has(event.id) ? { ...event, k: colours.get(event.id)! } : event)) ?? null;
  const ids = new Set(evidence.mail?.map((message) => message.id));
  for (const match of reply.matchAll(/[(（]\s*(?:mail|邮件)\s*[:：]\s*([\w-]{1,64})\s*[)）]/gi)) ids.add(match[1]!);
  const cited = (now.messages ?? []).filter((message, index, all) => ids.has(message.id) && all.findIndex((other) => other.id === message.id) === index)
    .map(({ id, account, from, subject }) => ({ id, from, subject, key: `${account}|${id}` }));
  return { ...evidence, calendar, ...(cited.length ? { cited } : {}) };
}
