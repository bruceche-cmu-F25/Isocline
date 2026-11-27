/** The save rules of docs/research/notes-editor.md §4 (tests 1–4 and 6): a page read and written back is the same
 * file; a change touches only its block and the blank lines beside it; what is written reads back as the editor
 * shows it; what the editor cannot draw is never rewritten. Every sample is a made-up note. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assignSources, blanksBefore, findTask, taskRef, wordsKey, comparable, compose, fitDepths, parsePage, readBlocks, setProperty, writeBlocks, type Block, type EditBlock, type Inline } from "../src/markdown/index.ts";

const OBSIDIAN = `---
icon: book
tags: [reading, 2026]
aliases:
  - 读书
---

# 读书笔记

这本书讲两个系统：[[系统一|快的那个]]和 [[系统二#定义]]。见 ![[封面.png]] 和 ![[附录]]。

> [!note] 提示
> 这一段是 callout，不该被改写。

- [ ] 读完第一章
  - [x] 记下要点 **重要**
    - 第三层 *斜体* 和 \`代码\`
- [x] 给 [[林晓]] 推荐

\`\`\`dataview
TABLE file.mtime FROM #reading
\`\`\`

| 章 | 页数 |
|:--|--:|
| 一 | 30 |

<details><summary>折叠</summary>
里面的东西
</details>

公式 $e^{i\\pi}+1=0$ 在行内，%%这是注释%%，==高亮== 和 #标签 ^block-1

$$
a_b*c*d
$$

脚注在这里[^1]。

[^1]: 这是脚注的内容。

[ref]: https://example.com/ref "Title"
`;

const WINDOWS = "﻿# Title\r\n\r\nFirst line\r\nsecond line of the same paragraph\r\n\r\n* star item\r\n* another\r\n\r\nLast paragraph without a final newline";

const MIXED = `Setext 标题
==========

1. 第一
2. 第二
   1. 嵌套的第一

> 引用一行

---

__粗__ 和 _斜_ 写法不同，一样的意思。<br>换行
Trailing hard break
next line

\`\`\`\`md
\`\`\`js
inside
\`\`\`
\`\`\`\`

+ plus bullet
+ two

***

结束。`;

const SAMPLES: Record<string, string> = {
  obsidian: OBSIDIAN, windows: WINDOWS, mixed: MIXED,
  empty: "", onlyFront: "---\ntitle: x\n---\n", noNewline: "just words", blankLines: "\n\n\nA\n\n\n\nB\n\n\n",
};

const asEditor = (text: string): EditBlock[] => parsePage(text).blocks.map((source, i) => ({ ...structuredClone(source.block), from: i }));

/** A small fixed-seed random number generator, so a failure can be run again. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}



function assertReadsBack(text: string, blocks: readonly Block[], what: string) {
  const read = readBlocks(text).map(comparable);
  assert.deepEqual(read, blocks.map(comparable), `${what}: reads back as the editor showed it\n${text}`);
}

const editable = (block: Block) => block.kind === "paragraph" || block.kind === "heading" || block.kind === "item" || block.kind === "quote";

function withWords(block: Block, words: string): Block {
  if (!editable(block)) return block;
  return { ...block, content: [...(block as { content: Inline[] }).content, { t: "text", text: words }] } as Block;
}

test("1. a page read and written back unchanged is the same file, byte for byte", () => {
  for (const [name, text] of Object.entries(SAMPLES)) {
    const result = compose(parsePage(text), asEditor(text));
    assert.ok(result.ok, name);
    assert.equal(result.text, text, name);
  }
});

test("1b. unchanged blocks are recognised even when the editor holds copies of them", () => {
  for (const [name, text] of Object.entries(SAMPLES)) {
    const blocks = JSON.parse(JSON.stringify(asEditor(text))) as EditBlock[];
    const result = compose(parsePage(text), blocks);
    assert.ok(result.ok && result.text === text, name);
  }
});

test("2. changing one block changes only its lines, and at most a blank line beside it", () => {
  for (const [name, text] of Object.entries(SAMPLES)) {
    const page = parsePage(text);
    page.blocks.forEach((source, i) => {
      if (!editable(source.block)) return;
      const blocks = asEditor(text);
      blocks[i] = { ...withWords(blocks[i], " 加一句 more"), from: i } as EditBlock;
      const result = compose(page, blocks);
      assert.ok(result.ok, `${name} #${i}`);
      const before = page.body.split(/\r?\n/), after = (result.text.startsWith("﻿") ? result.text.slice(1) : result.text).split(/\r?\n/);
      let head = 0;
      while (head < before.length && before[head] === after[head]) head++;
      let tail = 0;
      while (tail < before.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
      const firstLine = page.body.slice(0, source.start).split(/\r?\n/).length - 1;
      const lastLine = page.body.slice(0, source.end).split(/\r?\n/).length - 1;
      assert.ok(head >= firstLine - 1, `${name} #${i}: nothing before the block changed (from line ${head}, block at ${firstLine})`);
      assert.ok(before.length - tail <= lastLine + 2, `${name} #${i}: nothing after the block changed`);
      assertReadsBack(result.text, blocks, `${name} #${i}`);
    });
  }
});

test("3. a heading turned into words stays two paragraphs (# 甲\\n乙)", () => {
  const text = "# 甲\n乙\n";
  const blocks = asEditor(text);
  blocks[0] = { kind: "paragraph", content: [{ t: "text", text: "甲" }], from: 0 };
  const result = compose(parsePage(text), blocks);
  assert.ok(result.ok);
  assert.deepEqual(readBlocks(result.text).map((block) => block.kind), ["paragraph", "paragraph"]);
  assert.equal(result.text, "甲\n\n乙\n");
});

test("3b. random edits (words, kinds, insert, delete, move) read back as the editor shows them", () => {
  const next = random(20261126);
  const kinds = ["paragraph", "heading", "item", "quote"] as const;
  for (const [name, text] of Object.entries(SAMPLES)) {
    for (let round = 0; round < 40; round++) {
      const page = parsePage(text);
      let blocks = asEditor(text);
      for (let step = 0; step < 1 + Math.floor(next() * 4); step++) {
        const at = Math.floor(next() * Math.max(1, blocks.length));
        const choice = next();
        if (choice < 0.3 && blocks[at] && editable(blocks[at])) blocks[at] = { ...withWords(blocks[at], next() < 0.5 ? " *星号* 和 [括号] _下划线_ # 1. -" : " plain"), from: blocks[at].from } as EditBlock;
        else if (choice < 0.5 && blocks[at] && editable(blocks[at])) {
          const kind = kinds[Math.floor(next() * kinds.length)];
          const content = (blocks[at] as unknown as { content: Inline[] }).content;
          const from = blocks[at].from;
          blocks[at] = (kind === "heading" ? { kind, level: 2, content, from } : kind === "item" ? { kind, list: "bullet", depth: 0, content, from } : { kind, content, from }) as EditBlock;
        } else if (choice < 0.7) blocks.splice(at, 0, { kind: "paragraph", content: [{ t: "text", text: `新的一段 ${round}` }] });
        else if (choice < 0.85 && blocks.length) blocks.splice(at, 1);
        else if (blocks.length > 1) {
          const [moved] = blocks.splice(at, 1);
          blocks.splice(Math.floor(next() * blocks.length), 0, moved);
        }
      }
      // Nested items need a parent above them; the editor keeps that, and compose fits any list that does not.
      blocks = fitDepths(blocks);
      const result = compose(page, blocks);
      assert.ok(result.ok, `${name} round ${round}: ${!result.ok ? result.reason : ""}`);
      assertReadsBack(result.text, blocks, `${name} round ${round}`);
    }
  }
});

test("4. what the editor cannot draw is kept byte for byte through edits beside it", () => {
  const page = parsePage(OBSIDIAN);
  const blocks = asEditor(OBSIDIAN);
  const sentence = blocks.findIndex((block) => block.kind === "paragraph" && JSON.stringify(block).includes("公式"));
  blocks[sentence] = { ...withWords(blocks[sentence], " 改了这一句。"), from: sentence } as EditBlock;
  const result = compose(page, blocks);
  assert.ok(result.ok);
  for (const kept of ["$$\na_b*c*d\n$$", "$e^{i\\pi}+1=0$", "%%这是注释%%", "> [!note] 提示\n> 这一段是 callout，不该被改写。", "| 章 | 页数 |\n|:--|--:|\n| 一 | 30 |", "```dataview", "[^1]: 这是脚注的内容。", "[ref]: https://example.com/ref \"Title\"", "<details><summary>折叠</summary>"]) {
    assert.ok(result.text.includes(kept), `kept: ${kept}`);
  }
  // The link with an alias is one piece, and stays as written when the words around it change.
  const link = page.blocks.flatMap((source) => ("content" in source.block ? source.block.content : [])).find((run) => run.t === "wiki" && run.alias);
  assert.deepEqual(link, { t: "wiki", target: "系统一", alias: "快的那个", raw: "[[系统一|快的那个]]" });
  const linked = blocks.findIndex((block) => JSON.stringify(block).includes("系统一"));
  blocks[linked] = { ...withWords(blocks[linked], "（改）"), from: linked } as EditBlock;
  const again = compose(page, blocks);
  assert.ok(again.ok && again.text.includes("[[系统一|快的那个]]和 [[系统二#定义]]") && again.text.includes("![[封面.png]]"));
});

test("4b. words that look like markup are written so they read back as words", () => {
  const words = "a*b*c _x_ snake_case [x](y) <div> `tick` ~~s~~ $5 &amp; %%no%% 2*3";
  const blocks: Block[] = [
    { kind: "paragraph", content: [{ t: "text", text: words }] },
    { kind: "paragraph", content: [{ t: "text", text: "# not a heading" }] },
    { kind: "paragraph", content: [{ t: "text", text: "1. not a list\n- nor this\n> nor a quote\n===" }] },
    { kind: "heading", level: 2, content: [{ t: "text", text: "C#" }] },
    { kind: "item", list: "task", depth: 0, checked: true, content: [{ t: "text", text: "done" }] },
    { kind: "item", list: "bullet", depth: 1, content: [{ t: "text", text: "nested" }, { t: "text", text: " bold ", marks: ["strong"] }, { t: "text", text: "both", marks: ["strong", "em"] }] },
    { kind: "paragraph", content: [{ t: "text", text: "see " }, { t: "text", text: "the site", href: "https://example.com/a (b)" }, { t: "text", text: " and " }, { t: "wiki", target: "页", alias: "别名", raw: "[[页|别名]]" }] },
    { kind: "code", lang: "js", text: "```\nfence inside\n```" },
    { kind: "quote", content: [{ t: "text", text: "two\nlines" }] },
    { kind: "rule" },
  ];
  const text = writeBlocks(blocks);
  assertReadsBack(text, blocks, "markup-like words");
});

test("4c. a page saved from Windows keeps its line endings, its byte order mark and its missing final newline", () => {
  const page = parsePage(WINDOWS);
  const blocks = asEditor(WINDOWS);
  blocks.push({ kind: "paragraph", content: [{ t: "text", text: "added" }] });
  const result = compose(page, blocks);
  assert.ok(result.ok);
  assert.ok(result.text.startsWith("﻿# Title\r\n"));
  assert.ok(!/[^\r]\n/.test(result.text), "every line ends in CRLF");
});

test("properties: one key changes, nothing else in the file", () => {
  assert.equal(setProperty(OBSIDIAN, "icon", "cup"), OBSIDIAN.replace("icon: book", "icon: cup"));
  assert.equal(setProperty(OBSIDIAN, "icon", null), OBSIDIAN.replace("icon: book\n", ""));
  assert.equal(setProperty("Words\n", "icon", "leaf"), "---\nicon: leaf\n---\nWords\n");
  assert.equal(setProperty("---\ntitle: x\n---\nBody\n", "created", "2026-11-26"), "---\ntitle: x\ncreated: \"2026-11-26\"\n---\nBody\n");
  assert.equal(setProperty(WINDOWS, "icon", "doc").slice(0, 22), "﻿---\r\nicon: doc\r\n---\r\n");
});

test("6. a page of thousands of lines: read, change one block, write and read back, quickly", () => {
  const parts: string[] = ["---\nicon: doc\n---\n"];
  for (let i = 0; i < 600; i++) {
    parts.push(`## 第 ${i} 节\n\n这是第 ${i} 段，里面有 **粗体**、[[链接 ${i}]] 和一些中文字。\n\n- 第一项 ${i}\n  - 嵌套 ${i}\n- 第二项\n\n> 引用 ${i}\n\n| a | b |\n|---|---|\n| ${i} | x |\n`);
  }
  const text = parts.join("\n");
  const lines = text.split("\n").length;
  assert.ok(lines > 5000, `${lines} lines`);
  const started = performance.now();
  const page = parsePage(text);
  const read = performance.now();
  const blocks = page.blocks.map((source, i) => ({ ...source.block, from: i })) as EditBlock[];
  const middle = Math.floor(blocks.length / 2);
  blocks[middle] = { ...withWords(blocks[middle], " 改"), from: middle } as EditBlock;
  const result = compose(page, blocks);
  const done = performance.now();
  assert.ok(result.ok);
  const changedLines = result.text.split("\n").filter((line, i) => line !== text.split("\n")[i]);
  assert.equal(changedLines.length, 1, "one line changed, where the changed block is");
  // Measured, not a promise: printed for the record (research §5), with a loose ceiling.
  console.log(`  ${lines} lines: read ${(read - started).toFixed(0)} ms, write and read back ${(done - read).toFixed(0)} ms`);
  assert.ok(done - started < 10_000);
});

test("the editor keeps no ids: which block each one was read from is found again, and the file comes back the same", () => {
  for (const [name, text] of Object.entries(SAMPLES)) {
    const page = parsePage(text);
    const plain = page.blocks.map((source) => structuredClone(source.block));
    const result = compose(page, assignSources(page, plain));
    assert.ok(result.ok && result.text === text, `${name}: unchanged`);
    page.blocks.forEach((source, i) => {
      if (!editable(source.block)) return;
      const edited = plain.map((block, k) => (k === i ? withWords(block, " 改") : block));
      const again = compose(page, assignSources(page, edited));
      assert.ok(again.ok, `${name} #${i}`);
      const before = page.body.split(/\r?\n/), after = (again.text.startsWith("\uFEFF") ? again.text.slice(1) : again.text).split(/\r?\n/);
      let head = 0;
      while (head < before.length && before[head] === after[head]) head++;
      let tail = 0;
      while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
      const blockLines = page.body.slice(source.start, source.end).split(/\r?\n/).length;
      assert.ok(before.length - head - tail <= blockLines + 1, `${name} #${i}: only the block's lines changed`);
    });
  }
  // An edited star item keeps its star.
  const stars = parsePage("* one\n* two\n");
  const edited = assignSources(stars, [stars.blocks[0].block, withWords(stars.blocks[1].block, "!")]);
  const out = compose(stars, edited);
  assert.ok(out.ok && out.text === "* one\n* two!\n");
});

test("8. a to-do in a note is known by its words and which of the same words it is", () => {
  const blocks = readBlocks("- [ ] 联系客户\n- [ ] 写周报\n- [ ]   联系客户  \n- 联系客户\n");
  assert.equal(taskRef("lib", "周会", blocks, 0), `note:lib:周会#${wordsKey("联系客户")}:0`);
  assert.equal(taskRef("lib", "周会", blocks, 2), `note:lib:周会#${wordsKey("联系客户")}:1`, "the second one with the same words");
  assert.equal(taskRef("lib", "周会", blocks, 3), null, "not a to-do");
  assert.equal(findTask(blocks, wordsKey("联系客户"), 1), 2);
  assert.equal(findTask(blocks, wordsKey("写周报"), 0), 1);
  assert.equal(findTask(blocks, wordsKey("改了的字"), 0), -1, "words that changed are not guessed");
  // Known weakness (research 3.5): a new same-worded to-do above the first shifts which one is "second".
  const added = readBlocks("- [ ] 联系客户\n- [ ] 联系客户\n- [ ] 写周报\n- [ ] 联系客户\n");
  assert.equal(findTask(added, wordsKey("联系客户"), 1), 1);
});

test("empty lines the editor shows are blank lines in the file, and come back as empty lines", () => {
  const text = "A\n\n\n\nB\n\n- one\n\n\n- two\n";
  const page = parsePage(text);
  assert.deepEqual(blanksBefore(page), [0, 2, 0, 1]);
  const as = (blanks: number[]) => page.blocks.map((source, i) => ({ ...source.block, from: i, blankBefore: blanks[i] })) as EditBlock[];
  const same = compose(page, as([0, 2, 0, 1]));
  assert.ok(same.ok && same.text === text, "as the file had them: byte for byte");
  const fewer = compose(page, as([0, 0, 0, 0]));
  assert.ok(fewer.ok && fewer.text === "A\n\nB\n\n- one\n- two\n", fewer.ok ? fewer.text : "");
  const more = compose(page, as([0, 1, 3, 1]));
  assert.ok(more.ok && more.text === "A\n\n\nB\n\n\n\n\n- one\n\n\n- two\n", more.ok ? more.text : "");
  assert.deepEqual(blanksBefore(parsePage(more.ok ? more.text : "")), [0, 1, 3, 1], "read again: the same empty lines");
  // Without a count (callers that do not know), the file's own gaps stay.
  const unknown = compose(page, page.blocks.map((source, i) => ({ ...source.block, from: i })));
  assert.ok(unknown.ok && unknown.text === text);
});

test("a table is a block: its cells are words, written back as a GFM table; untouched, byte for byte", () => {
  const text = "| 豆子 | 水温 |\n|:--|--:|\n| 耶加雪菲 | **94** |\n| 哥伦比亚 | 92 |\n";
  const page = parsePage(text);
  const [first] = page.blocks;
  assert.equal(first.block.kind, "table");
  const table = first.block as Extract<Block, { kind: "table" }>;
  assert.deepEqual(table.align, ["left", "right"]);
  assert.deepEqual(table.rows[1][1], [{ t: "text", text: "94", marks: ["strong"] }]);
  assert.ok(compose(page, asEditor(text)).ok && (compose(page, asEditor(text)) as { text: string }).text === text);
  const edited: EditBlock = { ...table, rows: [...table.rows, [[{ t: "text", text: "新豆 | 有竖线" }], [{ t: "text", text: "93", marks: ["code"] }]]], from: 0 };
  const out = compose(page, [edited]);
  assert.ok(out.ok, out.ok ? "" : out.reason);
  // An edited table is laid out in one form (research 3.6); only that table.
  assert.equal(out.text, "| 豆子 | 水温 |\n| :-- | --: |\n| 耶加雪菲 | **94** |\n| 哥伦比亚 | 92 |\n| 新豆 \\| 有竖线 | `93` |\n");
  assertReadsBack(out.text, [edited], "a table with a pipe in a cell");
});

test("a one-paragraph callout is a block: type, title and words; longer callouts stay as written", () => {
  const text = "> [!tip]- 小提示\n> 先**焖蒸** 30 秒。\n\n> [!note]\n> 第一段\n>\n> 第二段\n";
  const page = parsePage(text);
  assert.deepEqual(page.blocks[0].block, { kind: "callout", type: "tip", fold: "-", title: "小提示", content: [{ t: "text", text: "先" }, { t: "text", text: "焖蒸", marks: ["strong"] }, { t: "text", text: " 30 秒。" }] });
  assert.equal(page.blocks[1].block.kind, "raw", "two paragraphs: kept as written");
  const edited = { ...(page.blocks[0].block as Extract<Block, { kind: "callout" }>), title: "新标题", from: 0 } as EditBlock;
  const out = compose(page, [edited, { ...page.blocks[1].block, from: 1 }]);
  assert.ok(out.ok);
  assert.equal(out.text, "> [!tip]- 新标题\n> 先**焖蒸** 30 秒。\n\n> [!note]\n> 第一段\n>\n> 第二段\n");
  const bare = writeBlocks([{ kind: "callout", type: "warning", fold: "", title: "", content: [] }]);
  assert.equal(bare, "> [!warning]\n");
  assertReadsBack(bare, [{ kind: "callout", type: "warning", fold: "", title: "", content: [] }], "a callout with nothing but its type");
});
