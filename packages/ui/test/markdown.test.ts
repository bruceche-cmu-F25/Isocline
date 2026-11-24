import assert from "node:assert/strict";
import { test } from "node:test";
import { inboxReadingBlocks, parseInline, parseMarkdown, plainText } from "../src/markdown.ts";

test("bold, italic, strike and code inside a line", () => {
  assert.deepEqual(parseInline("**Today (PT):** AGAI 6–7am"), [{ kind: "strong", children: ["Today (PT):"] }, " AGAI 6–7am"]);
  assert.deepEqual(parseInline("an *aside* and _another_"), ["an ", { kind: "em", children: ["aside"] }, " and ", { kind: "em", children: ["another"] }]);
  assert.deepEqual(parseInline("***both***"), [{ kind: "em", children: [{ kind: "strong", children: ["both"] }] }]);
  assert.deepEqual(parseInline("~~gone~~ `a * b` ok"), [{ kind: "del", children: ["gone"] }, " ", { kind: "code", text: "a * b" }, " ok"]);
  assert.deepEqual(parseInline("**a *b* c**"), [{ kind: "strong", children: ["a ", { kind: "em", children: ["b"] }, " c"] }]);
});

test("bold closes after Chinese punctuation with a letter right behind it", () => {
  assert.deepEqual(parseInline("**今天（PT）：**AGAI 6–7am"), [{ kind: "strong", children: ["今天（PT）："] }, "AGAI 6–7am"]);
  assert.deepEqual(parseInline("这是**重点**内容"), ["这是", { kind: "strong", children: ["重点"] }, "内容"]);
});

test("marks that are not emphasis stay as written", () => {
  assert.deepEqual(parseInline("2 * 3 * 4"), ["2 * 3 * 4"]);
  assert.deepEqual(parseInline("snake_case_name and file_name.ts"), ["snake_case_name and file_name.ts"]);
  assert.deepEqual(parseInline("**still arriving"), ["**still arriving"]);
  assert.deepEqual(parseInline("about ~5 minutes"), ["about ~5 minutes"]);
  assert.deepEqual(parseInline("\\*not italic\\* &amp; `open"), ["*not italic* & `open"]);
});

test("links: written, bare, and never to anything but the web or mail", () => {
  assert.deepEqual(parseInline("see [the **docs**](https://example.com/a_(b)) now"), [
    "see ", { kind: "link", url: "https://example.com/a_(b)", children: ["the ", { kind: "strong", children: ["docs"] }] }, " now",
  ]);
  assert.deepEqual(parseInline("at https://example.com/x_y_z."), ["at ", { kind: "link", url: "https://example.com/x_y_z", children: ["https://example.com/x_y_z"] }, "."]);
  assert.deepEqual(parseInline("**https://example.com**"), [{ kind: "strong", children: [{ kind: "link", url: "https://example.com/", children: ["https://example.com"] }] }]);
  assert.deepEqual(parseInline("<mailto:a@example.com>"), [{ kind: "link", url: "mailto:a@example.com", children: ["mailto:a@example.com"] }]);
  assert.deepEqual(parseInline("[click](javascript:alert(1)) [file](src/a.ts)"), ["click file"]);
  assert.deepEqual(parseInline("[1] is not a link (really)"), ["[1] is not a link (really)"]);
  // An image is a link to it: the page fetches nothing a reply names.
  assert.deepEqual(parseInline("![chart](https://example.com/c.png)"), [{ kind: "link", url: "https://example.com/c.png", children: ["chart"] }]);
});

test("paragraphs, headings, rules; a line break stays a line break", () => {
  assert.deepEqual(parseMarkdown("# Title\n\nfirst\nsecond\n\n---\n#tag is text"), [
    { kind: "heading", level: 1, children: ["Title"] },
    { kind: "p", children: ["first", { kind: "break" }, "second"] },
    { kind: "rule" },
    { kind: "p", children: ["#tag is text"] },
  ]);
  assert.deepEqual(parseMarkdown("<b>html</b> is text"), [{ kind: "p", children: ["<b>html</b> is text"] }]);
});

