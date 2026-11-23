/** node scripts/eval/run.ts [--only a,b] [--repeat n] [--model provider/model] [--thinking low] [--jobs 4] [--out dir]
 *
 * Says each scenario to a throwaway Alfred with a real model and prints what went wrong. Uses the model sign-in in
 * the keychain; never connects Google, so nothing leaves this machine except the model calls.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { tmpdir } from "node:os";
import { helpers, runScenario, type Result } from "./harness.ts";
import { SCENARIOS } from "./scenarios.ts";

const { values } = parseArgs({
  options: {
    only: { type: "string" }, repeat: { type: "string" }, model: { type: "string" }, thinking: { type: "string" },
    jobs: { type: "string" }, out: { type: "string" },
  },
});
const only = values.only?.split(",");
const repeat = Number(values.repeat ?? 1);
const jobs = Number(values.jobs ?? 4);
const out = values.out ?? join(tmpdir(), `alfred-eval-${Date.now()}`);
mkdirSync(out, { recursive: true });

const queue = SCENARIOS.filter((s) => !only || only.includes(s.id)).flatMap((s) => Array.from({ length: repeat }, (_, i) => ({ s, i })));
const results: Array<{ result: Result; problems: string[]; run: number }> = [];

async function worker() {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const { s, i } = next;
    const result = await runScenario({ ...s, id: repeat > 1 ? `${s.id}-r${i + 1}` : s.id }, { root: join(out, "nodes"), model: values.model, thinking: values.thinking });
    let problems: string[];
    try { problems = s.check(result, helpers); } catch (error) { problems = [`check threw: ${(error as Error).message}`]; }
    results.push({ result, problems, run: i + 1 });
    const bad = problems.filter((p) => !p.startsWith("note:"));
    console.log(`${bad.length ? "✗" : "✓"} ${result.id}  ${(result.ms / 1000).toFixed(1)}s  ${result.tools.join(" → ")}`);
    for (const p of problems) console.log(`    ${p}`);
  }
}
await Promise.all(Array.from({ length: jobs }, worker));

results.sort((a, b) => a.result.id.localeCompare(b.result.id));
writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => r.problems.some((p) => !p.startsWith("note:")));
console.log(`\n${results.length - failed.length}/${results.length} clean. Details: ${join(out, "results.json")}`);
