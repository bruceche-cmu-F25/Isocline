import assert from "node:assert/strict";
import { test } from "node:test";
import { firstSentences, forSpeech, sentences } from "../src/speech/spoken.ts";

test("a reply read aloud: its words, without code, addresses, tables or marks", () => {
  const reply = [
    "## 今天",
    "- **十点**组会，见 [日历](https://calendar.google.com/x)",
    "- 改了 `useSpeech.ts`",
    "",
    "| a | b |",
    "|---|---|",
    "```ts",
    "const x = 1;",
    "```",
    "详情 https://example.com/very/long",
  ].join("\n");
  assert.equal(forSpeech(reply), "今天\n十点组会，见 日历\n改了 useSpeech.ts\n详情");
});

test("said in pieces: whole sentences, short ones joined, long ones cut at a comma", () => {
  assert.deepEqual(sentences("好。已经加到待办了！"), ["好。 已经加到待办了！"]);
  const two = "明天下午三点前要交报税材料，我已经把它加到你的待办里了。另外周四的组会挪到了下午两点，日历已经改好。";
  assert.deepEqual(sentences(two), ["明天下午三点前要交报税材料，我已经把它加到你的待办里了。", "另外周四的组会挪到了下午两点，日历已经改好。"]);
  assert.deepEqual(sentences("Done. I moved it to Friday at four. Anything else?"), ["Done. I moved it to Friday at four.", "Anything else?"]);
  const long = `${"一二三四五六七八九十".repeat(10)}，${"甲乙丙丁戊己庚辛壬癸".repeat(10)}。`;
  const pieces = sentences(long, 160);
  assert.ok(pieces.every((piece) => piece.length <= 160));
  assert.equal(pieces.join(""), long);
  assert.deepEqual(sentences("  \n "), []);
});

test("a long reply said in short: its first sentences, and whether there is more", () => {
  assert.deepEqual(firstSentences("好的。已加到明天。还有别的吗？", 2), { text: "好的。 已加到明天。", more: true });
  assert.deepEqual(firstSentences("Done.", 2), { text: "Done.", more: false });
});
