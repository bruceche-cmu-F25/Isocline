import assert from "node:assert/strict";
import { test } from "node:test";
import { readBriefEditorial, readMailRow } from "../src/briefEditorial.ts";

test("legacy brief separates independently worded mail facts and an inline recommendation", () => {
  const report = readBriefEditorial("**Schedule (PT):** Call 10–11am; offsite 1–4pm.\n\n**Due today:** Homework before noon; none overdue—I’d start with homework.\n\n**Mail / decisions:** An RSVP is optional; applications close at noon, the invitation needs consideration, Acme renews November 28 if payment is on file, and two notices warrant review.");
  assert.deepEqual(report.agenda, ["Call 10–11am", "offsite 1–4pm."]);
  assert.deepEqual(report.deadlines, ["Homework before noon", "none overdue"]);
  assert.deepEqual(report.advice, ["I’d start with homework."]);
  assert.deepEqual(report.mail, ["An RSVP is optional", "applications close at noon", "the invitation needs consideration", "Acme renews November 28 if payment is on file", "two notices warrant review."]);
});

test("preserves qualified dates, quoted or linked text, and unknown sections", () => {
  const result = readBriefEditorial('**Mail / decisions:** Check on November 20, 2026, if your subscription renews.\n\n**Mail:** Read [a;b](https://example.com/a;b) first.\n\n## Background\nA separate observation.\n\n## Mail / decisions\n- It renews, unless the sponsor closes it.\n- Optional reply.');
  assert.deepEqual(result.mail, ["Check on November 20, 2026, if your subscription renews.", "Read [a;b](https://example.com/a;b) first.", "It renews, unless the sponsor closes it.", "Optional reply."]);
  assert.match(result.notes.join(" "), /Background/);
});

test("Chinese authored bullets and historical labels preserve their original ordering and qualifiers", () => {
  const result = readBriefEditorial("## 日程\n- 上午开会\n- 全天报名\n\n## 到期事项\n- 周五前提交作业\n\n## 邮件与决定\n- 如已报名，无需回复\n\n## 建议先做\n- 先做作业\n\n**Mail / todos / decisions:** No open todos.");
  assert.deepEqual(result.agenda, ["上午开会", "全天报名"]);
  assert.deepEqual(result.deadlines, ["周五前提交作业"]);
  assert.deepEqual(result.mail, ["如已报名，无需回复", "No open todos."]);
  assert.deepEqual(result.advice, ["先做作业"]);
});

test("edition access notes never become mail or approval requests", () => {
  const result = readBriefEditorial("**Mail / decisions:** A reply is optional—pending assistant approvals aren’t visible here, and nothing was changed.");
  assert.deepEqual(result.mail, ["A reply is optional"]);
  assert.deepEqual(result.coverage, ["pending assistant approvals aren’t visible here, and nothing was changed."]);
});

test("a mail row gives up its tag and its message id in either language, and keeps brackets of its own", () => {
  assert.deepEqual(readMailRow("[Risk] A new device signed in. (mail:18c2f-a_9)"), { text: "A new device signed in.", kind: "risk", mail: "18c2f-a_9" });
  assert.deepEqual(readMailRow("【等你】周四的讨论改期，邀请还没回（邮件：abc123）。"), { text: "周四的讨论改期，邀请还没回。", kind: "decide", mail: "abc123" });
  assert.deepEqual(readMailRow("**[Due 2026-12-02]** Practice test closes at 08:59 (mail:q1)"), { text: "Practice test closes at 08:59", kind: "due", due: "2026-12-02", mail: "q1" });
  assert.deepEqual(readMailRow("[期限] 账单今天到期"), { text: "账单今天到期", kind: "due" });
  assert.deepEqual(readMailRow("[告知] 图书馆周末闭馆"), { text: "图书馆周末闭馆", kind: "fyi" });
  assert.deepEqual(readMailRow("[Acme] renews on Friday (see mail)"), { text: "[Acme] renews on Friday (see mail)", kind: null });
  assert.deepEqual(readMailRow("Read [the notice](https://example.com/a) first."), { text: "Read [the notice](https://example.com/a) first.", kind: null });
  assert.deepEqual(readMailRow("[FYI]"), { text: "[FYI]", kind: null });
  const rows = readBriefEditorial("## Mail / decisions\n- [Decide] Reply to Lin (mail:m1)\n- [Risk] Check the sign-in (mail:m2)\n\n## Suggested start\n- Check the sign-in first. (mail:m2)").mail;
  assert.deepEqual(rows.map((row) => readMailRow(row).kind), ["decide", "risk"]);
});
