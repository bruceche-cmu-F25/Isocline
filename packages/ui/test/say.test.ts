import assert from "node:assert/strict";
import { test } from "node:test";
import { eventChange, todoChange } from "../src/shell/say.ts";

/** A Friday. */
const TODAY = "2026-11-20";
const local = (iso: string) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const span = (when: ReturnType<typeof eventChange>) => (when && "start" in when ? [local(when.start), local(when.end)] : when);

test("a few words about a todo: a day, an hour, or done; anything more is not guessed", () => {
  assert.deepEqual(todoChange("明天", TODAY, { due: "2026-11-20" }), { patch: { due: "2026-11-21" } });
  assert.deepEqual(todoChange("改到下周一下午3点", TODAY, {}), { patch: { due: "2026-11-23", at: "15:00" } });
  assert.deepEqual(todoChange("晚上8点", TODAY, { due: "2026-11-25" }), { patch: { due: "2026-11-25", at: "20:00" } }, "an hour alone keeps its day");
  assert.deepEqual(todoChange("5pm", TODAY, {}), { patch: { due: TODAY, at: "17:00" } }, "with no day yet, today");
  assert.deepEqual(todoChange("move it to Saturday", TODAY, {}), { patch: { due: "2026-11-21" } });
  assert.deepEqual(todoChange("做完了", TODAY, {}), { done: true });
  assert.deepEqual(todoChange("Done", TODAY, {}), { done: true });
  assert.equal(todoChange("明天，顺便把标题改短一点", TODAY, {}), null);
  assert.equal(todoChange("拆成三步", TODAY, {}), null);
});

test("a few words about an event move it and keep its length", () => {
  const meeting = { allDay: false, startDate: "2026-11-24", endDate: "2026-11-24", start: new Date(2026, 10, 24, 14, 0).toISOString(), end: new Date(2026, 10, 24, 14, 45).toISOString() };
  assert.deepEqual(span(eventChange("晚1小时", TODAY, meeting)), ["2026-11-24 15:00", "2026-11-24 15:45"]);
  assert.deepEqual(span(eventChange("提前半小时", TODAY, meeting)), ["2026-11-24 13:30", "2026-11-24 14:15"]);
  assert.deepEqual(span(eventChange("2 hours later", TODAY, meeting)), ["2026-11-24 16:00", "2026-11-24 16:45"]);
  assert.deepEqual(span(eventChange("明天", TODAY, meeting)), ["2026-11-21 14:00", "2026-11-21 14:45"]);
  assert.deepEqual(span(eventChange("挪到下周一上午10点", TODAY, meeting)), ["2026-11-23 10:00", "2026-11-23 10:45"]);
  assert.deepEqual(span(eventChange("3点到5点", TODAY, meeting)), ["2026-11-24 15:00", "2026-11-24 17:00"], "an end that was said is taken");
  assert.equal(eventChange("取消", TODAY, meeting), null, "deleting is asked on the page, not read from a word");
  assert.equal(eventChange("明天，叫上 Leo", TODAY, meeting), null);

  const trip = { allDay: true, startDate: "2026-11-27", endDate: "2026-11-29" };
  assert.deepEqual(eventChange("12月4号", TODAY, trip), { date: "2026-12-04", endDate: "2026-12-06" });
  assert.equal(eventChange("晚1小时", TODAY, trip), null);
});
