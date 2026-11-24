/** Runs the recorded clips through every engine that can run here, scores them, and writes the report.
 *
 *   node scripts/voice-bench/run.ts                       all available engines, with and without the word list
 *   node scripts/voice-bench/run.ts --engines qwen3-asr-0.6b,soniox-async-v6
 *   node scripts/voice-bench/run.ts --context none|only   only the plain runs, or only the word-list runs
 *   node scripts/voice-bench/run.ts --fresh               ignore cached transcripts
 *
 * Transcripts are cached in results/raw/<engine>/<clip>.json and reused until the recording or word list changes,
 * so re-running only pays for what is new. The report is results/report.md (summary) and results/details.md.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CLIPS, HERE, RESULTS, listClips, type Clip, type Category } from "./clips.ts";
import { ENGINES, type Engine, type Job, type Result } from "./engines.ts";
import { score, type Score } from "./score.ts";

if (existsSync(join(HERE, ".env"))) process.loadEnvFile(join(HERE, ".env"));

const { values: args } = parseArgs({
  options: {
    engines: { type: "string" },
    context: { type: "string", default: "both" },
    fresh: { type: "boolean", default: false },
  },
});

const CATS: Category[] = ["daily", "mixed", "dev"];
const CAT_LABEL: Record<Category, string> = { daily: "日常", mixed: "混说", dev: "开发" };

interface Cached extends Result { stamp: string }

/** The word list a scene would hand the recognizer: vocab.txt plus every term of that category's clips. */
async function wordLists(clips: Clip[]): Promise<Record<Category, string[]>> {
  const vocab = existsSync(join(HERE, "vocab.txt"))
    ? (await readFile(join(HERE, "vocab.txt"), "utf8")).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    : [];
  const lists = {} as Record<Category, string[]>;
  for (const cat of CATS) lists[cat] = [...new Set([...vocab, ...clips.filter((c) => c.category === cat).flatMap((c) => c.terms)])];
  return lists;
}

async function stampOf(clip: Clip, terms: string[] | null) {
  const s = await stat(join(CLIPS, `${clip.id}.wav`));
  return createHash("sha1").update(`${s.size}:${s.mtimeMs}:${JSON.stringify(terms)}`).digest("hex").slice(0, 12);
}

async function runVariant(engine: Engine, variant: string, clips: Clip[], terms: (clip: Clip) => string[] | null) {
  const dir = join(RESULTS, "raw", variant);
  await mkdir(dir, { recursive: true });
  const jobs: (Job & { stamp: string })[] = [];
  for (const clip of clips) {
    const t = terms(clip);
    const stamp = await stampOf(clip, t);
    const file = join(dir, `${clip.id}.json`);
    if (!args.fresh && existsSync(file)) {
      const cached = JSON.parse(await readFile(file, "utf8")) as Cached;
      if (cached.stamp === stamp && !cached.error) continue;
    }
    jobs.push({ id: clip.id, wav: join(CLIPS, `${clip.id}.wav`), terms: t, stamp });
  }
  if (!jobs.length) { console.log(`  ${variant}: 全部已有结果`); return; }
  console.log(`  ${variant}: 转写 ${jobs.length} 段…`);
  let done = 0;
  const stats = await engine.run(jobs, async (result) => {
    const job = jobs.find((j) => j.id === result.id);
    if (!job) return;
    await writeFile(join(dir, `${result.id}.json`), JSON.stringify({ ...result, stamp: job.stamp }, null, 2) + "\n");
    done++;
    process.stdout.write(`\r    ${done}/${jobs.length} ${result.error ? "✗ " + result.id + " " + result.error.slice(0, 80) + "\n" : ""}`);
  });
  process.stdout.write("\n");
  if (stats) await writeFile(join(dir, "_stats.json"), JSON.stringify(stats) + "\n");
}

