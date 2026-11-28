/** Speaks the worker protocol with a scripted "model", for testing the pool.
 * The goal decides what it does:
 *   tool <name> <json>   call that tool, then reply with its result
 *   crash                exit mid-run
 *   hang                 never answer, but stop when aborted
 *   stubborn             never answer, and ignore aborts
 *   who                  reply with the thread, whether history came along, the model, and this pid
 *   slow                 wait up to 2 s for the user to steer; reply with what they said
 *   external <tool>      call a tool of its own that changes things: ask, then step and receipt
 *   anything else        reply "echo: <goal>"
 * It keeps a "warm" set of threads, reports usage, answers models, and on
 * release or shutdown records what it closed (in --log, if given).
 */
import { appendFileSync } from "node:fs";
import type { ToParent, ToWorker } from "../../src/protocol.ts";

const send = (message: ToParent) => process.send?.(message);
const waiting = new Map<string, (value: string | boolean) => void>();
const warm = new Set<string>();
const steers = new Map<string, string>();
const log = process.argv.includes("--log") ? process.argv[process.argv.indexOf("--log") + 1] : null;
const note = (line: string) => { if (log) appendFileSync(log, `${process.pid} ${line}\n`); };
let calls = 0;

process.on("message", async (message: ToWorker) => {
  if (message.type === "tool_result") {
    waiting.get(message.call)?.(message.ok ? message.text : `error: ${message.error}`);
    waiting.delete(message.call);
    return;
  }
  if (message.type === "allow_result") {
    waiting.get(message.call)?.(message.allowed);
    waiting.delete(message.call);
    return;
  }
  if (message.type === "abort") {
    if (process.argv.includes("--stubborn-seen")) return;
    send({ type: "error", run: message.run, message: "aborted", code: "AbortError" });
    return;
  }
  if (message.type === "steer") {
    steers.set(message.run, message.text);
    send({ type: "steered", run: message.run, ok: true });
    return;
  }
  if (message.type === "release") {
    warm.delete(message.thread);
    note(`release ${message.thread}`);
    return;
  }
  if (message.type === "models") {
    send({ type: "models_result", id: message.id, models: [{ id: "fake-1", provider: "fake", name: "Fake One", reasoning: true }] });
    return;
  }
  if (message.type === "title") {
    if (message.goal === "fail") send({ type: "title_result", id: message.id, error: "no key" });
    else send({ type: "title_result", id: message.id, title: `「${message.goal}」 with ${message.model ?? "default"}` });
    return;
  }
  if (message.type === "shutdown") {
    note(`shutdown ${[...warm].join(",")}`);
    process.exit(0);
  }
  const { run, job } = message;
  warm.add(job.thread);
  const goal = job.prompt.goal;
  send({ type: "text", run, text: "thinking" });
  send({ type: "usage", run, usage: { model: job.model ?? "fake/default", thinking: job.thinking ?? "off", tokens: 1200, contextWindow: 100000, percent: 1.2 } });
  if (goal.startsWith("tool ")) {
    const [, name, json] = goal.match(/^tool (\S+) (.*)$/)!;
    const call = String(++calls);
    const text = await new Promise<string>((resolve) => { waiting.set(call, (value) => resolve(String(value))); send({ type: "tool", run, call, name, params: JSON.parse(json) }); });
    send({ type: "done", run, reply: `tool said: ${text}` });
  } else if (goal.startsWith("external ")) {
    const tool = goal.slice("external ".length);
    const call = String(++calls);
    const allowed = await new Promise<boolean>((resolve) => { waiting.set(call, (value) => resolve(value === true)); send({ type: "allow", run, call, question: `Use ${tool}?` }); });
    const step = { id: call, tool, label: tool, about: "{}", status: "started" as const };
    if (!allowed) {
      send({ type: "step", run, step: { ...step, status: "declined" } });
      send({ type: "done", run, reply: "external denied" });
      return;
    }
    send({ type: "step", run, step });
    send({ type: "step", run, step: { ...step, status: "done" } });
    send({ type: "receipt", run, tool, label: tool, about: "{}" });
    send({ type: "done", run, reply: "external allowed" });
  } else if (goal === "slow") {
    for (let i = 0; i < 40 && !steers.has(run); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    send({ type: "done", run, reply: steers.has(run) ? `you added: ${steers.get(run)}` : "nobody added anything" });
  } else if (goal === "crash") {
    process.exit(3);
  } else if (goal === "hang") {
    // waits for an abort
  } else if (goal === "stubborn") {
    process.argv.push("--stubborn-seen");
  } else if (goal === "who") {
    send({ type: "done", run, reply: `${job.thread} history=${job.history ? "yes" : "no"} model=${job.model ?? "-"} pid=${process.pid}` });
  } else {
    send({ type: "done", run, reply: `echo: ${goal}` });
  }
});
process.on("disconnect", () => process.exit(0));
