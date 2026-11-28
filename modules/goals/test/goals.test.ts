/** The goals module (docs/design/goals.md 4.1, 4.5): a goal is a folder of the notes, read by the shape of its
 * files; what the user says about a step is kept by the step's own id. Every library is a temporary folder of
 * made-up goals. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_MIGRATIONS, openWorld, type World } from "@zirma/core";
import { invokeOp, runQuery } from "@zirma/module-kit";
import { createNotesModule } from "@zirma/module-notes";
import { createGoalsModule, freeStepId, indexGoals, nameFrom, readGoal, readOutline, withStepId, writeGoal, type GoalDetail, type GoalsSnapshot } from "../src/index.ts";

function setup(locale: "zh" | "en" = "zh") {
  const root = mkdtempSync(join(tmpdir(), "zirma-goals-test-"));
  const notes = createNotesModule({ defaultRoot: root });
  const moved: string[] = [];
  const module = createGoalsModule({ notes, onMoved: (_world, from, to) => { moved.push(`${from} -> ${to}`); } });
  const world: World = openWorld(":memory:", [...CORE_MIGRATIONS, ...notes.migrations, ...module.migrations]);
  world.db.prepare("INSERT INTO core_settings (key, value, updated_at) VALUES ('locale', ?, '2026-01-01T00:00:00Z')").run(JSON.stringify(locale));
  const { library } = notes.library(world);
  let n = 0;
  const op = (name: string, input: unknown) => invokeOp(world, [notes, module], { op: name, requestId: `r${++n}`, input }).result as Record<string, unknown>;
  const goals = () => (module.snapshot!(world) as GoalsSnapshot).goals;
  const detail = (id: string) => runQuery([module], world, "goal.detail", { id }) as GoalDetail;
  const file = (path: string) => readFileSync(join(root, `${path}.md`), "utf8");
  const write = (path: string, text: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, `${path}.md`), text); };
  return { root, world, library, op, goals, detail, file, write, moved, index: () => indexGoals(world, library) };
}

test("an outline is read by its headings, whatever they say; a fence's headings are words", () => {
  const outline = readOutline([
    "---", "created: 2026-01-01", "---", "# 世界观：做产品", "", "整件事是一家很小的店。", "",
    "## 让人看得到", "把东西放到网上。", "", "### 域名", "门牌号。", "", "```", "### 不是标题", "```", "", "### 托管 ^s2", "店面。", "#### 你问过：要多少钱？", "不多。",
    "## 出处", "1. 一本书",
  ].join("\n"));
  assert.equal(outline.intro, "整件事是一家很小的店。");
  assert.deepEqual(outline.parts.map((part) => [part.title, part.text, part.items.map((item) => item.title)]), [
    ["让人看得到", "把东西放到网上。", ["域名", "托管"]], ["出处", "1. 一本书", []],
  ]);
  assert.match(outline.parts[0].items[0].body, /^门牌号。\n\n```\n### 不是标题\n```$/);
  assert.equal(outline.parts[0].items[1].id, "s2");
  assert.match(outline.parts[0].items[1].body, /#### 你问过：要多少钱？\n不多。$/);
  // A topic before any part opens a part with no title.
  assert.deepEqual(readOutline("### 只有一项\n话\n").parts.map((part) => [part.title, part.items.length]), [["", 1]]);
});

test("a step gets a block id at the end of its heading, and only once", () => {
  const text = "## 第一段\n### 放一个页面上网\n做。\n### 收第一笔钱 ^s1\n\n## 以后\n";
  assert.equal(freeStepId(text), "s2");
  const next = withStepId(text, 1, "s2")!;
  assert.match(next, /^### 放一个页面上网 \^s2$/m);
  assert.equal(withStepId(next, 1, "s3"), null);
  assert.equal(withStepId(text, 5, "s9"), null);
  assert.equal(withStepId("### 标题 ###\n", 1, "s1"), "### 标题 ^s1\n");
});

test("the goal's file: the sentence, then why; rewriting one leaves the rest as it was", () => {
  const text = "---\nzirma-goal: gabc\ndeadline: \"2027-05-31\"\npace: 3\ntags: [a]\n---\n学会线性代数，\n到能看懂论文\n\n## 我为什么要它\n\n想看懂推导。\n\n## 别的\n我自己记的。\n";
  assert.deepEqual(readGoal(text), { id: "gabc", sentence: "学会线性代数， 到能看懂论文", why: "想看懂推导。", deadline: "2027-05-31", pace: 3 });
  const next = writeGoal(text, { why: "为了换工作。\n也为了好奇。" }, "Why");
  assert.equal(readGoal(next).why, "为了换工作。\n也为了好奇。");
  assert.match(next, /tags: \[a\]\n---\n学会线性代数， 到能看懂论文\n\n## 我为什么要它\n\n为了换工作。\n也为了好奇。\n\n## 别的\n我自己记的。\n$/);
  // A file with no heading gets the one named; a deadline that is not a date is none.
  assert.equal(writeGoal("一句话\n", { why: "因为" }, "Why I want it"), "一句话\n\n## Why I want it\n\n因为\n");
  assert.equal(readGoal("---\ndeadline: someday\npace: 12\n---\nx\n").deadline, null);
  assert.equal(readGoal("---\ndeadline: someday\npace: 12\n---\nx\n").pace, null);
});

test("a folder's name comes from the sentence, cut at a clause", () => {
  assert.equal(nameFrom("学会线性代数，到能看懂机器学习论文里的推导"), "学会线性代数");
  assert.equal(nameFrom("Ship a small product people pay for"), "Ship a small product people");
  assert.equal(nameFrom("Ship a small product that people pay for, and put it online"), "Ship a small product that");
  assert.equal(nameFrom("一年内换一份后端工程师的工作"), "一年内换一份后端工程师的工作");
  assert.equal(nameFrom("  "), "Goal");
});

test("a new goal is a folder of the notes with three pages, named in the user's language", () => {
  const { op, goals, file, root, detail } = setup();
  const made = op("goal.create", { sentence: "学会线性代数，到能看懂机器学习论文里的推导" });
  assert.ok(made.id);
  assert.ok(existsSync(join(root, "目标/学会线性代数/世界观.md")) && existsSync(join(root, "目标/学会线性代数/路线.md")));
  assert.match(file("目标/学会线性代数/目标"), new RegExp(`^---\\nzirma-goal: ${made.id}\\ncreated: \\d{4}-\\d\\d-\\d\\d\\n---\\n学会线性代数，到能看懂机器学习论文里的推导\\n\\n## 我为什么要它\\n$`));
  assert.deepEqual(goals().map((goal) => [goal.id, goal.name, goal.sentence, goal.deadline, goal.pace, goal.stages]), [[made.id, "学会线性代数", "学会线性代数，到能看懂机器学习论文里的推导", null, null, []]]);
  assert.deepEqual(detail(made.id as string).pages, { folder: "目标/学会线性代数", goal: "目标/学会线性代数/目标", picture: "目标/学会线性代数/世界观", route: "目标/学会线性代数/路线" });
  // A second goal with the same words gets a folder of its own.
  op("goal.create", { sentence: "学会线性代数，再学一遍" });
  assert.deepEqual(goals().map((goal) => goal.name), ["学会线性代数", "学会线性代数 2"]);
  // In English the folder and the pages are named in English.
  const english = setup("en");
  english.op("goal.create", { sentence: "Read papers", name: "Papers" });
  assert.ok(existsSync(join(english.root, "Goals/Papers/Goal.md")) && existsSync(join(english.root, "Goals/Papers/Big picture.md")) && existsSync(join(english.root, "Goals/Papers/Route.md")));
});

test("the user changes the sentence, the why, the deadline, the pace and the name; the files follow", () => {
  const { op, goals, file, detail, moved, root } = setup();
  const id = op("goal.create", { sentence: "做一个能收款的小产品" }).id as string;
  assert.deepEqual(op("goal.update", { id, why: "想有自己的东西。", deadline: "2027-06-30", pace: 3 }), { ok: true });
  assert.deepEqual([detail(id).why, goals()[0].deadline, goals()[0].pace], ["想有自己的东西。", "2027-06-30", 3]);
  assert.match(file("目标/做一个能收款的小产品/目标"), /deadline: "2027-06-30"\npace: "?3"?\n---\n做一个能收款的小产品\n\n## 我为什么要它\n\n想有自己的东西。\n$/);
  op("goal.update", { id, deadline: null, sentence: "做一个有人付费的小产品" });
  assert.deepEqual([goals()[0].deadline, goals()[0].sentence, goals()[0].pace], [null, "做一个有人付费的小产品", 3]);
  // Renaming moves the folder; the id, and so everything recorded, stays.
  op("goal.update", { id, name: "小产品" });
  assert.ok(existsSync(join(root, "目标/小产品/路线.md")) && !existsSync(join(root, "目标/做一个能收款的小产品")));
  assert.deepEqual([goals()[0].id, goals()[0].name, detail(id).pages.route], [id, "小产品", "目标/小产品/路线"]);
  assert.deepEqual(moved, ["目标/做一个能收款的小产品 -> 目标/小产品"]);
  assert.equal(op("goal.update", { id: "nope", pace: 2 }).code, "not_found");
});

test("the big picture and the route are read from their pages; a step is done when the user says so", () => {
  const { op, goals, detail, write, file, index } = setup();
  const id = op("goal.create", { sentence: "做一个能收款的小产品" }).id as string;
  write("目标/做一个能收款的小产品/世界观", "整件事是开一家很小的店。\n\n## 让人看得到\n### 域名\n门牌号。\n### 托管\n店面。\n\n## 收钱\n### 支付服务商\n收银台。\n\n## 出处\n1. 一本书\n");
  write("目标/做一个能收款的小产品/路线", "照「先上线再收钱」走。\n\n## 第一段：放上网\n别人打得开。\n### 做一个只有一句话的页面\n**做什么** 写一页。\n### 买域名 ^buy\n\n## 第二段：收钱\n走到了再排。\n");
  assert.equal(index(), true);
  assert.equal(index(), false);
  const goal = goals()[0];
  assert.deepEqual([goal.parts, goal.topics], [2, 3]);
  assert.deepEqual(goal.stages, [
    { title: "第一段：放上网", steps: [{ key: "#1", title: "做一个只有一句话的页面", done: false }, { key: "buy", title: "买域名", done: false }] },
    { title: "第二段：收钱", steps: [] },
  ]);
  const full = detail(id);
  assert.equal(full.picture.whole, "整件事是开一家很小的店。");
  assert.deepEqual(full.picture.parts.map((part) => [part.title, part.topics.map((topic) => topic.title)]), [["让人看得到", ["域名", "托管"]], ["收钱", ["支付服务商"]]]);
  assert.deepEqual(full.picture.more, [{ title: "出处", text: "1. 一本书" }]);
  assert.equal(full.route.intro, "照「先上线再收钱」走。");
  assert.deepEqual(full.route.stages[0].steps[0], { key: "#1", title: "做一个只有一句话的页面", body: "**做什么** 写一页。", done: false });
  assert.equal(full.route.stages[1].note, "走到了再排。");

  // The first step has no id: saying it is done gives it one, in the file, and the record hangs on that.
  assert.deepEqual(op("goal.step", { id, step: "#1", done: true }), { key: "s1", done: true });
  assert.match(file("目标/做一个能收款的小产品/路线"), /^### 做一个只有一句话的页面 \^s1$/m);
  assert.deepEqual(goals()[0].stages[0].steps.map((step) => [step.key, step.done]), [["s1", true], ["buy", false]]);
  // Renamed and moved below the other step by hand: it is still done.
  write("目标/做一个能收款的小产品/路线", "## 第一段\n### 买域名 ^buy\n### 先放一页上网 ^s1\n");
  index();
  assert.deepEqual(goals()[0].stages[0].steps.map((step) => [step.title, step.done]), [["买域名", false], ["先放一页上网", true]]);
  assert.deepEqual(op("goal.step", { id, step: "s1", done: false }), { key: "s1", done: false });
  assert.equal(goals()[0].stages[0].steps[1].done, false);
  assert.equal(op("goal.step", { id, step: "nope", done: true }).code, "not_found");
  assert.equal(op("goal.step", { id, step: "#9", done: true }).code, "not_found");
});

test("a folder made by hand is a goal; a copy gets its own id; a removed goal comes back with its record", () => {
  const { op, goals, write, file, index, root } = setup();
  write("目标/日语/目标", "一年内能用日语看懂工作邮件\n");
  write("目标/不是目标/随便一页", "x\n");
  index();
  const [hand] = goals();
  assert.deepEqual([goals().length, hand.name, hand.sentence], [1, "日语", "一年内能用日语看懂工作邮件"]);
  assert.match(file("目标/日语/目标"), new RegExp(`^---\\nzirma-goal: ${hand.id}\\n---\\n`));
  // Copied in the Finder: two folders with one id in their files.
  write("目标/日语 副本/目标", file("目标/日语/目标"));
  index();
  assert.equal(new Set(goals().map((goal) => goal.id)).size, 2);
  assert.equal(goals().find((goal) => goal.name === "日语")!.id, hand.id);

  assert.deepEqual(op("goal.page", { id: hand.id, which: "route" }), { page: "目标/日语/路线" });
  write("目标/日语/路线", "## 一\n### 五十音 ^s1\n");
  index();
  op("goal.step", { id: hand.id, step: "s1", done: true });
  const removed = op("goal.remove", { id: hand.id });
  assert.ok(removed.entry);
  assert.ok(!existsSync(join(root, "目标/日语")));
  assert.deepEqual(goals().map((goal) => goal.name), ["日语 副本"]);
  assert.deepEqual(op("goal.restore", { entry: removed.entry }), { ok: true });
  const back = goals().find((goal) => goal.name === "日语")!;
  assert.deepEqual([back.id, back.stages[0].steps[0].done], [hand.id, true]);
});
