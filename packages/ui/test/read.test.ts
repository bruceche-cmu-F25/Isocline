import assert from "node:assert/strict";
import { test } from "node:test";
import { readLine } from "../src/shell/read.ts";

/** A Friday. */
const TODAY = "2026-11-20";
const read = (text: string) => readLine(text, TODAY).map((item) => [item.kind, item.title, item.day, item.start, item.end, item.by]);

test("one line with a day or an hour is read as a todo or an event", () => {
  assert.deepEqual(read("明天下午3点和王老师喝咖啡"), [["event", "和王老师喝咖啡", "2026-11-21", "15:00", null, false]]);
  assert.deepEqual(read("下周一前交报告"), [["todo", "交报告", "2026-11-23", null, null, true]]);
  assert.deepEqual(read("周五下午3点前交报告"), [["todo", "交报告", "2026-11-20", "15:00", null, true]]);
  assert.deepEqual(read("下午3点到4点半开会"), [["event", "开会", null, "15:00", "16:30", false]]);
  assert.deepEqual(read("1月5号交房租"), [["todo", "交房租", "2027-01-05", null, null, false]], "a date that has passed this year is next year's");
  assert.deepEqual(read("后天晚上看电影"), [["event", "看电影", "2026-11-22", "19:00", null, false]]);
  assert.deepEqual(read("Coffee with Wang tomorrow at 3pm"), [["event", "Coffee with Wang", "2026-11-21", "15:00", null, false]]);
  assert.deepEqual(read("Hand in the report by next Monday"), [["todo", "Hand in the report", "2026-11-23", null, null, true]]);
  assert.deepEqual(read("3-4pm office hours Dec 3"), [["event", "office hours", "2026-12-03", "15:00", "16:00", false]]);
  assert.deepEqual(read("I have a dentist appointment on Tuesday 10:30am"), [["event", "dentist appointment", "2026-11-24", "10:30", null, false]]);
});

test("several things in one line are read one by one, and a time zone said in passing is the user's own time", () => {
  assert.deepEqual(read("我12月2号有14848final 下午4点pdt，12-3周四下午也有事要去学校"), [
    ["event", "14848final", "2026-12-02", "16:00", null, false],
    ["event", "去学校", "2026-12-03", "15:00", null, false],
  ]);
  assert.deepEqual(read("买菜，明天"), [["todo", "买菜", "2026-11-21", null, null, false]]);
  assert.deepEqual(read("明天3点开会，带电脑"), [["event", "开会，带电脑", "2026-11-21", "15:00", null, false]]);
});

test("what is not plainly something to put down is left for Alfred", () => {
  for (const line of ["我明天日历上有什么？", "把周五的会挪到下周一", "周五的会改到下周一下午3点", "买牛奶", "What do I have tomorrow", "每周三下午3点组会", "帮我看看明天的安排", "顺便说一下，明天3点开会", "明天下午3点"]) {
    assert.deepEqual(read(line), [], line);
  }
});

test("words that look like a day or an hour and are not", () => {
  assert.deepEqual(read("明天早一点出门"), [["todo", "早一点出门", "2026-11-21", null, null, false]]);
  assert.deepEqual(read("明天跑步3.5公里"), [["todo", "跑步3.5公里", "2026-11-21", null, null, false]]);
  assert.deepEqual(read("明天还书"), [["todo", "还书", "2026-11-21", null, null, false]]);
  assert.deepEqual(read("12月1日我妈生日"), [["todo", "我妈生日", "2026-12-01", null, null, false]]);
  assert.deepEqual(read("周六有氧运动"), [["todo", "有氧运动", "2026-11-21", null, null, false]]);
});

test("morning and midnight times keep the intended half of the day", () => {
  assert.deepEqual(read("明早七点开会"), [["event", "开会", "2026-11-21", "07:00", null, false]]);
  assert.deepEqual(read("明晚七点开会"), [["event", "开会", "2026-11-21", "19:00", null, false]]);
  assert.deepEqual(read("Call tomorrow at 12:30am"), [["event", "Call", "2026-11-21", "00:30", null, false]]);
  assert.deepEqual(read("Call tomorrow at 11-1am"), [["event", "Call", "2026-11-21", "23:00", "01:00", false]]);
  assert.deepEqual(read("Call tomorrow at 25:30-27:00"), []);
});
