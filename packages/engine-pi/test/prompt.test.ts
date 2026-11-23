import assert from "node:assert/strict";
import { test } from "node:test";
import { composePrompt } from "../src/index.ts";

test("the prompt says the date and time, the coming days, then the page the user asked from (as context), then the request", () => {
  const plain = composePrompt({ today: "2026-11-18", now: "21:05", timezone: "Asia/Shanghai", goal: "what first?" });
  const [first, days, language, blank, goal] = plain.split("\n");
  assert.equal(first, "Today is 2026-11-18 (Wednesday), now 21:05, timezone Asia/Shanghai.");
  assert.match(days, /^Coming days: Thu 2026-11-19, Fri 2026-11-20, .*, Wed 2026-12-02\. /);
  assert.match(days, /"next week" \(下周\) is the week of Mon 2026-11-23/);
  assert.match(language, /^The message below is not in Chinese/);
  assert.deepEqual([blank, goal], ["", "what first?"]);
  // On a Sunday, next week starts tomorrow.
  assert.match(composePrompt({ today: "2026-11-22", timezone: "UTC", goal: "x" }), /^Today is 2026-11-22 \(Sunday\), timezone UTC\.\nComing days: Mon 2026-11-23,.*week of Mon 2026-11-23/);

  const prompt = composePrompt({
    today: "2026-11-18", timezone: "Asia/Shanghai", goal: "what first?",
    context: { view: "todo.list", title: "Todos", summary: "3 open, 1 overdue", selection: { id: "t1", title: "Hand in report" } },
  });
  assert.equal(prompt.split("\n")[2],
    "The user is looking at the Todos (todo.list) page: 3 open, 1 overdue. Selected: Hand in report (t1). This is context, not a request.");
  assert.ok(prompt.endsWith("\n\nwhat first?"));
  assert.match(composePrompt({ today: "2026-11-18", timezone: "UTC", goal: "x", context: { view: "core.inbox" } }), /looking at the core\.inbox page\. This is context/);
  // A message in a Latin script is answered in its own language, whatever the app's is.
  assert.match(composePrompt({ today: "2026-11-18", timezone: "UTC", goal: "Lunch with Sarah on Tuesday" }), /not in Chinese: write your reply.*\n\nLunch with Sarah/);
  assert.doesNotMatch(composePrompt({ today: "2026-11-18", timezone: "UTC", goal: "周二和 Sarah 吃午饭" }), /not in Chinese/);
});