test("lists: nested, numbered, tasks, tight and loose", () => {
  assert.deepEqual(parseMarkdown("Do:\n- one\n  - inner\n- two"), [
    { kind: "p", children: ["Do:"] },
    { kind: "list", ordered: false, start: 1, loose: false, items: [
      { blocks: [{ kind: "p", children: ["one"] }, { kind: "list", ordered: false, start: 1, loose: false, items: [{ blocks: [{ kind: "p", children: ["inner"] }] }] }] },
      { blocks: [{ kind: "p", children: ["two"] }] },
    ] },
  ]);
  const numbered = parseMarkdown("3. **A**\n   - sub\n\n4. B");
  assert.equal(numbered.length, 1);
  assert.partialDeepStrictEqual(numbered[0], { kind: "list", ordered: true, start: 3, loose: true });
  assert.deepEqual(parseMarkdown("- [x] done\n- [ ] open"), [{ kind: "list", ordered: false, start: 1, loose: false, items: [
    { checked: true, blocks: [{ kind: "p", children: ["done"] }] }, { checked: false, blocks: [{ kind: "p", children: ["open"] }] },
  ] }]);
  // A year at the start of a line does not cut the paragraph into a list; nor does a bold line start one.
  assert.deepEqual(parseMarkdown("It was\n2026. A good year.").length, 1);
  assert.deepEqual(parseMarkdown("**bold** line")[0]!.kind, "p");
  assert.deepEqual(parseMarkdown("* * *"), [{ kind: "rule" }]);
});

test("fenced code keeps its text as written, and an open fence runs to the end", () => {
  assert.deepEqual(parseMarkdown("```ts\nconst a = **1**;\n\n# no\n```\nafter"), [
    { kind: "code", lang: "ts", text: "const a = **1**;\n\n# no" }, { kind: "p", children: ["after"] },
  ]);
  assert.deepEqual(parseMarkdown("```\nstill arriving"), [{ kind: "code", lang: "", text: "still arriving" }]);
});

test("quotes and tables", () => {
  assert.deepEqual(parseMarkdown("> quoted\n> - item"), [{ kind: "quote", blocks: [
    { kind: "p", children: ["quoted"] }, { kind: "list", ordered: false, start: 1, loose: false, items: [{ blocks: [{ kind: "p", children: ["item"] }] }] },
  ] }]);
  assert.deepEqual(parseMarkdown("| When | What |\n|:--|--:|\n| 10am | `a|b` |\n| noon |\nafter"), [
    { kind: "table", align: ["left", "right"], head: [["When"], ["What"]], rows: [[["10am"], [{ kind: "code", text: "a|b" }]], [["noon"], []]] },
    { kind: "p", children: ["after"] },
  ]);
  assert.equal(parseMarkdown("a | b\n---")[0]!.kind, "p", "a rule under a line with a bar is not a table");
});

test("a reply as plain text, for a notification", () => {
  assert.equal(plainText("**Today (PT):** AGAI 6–7am\n\n## Mail\n- [reply](https://example.com) to *Leo*\n- `rent` due"), "Today (PT): AGAI 6–7am\nMail\n• reply to Leo\n• rent due");
  assert.equal(plainText("1. one\n2. two"), "1. one\n2. two");
  assert.equal(plainText(""), "");
  // A sectioned result's tags and citations are for the page that draws it, not for a preview.
  assert.equal(plainText("先交报销。(mail:m1)\n\n## 邮件\n- [风险] 新设备登录 (mail:m2)\n- 10:00 评审 (event:e1)"), "先交报销。\n邮件\n• 新设备登录\n• 10:00 评审");
});


test("Inbox reading separates bold section labels while preserving the saved order, punctuation and inline markup", () => {
  const parsed = parseMarkdown("**Today [PT](https://example.com):** [Design](https://example.com), then `lunch`.\n\n**截止**：中午前；下午提醒。\n\n**Mail**:[RSVP](https://example.org)");
  const saved = structuredClone(parsed);
  assert.deepEqual(inboxReadingBlocks(parsed), [
    { kind: "heading", level: 1, children: parseInline("**Today [PT](https://example.com):**") },
    { kind: "p", children: parseInline(" [Design](https://example.com), then `lunch`.") },
    { kind: "heading", level: 1, children: [...parseInline("**截止**"), "："] },
    { kind: "p", children: ["中午前；下午提醒。"] },
    { kind: "heading", level: 1, children: [...parseInline("**Mail**"), ":"] },
    { kind: "p", children: parseInline("[RSVP](https://example.org)") },
  ]);
  assert.deepEqual(parsed, saved);
});

test("Inbox reading keeps headings and nested Markdown, and leaves unlabeled prose and empty labels alone", () => {
  const blocks = parseMarkdown("## Authored\n\n**重点：**正文\n\nBody: **inline:** text.\n\n**Just bold** text.\n\n**Alone:**\n\n**：** text\n\n> **Quote:** quoted\n\n- **Item:** listed\n\n| Title |\n| --- |\n| **Cell:** value |\n\n~~~\n**Code:** literal\n~~~");
  const read = inboxReadingBlocks(blocks);
  assert.deepEqual(read.slice(0, 3), [
    blocks[0],
    { kind: "heading", level: 3, children: parseInline("**重点：**") },
    { kind: "p", children: ["正文"] },
  ]);
  assert.deepEqual(read.slice(3), blocks.slice(2));
});
