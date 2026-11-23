import assert from "node:assert/strict";
import { test } from "node:test";
import { readRow, readSections } from "../src/sections.ts";

test("a result reads as its lead, then one section per heading it wrote, whatever the headings say", () => {
  const read = readSections("Start with the sign-in check. (mail:m2)\n\n## 本周回顾\n- 读完两篇论文\n- 健身三次\n\n## Mail / decisions\n- [Decide] Reply to Lin (mail:m1)\n- [Risk] Check the sign-in (mail:m2)\n\n## Garden\nWater the tomatoes.\n\nRepot the basil.");
  assert.deepEqual(read.lead, [{ text: "Start with the sign-in check.", kind: null, ref: { kind: "mail", id: "m2" } }]);
  assert.deepEqual(read.sections.map((section) => [section.title, section.rows.length, section.about]), [
    ["本周回顾", 2, null], ["Mail / decisions", 2, "mail"], ["Garden", 2, null],
  ]);
  assert.deepEqual(read.sections[1]!.rows.map((row) => row.kind), ["decide", "risk"]);
});

test("a section is about what most of its rows link to: messages, events or todos", () => {
  const read = readSections("## A\n- Standup (event:e1)\n- Lunch (日程：e2)\n- Bring slides\n\n## B\n- Hand in report (todo:t1)\n- [Due 2026-12-02] Visa (mail:v1)\n- Call bank (待办: t2)");
  assert.deepEqual(read.sections.map((section) => section.about), ["event", "todo"]);
  assert.deepEqual(read.sections[0]!.rows.map((row) => row.ref?.id ?? null), ["e1", "e2", null]);
});

test("older editions with bold labels and prose still split into sections", () => {
  const read = readSections("**Schedule (PT):** Call 10–11am; offsite 1–4pm.\n\n**Mail / decisions:** An RSVP is optional.");
  assert.deepEqual(read.sections.map((section) => [section.title, section.rows.map((row) => row.text)]), [
    ["Schedule (PT)", ["Call 10–11am; offsite 1–4pm."]], ["Mail / decisions", ["An RSVP is optional."]],
  ]);
  assert.deepEqual(read.lead, []);
});

test("a sub-item stays with the item above it", () => {
  const read = readSections("## Mail\n1. **UHS** registration hold\n   - reply by Dec 16\n   - see the form\n2. RSVP for Friday");
  assert.deepEqual(read.sections[0]!.rows.map((row) => row.text), ["**UHS** registration hold\n   - reply by Dec 16\n   - see the form", "RSVP for Friday"]);
});

test("code blocks stay whole, and an empty heading is dropped", () => {
  const read = readSections("## Empty\n\n## Script\n```\n## not a heading\n- not a row\n```");
  assert.deepEqual(read.sections.map((section) => section.title), ["Script"]);
  assert.match(read.sections[0]!.rows[0]!.text, /## not a heading\n- not a row/);
});

test("a row gives up its tag and its id in either language, and keeps brackets of its own", () => {
  assert.deepEqual(readRow("[Risk] A new device signed in. (mail:18c2f-a_9)"), { text: "A new device signed in.", kind: "risk", ref: { kind: "mail", id: "18c2f-a_9" } });
  assert.deepEqual(readRow("【等你】周四的讨论改期，邀请还没回（邮件：abc123）。"), { text: "周四的讨论改期，邀请还没回。", kind: "decide", ref: { kind: "mail", id: "abc123" } });
  assert.deepEqual(readRow("**[Due 2026-12-02]** Practice test closes at 08:59 (mail:q1)"), { text: "Practice test closes at 08:59", kind: "due", due: "2026-12-02", ref: { kind: "mail", id: "q1" } });
  assert.deepEqual(readRow("[期限] 账单今天到期 (todo:x1)"), { text: "账单今天到期", kind: "due", ref: { kind: "todo", id: "x1" } });
  assert.deepEqual(readRow("[告知] 图书馆周末闭馆"), { text: "图书馆周末闭馆", kind: "fyi" });
  assert.deepEqual(readRow("[Acme] renews on Friday (see mail)"), { text: "[Acme] renews on Friday (see mail)", kind: null });
  assert.deepEqual(readRow("Read [the notice](https://example.com/a) first."), { text: "Read [the notice](https://example.com/a) first.", kind: null });
  assert.deepEqual(readRow("[FYI]"), { text: "[FYI]", kind: null });
});