const pct = (n: number) => (n * 100).toFixed(1) + "%";
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function report(clips: Clip[], variants: { name: string; engine: Engine }[]) {
  const rows: string[] = [];
  const details: string[] = ["# 逐条结果", "", "✗ = 没认对的关键词。错误数 / 参考词数。", ""];
  const totalSeconds = clips.reduce((n, c) => n + c.seconds, 0);
  const perClip = new Map<string, { variant: string; text: string; s: Score }[]>();

  for (const { name, engine } of variants) {
    const scored: { clip: Clip; r: Cached; s: Score }[] = [];
    let failed = 0;
    for (const clip of clips) {
      const file = join(RESULTS, "raw", name, `${clip.id}.json`);
      if (!existsSync(file)) continue;
      const r = JSON.parse(await readFile(file, "utf8")) as Cached;
      if (r.error) { failed++; continue; }
      const s = score(clip.ref, r.text ?? "", clip.terms);
      scored.push({ clip, r, s });
      perClip.set(clip.id, [...(perClip.get(clip.id) ?? []), { variant: name, text: r.text ?? "", s }]);
    }
    if (!scored.length) continue;
    const mer = (list: typeof scored) => list.length ? pct(list.reduce((n, x) => n + x.s.errors, 0) / Math.max(1, list.reduce((n, x) => n + x.s.refTokens, 0))) : "—";
    const hit = scored.reduce((n, x) => n + x.s.termsHit, 0), all = scored.reduce((n, x) => n + x.s.termsTotal, 0);
    const ms = median(scored.map((x) => x.r.ms));
    const rtf = median(scored.map((x) => x.r.ms / 1000 / Math.max(0.1, x.clip.seconds)));
    const statsFile = join(RESULTS, "raw", name, "_stats.json");
    const mem = existsSync(statsFile) ? JSON.parse(await readFile(statsFile, "utf8")) as { rss_mb: number; gpu_mb: number } : null;
    const memory = mem ? `${(Math.max(mem.rss_mb, mem.gpu_mb) / 1024).toFixed(1)} GB` : "云端";
    const cost = engine.usdPerHour === null ? "未查" : engine.usdPerHour === 0 ? "0" : `$${engine.usdPerHour.toFixed(2)}`;
    rows.push(`| ${name} | ${scored.length}${failed ? `（${failed} 失败）` : ""} | **${mer(scored)}** | ${CATS.map((c) => mer(scored.filter((x) => x.clip.category === c))).join(" | ")} | ${hit}/${all} | ${Math.round(ms)} ms | ${rtf.toFixed(2)} | ${memory} | ${cost} |`);
  }

  for (const clip of clips) {
    const list = perClip.get(clip.id);
    if (!list) continue;
    details.push(`## ${clip.id} · ${CAT_LABEL[clip.category]} · ${clip.seconds.toFixed(1)} 秒`, "", `参考：${clip.ref}`, "");
    for (const { variant, text, s } of list.sort((a, b) => a.s.errors - b.s.errors)) {
      details.push(`- **${variant}**（${s.errors}/${s.refTokens}${s.missed.length ? "，✗ " + s.missed.join("、") : ""}）：${text}`);
    }
    details.push("");
  }

  const summary = [
    "# 语音识别比较：结果",
    "",
    `${clips.length} 段，共 ${totalSeconds.toFixed(0)} 秒。生成于 ${new Date().toLocaleString("zh-CN", { hour12: false })}。`,
    "",
    "| 引擎 | 段数 | 混合错误率 | 日常 | 混说 | 开发 | 关键词 | 中位耗时 | 耗时/音长 | 峰值内存 | 每小时 |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    "- 混合错误率：汉字按字、英文按词算编辑距离，除以参考的词数。忽略标点、空格、大小写；简单的中文数字和阿拉伯数字视为相同。越低越好。",
    "- 关键词：每段标的词在转写里出现了几个（忽略空格、标点、大小写，所以 \"use speech\" 也算认对了 useSpeech）。",
    "- 耗时：从拿到整段音频到拿到文字。云端包括上传和轮询；本机是模型常驻、预热之后。",
    "- 耗时/音长：处理 1 秒音频要几秒计算。本机引擎的耗电大致跟它成正比（同一台机器、同样跑在 GPU 上）。",
    "- 峰值内存：本机引擎进程的峰值（进程内存和 MLX 显存取大者，Mac 上两者共用内存）。",
    "- 「+词表」：给识别器一份该场景的词表（vocab.txt 加上同类所有段标的关键词），模拟 Zirma 按场景拼词表。",
    "",
    "引擎说明：",
    "",
    ...variants.filter((v, i, all) => all.findIndex((x) => x.engine === v.engine) === i).map((v) => `- ${v.engine.name}：${v.engine.note}`),
    "",
  ];
  await writeFile(join(RESULTS, "report.md"), summary.join("\n"));
  await writeFile(join(RESULTS, "details.md"), details.join("\n"));
  console.log("\n" + summary.slice(4, 6 + rows.length).join("\n"));
  console.log(`\n报告：${join(RESULTS, "report.md")}\n逐条：${join(RESULTS, "details.md")}`);
}

async function main() {
  const clips = (await listClips()).filter((c) => c.recorded && c.ref.trim());
  if (!clips.length) {
    console.log("还没有录好的段。先跑 node scripts/voice-bench/server.ts，在网页里录。");
    return;
  }
  const lists = await wordLists(clips);
  const wanted = args.engines?.split(",").map((s) => s.trim());
  const variants: { name: string; engine: Engine }[] = [];

  console.log(`${clips.length} 段录音\n`);
  for (const engine of ENGINES) {
    if (wanted && !wanted.includes(engine.name)) continue;
    const why = await engine.unavailable();
    if (why) { console.log(`- 跳过 ${engine.name}：${why}`); continue; }
    console.log(`- ${engine.name}`);
    const plans: [string, (c: Clip) => string[] | null][] = [];
    if (args.context !== "only") plans.push([engine.name, () => null]);
    if (engine.context && args.context !== "none") plans.push([`${engine.name}+词表`, (c) => lists[c.category]]);
    for (const [name, terms] of plans) {
      try {
        await runVariant(engine, name, clips, terms);
      } catch (error) {
        console.log(`    ✗ ${(error as Error).message}`);
      }
      variants.push({ name, engine });
    }
  }
  await mkdir(RESULTS, { recursive: true });
  await report(clips, variants);
}

await main();
