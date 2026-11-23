/** What the user might say on an ordinary day, and what should land. Today is fixed by the machine's clock; these
 * were written for Sunday 2026-11-22 or Monday 2026-11-23 (周四 = 11-26, 周五 = 11-27). Lines starting "note:" are observations, not
 * failures. */
import type { Result, Scenario } from "./harness.ts";

const plus = (days: number) => { const at = new Date(); at.setDate(at.getDate() + days); return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`; };
// Weekday names hold for a run on Sunday 2026-11-22 or Monday 2026-11-23; 明天 and 后天 follow the clock.
const D = { tue: "2026-11-24", wed: "2026-11-25", thu: "2026-11-26", fri: "2026-11-27", nextMon: "2026-11-30", tomorrow: plus(1), dayAfter: plus(2) };
const hour = (time?: string) => (time ? Number(time.slice(11, 13)) : NaN);
const day = (time?: string) => time?.slice(0, 10);
const noChanges = (r: Result) => [
  ...(r.proposals.length ? [`unexpected proposal: ${r.proposals.map((p) => p.title).join("; ")}`] : []),
  ...(r.todosAdded.length ? [`unexpected todo: ${r.todosAdded.map((t) => t.title).join("; ")}`] : []),
];
const noAsk = (r: Result) => (r.asks.length ? [`asked: ${r.asks.map((a) => a.question).join(" / ")}`] : []);
const done = (r: Result) => (r.state !== "completed" ? [`run ${r.state}${r.error ? `: ${r.error.slice(0, 200)}` : ""}`] : []);
const adds = (r: Result) => r.calendar.filter((c) => c.op === "calendar.add");
const oneAdd = (r: Result, check: (c: Result["calendar"][number]) => string[]) => {
  const list = adds(r);
  if (list.length !== 1) return [`expected 1 calendar add, got ${list.length}${list.length ? `: ${list.map((c) => `${c.title} ${c.start ?? c.date}`).join("; ")}` : ""}`];
  return check(list[0]);
};
/** A timed event goes on the todo list too: one todo, due its day, `at` its start (Bruce, 2026-11-23). `at` is an
 * exact HH:MM, or a test of it. */
const PREP = /准备|slide|值机|收拾|材料/i;
const todoFor = (r: Result, word: RegExp, due: string, at?: string | ((at?: string) => boolean), others = false) => {
  const list = r.todosAdded.filter((t) => word.test(t.title) && !PREP.test(t.title));
  const extra = r.todosAdded.filter((t) => !list.includes(t));
  if (!others && extra.length) return [`todo nobody asked for: ${extra.map((t) => t.title).join("; ")}`];
  if (list.length !== 1) return [`expected 1 todo for the event, got ${list.length}${r.todosAdded.length ? ` (${r.todosAdded.map((t) => `${t.title} ${t.due} ${t.at ?? ""}`).join("; ")})` : ""}`];
  const t = list[0];
  const atWrong = at === undefined ? false : typeof at === "string" ? t.at !== at : !at(t.at);
  return [...(t.due !== due ? [`event todo due ${t.due}`] : []), ...(atWrong ? [`event todo at ${t.at ?? "none"}`] : [])];
};
/** "下午" names no hour: no `at`, or one in the afternoon. */
const afternoon = (at?: string) => !at || (Number(at.slice(0, 2)) >= 12 && Number(at.slice(0, 2)) <= 17);

export const SCENARIOS: Scenario[] = [
  {
    id: "meet-thu-afternoon",
    say: "周四下午要和张伟见面",
    check: (r) => [...done(r), ...noAsk(r), ...todoFor(r, /张伟/, D.thu, afternoon), ...oneAdd(r, (c) => [
      ...(day(c.start) !== D.thu ? [`wrong day ${c.start}`] : []),
      ...(hour(c.start) < 12 || hour(c.start) > 17 ? [`not afternoon: ${c.start}`] : []),
      ...(!/张伟/.test(c.title) ? [`title misses 张伟: ${c.title}`] : []),
    ])],
  },
  {
    id: "meet-tomorrow-conflict",
    say: "明天上午10点和导师开会",
    check: (r) => [...done(r), ...noAsk(r), ...todoFor(r, /导师/, D.tomorrow, "10:00"), ...oneAdd(r, (c) => [
      ...(c.start !== `${D.tomorrow} 10:00` ? [`wrong start ${c.start}`] : []),
    ]), ...(!/组会|冲突|conflict|撞/.test(r.reply + r.proposals.map((p) => p.summary).join()) ? ["did not mention the clash with 组会 10:00–11:00"] : [])],
  },
  {
    id: "todo-next-wed",
    say: "下周三之前要交15513的作业",
    check: (r) => {
      const t = r.todosAdded;
      if (t.length !== 1) return [...done(r), `expected 1 todo, got ${t.length}`, ...(adds(r).length ? ["added a calendar event too"] : [])];
      return [...done(r), ...noAsk(r), ...(adds(r).length ? ["added a calendar event too"] : []),
        ...(t[0].due !== D.wed && t[0].due !== "2026-12-02" ? [`wrong due ${t[0].due}`] : [`note: 下周三 read as ${t[0].due}`])];
    },
  },
  {
    id: "todo-with-hour",
    say: "记得周五晚上9点前把报销单交了",
    check: (r) => {
      const t = r.todosAdded;
      if (t.length !== 1) return [...done(r), `expected 1 todo, got ${t.length}`];
      return [...done(r), ...noAsk(r),
        ...(t[0].due !== D.fri ? [`wrong due ${t[0].due}`] : []),
        ...(t[0].at !== "21:00" ? [`at not 21:00: ${t[0].at}`] : []),
        ...(/9点|21|晚上/.test(t[0].title) ? [`time left in title: ${t[0].title}`] : []),
        ...(adds(r).length ? ["added a calendar event too"] : [])];
    },
  },
  {
    id: "todo-bare",
    say: "买鸡蛋",
    check: (r) => [...done(r), ...noAsk(r), ...(r.todosAdded.length !== 1 ? [`expected 1 todo, got ${r.todosAdded.length}`] : []),
      ...(r.todosAdded[0]?.due ? [`note: gave it due ${r.todosAdded[0].due}`] : [])],
  },
  {
    id: "trip-range",
    say: "下周一到周三去纽约出差",
    check: (r) => {
      const c = adds(r), t = r.todosAdded;
      const out = [...done(r), ...noAsk(r)];
      if (c.length === 1 && c[0].date) out.push(`note: all-day ${c[0].date}–${c[0].endDate}`);
      else if (t.length === 1 && t[0].startDate) out.push(`note: ranged todo ${t[0].startDate}–${t[0].due}`);
      else out.push(`neither a whole-day event nor a ranged todo: ${JSON.stringify(c)} ${t.map((x) => x.title).join()}`);
      if (c.length === 1 && c[0].date && c[0].endDate) {
        const span = (Date.parse(c[0].endDate) - Date.parse(c[0].date)) / 86_400_000;
        if (span !== 2) out.push(`span is ${span + 1} days, not 3`);
      }
      return out;
    },
  },
  {
    id: "weekly-repeat",
    say: "每周二下午3点有组会，帮我加到日历",
    check: (r) => {
      const c = adds(r);
      return [...done(r), ...noAsk(r), ...(c.length !== 1 ? [`expected 1 repeating event, got ${c.length}`] : []),
        ...(c[0] && c[0].repeat?.every !== "week" ? [`not weekly: ${JSON.stringify(c[0].repeat ?? null)}`] : []),
        ...(c[0] && c[0].start !== `${D.tue} 15:00` ? [`first time ${c[0].start}`] : [])];
    },
  },
  {
    id: "complete-todo",
    say: "牛奶买了",
    check: (r) => {
      const milk = r.todosChanged.find((c) => c.before.title === "买牛奶");
      return [...done(r), ...noAsk(r), ...(!milk?.after.done ? ["买牛奶 not completed"] : []), ...noChanges(r).filter((x) => x.startsWith("unexpected proposal"))];
    },
  },
  {
    id: "move-event",
    say: "周五和张伟的会推到下周一同一时间",
    check: (r) => {
      const m = r.calendar.filter((c) => c.op === "calendar.move");
      if (m.length !== 1) return [...done(r), `expected 1 move, got ${m.length} (${r.calendar.map((c) => c.op).join()})`];
      return [...done(r), ...noAsk(r), ...(m[0].start !== `${D.nextMon} 14:00` || m[0].end !== `${D.nextMon} 15:00` ? [`wrong time ${m[0].start}–${m[0].end}`] : [])];
    },
  },
  {
    id: "question-free",
    say: "明天下午我有空吗？",
    check: (r) => [...done(r), ...noAsk(r), ...noChanges(r), ...(!/空|free|没有/.test(r.reply) ? [`reply unclear: ${r.reply.slice(0, 120)}`] : [])],
  },
  {
    id: "dinner-location",
    say: "后天晚上7点和Lisa在海底捞吃饭",
    check: (r) => [...done(r), ...noAsk(r), ...todoFor(r, /Lisa|海底捞|吃饭/, D.dayAfter, "19:00"), ...oneAdd(r, (c) => [
      ...(c.start !== `${D.dayAfter} 19:00` ? [`wrong start ${c.start}`] : []),
      ...(!/海底捞/.test(c.location ?? "") ? [`location not set (${c.location ?? "none"}); title ${c.title}`] : []),
    ])],
  },
  {
    id: "birthday-reminder",
    say: "12月5号是我妈生日，提前一周提醒我买礼物",
    check: (r) => {
      const gift = r.todosAdded.find((t) => /礼物/.test(t.title));
      return [...done(r), ...noAsk(r), ...(!gift ? ["no gift todo"] : gift.due !== "2026-11-28" ? [`gift todo due ${gift.due}, expected 2026-11-28`] : []),
        `note: calendar ${adds(r).map((c) => `${c.title} ${c.date ?? c.start}`).join("; ") || "none"}`];
    },
  },
  {
    id: "en-lunch",
    say: "Lunch with Sarah on Tuesday at noon",
    check: (r) => [...done(r), ...noAsk(r), ...todoFor(r, /Sarah|lunch/i, D.tue, "12:00"), ...oneAdd(r, (c) => [...(c.start !== `${D.tue} 12:00` ? [`wrong start ${c.start}`] : [])]),
      ...(/[一-鿿]/.test(r.reply.replace(/组会|牙医|和张伟同步/g, "")) ? ["replied in Chinese to English"] : [])],
  },
  {
    id: "tonight-past",
    say: "今晚8点给爸妈打电话",
    check: (r) => [...done(r), ...noAsk(r), `note: it is ${new Date().toTimeString().slice(0, 5)} now; landed: ${r.todosAdded.map((t) => `todo ${t.title} ${t.due} ${t.at ?? ""}`).join("; ")} ${adds(r).map((c) => `event ${c.title} ${c.start}`).join("; ")}`,
      ...(!/过了|已经|passed|明天/.test(r.reply) ? ["did not notice 8pm has passed"] : [])],
  },
  {
    id: "cancel-event",
    say: "取消周五和张伟的会",
    check: (r) => [...done(r), ...noAsk(r),
      ...(/已取消|取消了|已删除|cancelled|deleted/i.test(r.reply) && !r.proposals.length ? [`claims it cancelled: ${r.reply.slice(0, 120)}`] : []),
      ...(r.tools.some((t) => t.startsWith("show_view")) && /删|delete/i.test(r.reply) ? [] : [`does not point to the Calendar page: ${r.reply.slice(0, 120)}`]),
      ...(/Google 日历里|in Google Calendar/.test(r.reply) ? ["sends the user to Google Calendar"] : []),
      `note: ${r.reply.slice(0, 160)} | proposals: ${r.calendar.map((c) => c.op).join() || "none"}`],
  },
  {
    id: "week-plan",
    say: "这周安排：周二交论文初稿，周三下午2点看牙医，周四晚上和室友吃饭",
    check: (r) => {
      const c = adds(r);
      const out = [...done(r), ...noAsk(r)];
      const paper = r.todosAdded.find((t) => /论文/.test(t.title));
      if (!paper) out.push("no 论文初稿 todo"); else if (paper.due !== D.tue) out.push(`论文 due ${paper.due}`);
      // Moving the 牙医 already there (Wed 15:00) to 14:00 is as right as adding one.
      const dentist = r.calendar.find((x) => (x.op === "calendar.add" || x.op === "calendar.move") && /牙/.test(x.title));
      if (!dentist) out.push("no dentist event"); else if (dentist.start !== `${D.wed} 14:00`) out.push(`dentist at ${dentist.start}`);
      const dinner = c.find((x) => /室友|吃饭|晚饭|dinner/.test(x.title));
      if (!dinner) out.push("no dinner event"); else if (day(dinner.start) !== D.thu || hour(dinner.start) < 17) out.push(`dinner at ${dinner.start}`);
      out.push(...todoFor(r, /室友|吃饭|晚饭/, D.thu, undefined, true));
      out.push(`note: todos ${r.todosAdded.map((t) => `${t.title} ${t.due} ${t.at ?? ""}`).join("; ")}`);
      if (!/15|已经|已有|冲突|重复|原来/.test(r.reply + r.proposals.map((p) => p.summary).join())) out.push("did not notice the existing 牙医 Wed 15:00");
      return out;
    },
  },
  {
    id: "voice-noisy",
    say: "嗯那个就是周四下午吧 跟那个 王老师 见个面 聊一下论文的事情",
    check: (r) => [...done(r), ...noAsk(r), ...todoFor(r, /王老师/, D.thu, afternoon), ...oneAdd(r, (c) => [
      ...(day(c.start) !== D.thu ? [`wrong day ${c.start}`] : []),
      ...(!/王老师/.test(c.title) ? [`title: ${c.title}`] : []),
      ...(/嗯|那个/.test(c.title) ? [`filler words in title: ${c.title}`] : []),
    ])],
  },
  {
    id: "flight",
    say: "明天早上8点的航班去西雅图",
    check: (r) => [...done(r), ...noAsk(r), ...todoFor(r, /航班|西雅图|飞/, D.tomorrow, "08:00"), ...oneAdd(r, (c) => [
      ...(c.start !== `${D.tomorrow} 08:00` ? [`wrong start ${c.start}`] : []),
      `note: ${c.title} ${c.start}–${c.end}`,
    ]), ...(adds(r)[0] && adds(r)[0].end! > `${D.tomorrow} 10:00` && !/组会|冲突/.test(r.reply + r.proposals.map((p) => p.summary).join()) ? ["flight overlaps 组会 10:00, not mentioned"] : [])],
  },
  {
    id: "duplicate-event",
    say: "周五下午2点和张伟开会",
    check: (r) => [...done(r), ...noAsk(r), ...(adds(r).length ? [`added a duplicate of 和张伟同步 (Fri 14:00): ${adds(r).map((c) => c.title).join()}`] : []),
      ...(!/已经|已有|already|日历上/.test(r.reply) ? [`reply: ${r.reply.slice(0, 120)}`] : [])],
  },
  {
    id: "relative-time",
    say: "半小时后和产品组开个短会",
    check: (r) => {
      const now = Date.now() + 30 * 60_000;
      const c = adds(r)[0];
      if (!c) return [...done(r), `no event (asks: ${r.asks.length}) reply: ${r.reply.slice(0, 120)}`];
      const start = new Date(c.start!.replace(" ", "T")).getTime();
      return [...done(r), ...noAsk(r), ...(Math.abs(start - now) > 20 * 60_000 ? [`start ${c.start}, expected about ${new Date(now).toTimeString().slice(0, 5)} today`] : [])];
    },
  },
  {
    id: "duplicate-todo",
    say: "月底前把房租交了",
    check: (r) => [...done(r), ...noAsk(r), ...(r.todosAdded.length ? [`duplicate todo: ${r.todosAdded.map((t) => `${t.title} ${t.due}`).join()}`] : [])],
  },
  {
    id: "followup-amend",
    say: ["周四下午要和张伟见面", "改成3点到4点"],
    check: (r) => {
      // Moving the 和张伟同步 already there (Fri) to Thursday is a fair reading too.
      const moved = r.calendar.filter((x) => x.op === "calendar.move" && /张伟/.test(x.title));
      const c = moved.length === 1 && !adds(r).length ? moved : adds(r);
      return [...done(r), ...noAsk(r), ...todoFor(r, /张伟/, D.thu, "15:00"), ...(c.length !== 1 ? [`${c.length} open adds after the correction: ${c.map((x) => x.start).join(", ")}`] : []),
        ...(c[0] && (c[0].start !== `${D.thu} 15:00` || c[0].end !== `${D.thu} 16:00`) ? [`final time ${c[0].start}–${c[0].end}`] : [])];
    },
  },
  {
    id: "todo-hour-tomorrow",
    say: "明天下午3点前要把简历发给HR",
    check: (r) => {
      const t = r.todosAdded[0];
      return [...done(r), ...noAsk(r), ...(!t ? ["no todo"] : [...(t.due !== D.tomorrow ? [`due ${t.due}`] : []), ...(t.at !== "15:00" ? [`at ${t.at}`] : [])]),
        ...(adds(r).length ? [`note: also an event ${adds(r).map((c) => c.start).join()}`] : [])];
    },
  },
  {
    id: "meeting-plus-prep",
    say: "周四下午2点和导师meeting，提醒我前一天准备好slides",
    check: (r) => {
      const prep = r.todosAdded.find((t) => /slide|幻灯|PPT/i.test(t.title));
      return [...done(r), ...noAsk(r), ...todoFor(r, /导师|meeting/i, D.thu, "14:00", true), ...oneAdd(r, (c) => (c.start !== `${D.thu} 14:00` ? [`meeting at ${c.start}`] : [])),
        ...(!prep ? ["no slides todo"] : prep.due !== D.wed ? [`slides due ${prep.due}`] : [])];
    },
  },
  {
    id: "en-next-friday",
    say: "Dentist appointment next Friday 9am",
    check: (r) => [...done(r), ...noAsk(r), ...(r.todosAdded.filter((t) => /dentist/i.test(t.title) && t.due === day(adds(r)[0]?.start) && t.at === "09:00").length !== 1 ? [`no matching dentist todo: ${r.todosAdded.map((t) => `${t.title} ${t.due} ${t.at ?? ""}`).join("; ") || "none"}`] : []), ...oneAdd(r, (c) => (c.start === `${D.fri} 09:00` || c.start === "2026-12-04 09:00" ? [`note: next Friday read as ${c.start}`] : [`wrong start ${c.start}`]))],
  },
  {
    id: "move-dentist",
    say: "牙医改到周四同一时间",
    check: (r) => {
      const m = r.calendar.filter((c) => c.op === "calendar.move");
      return [...done(r), ...noAsk(r), ...(m.length !== 1 ? [`expected 1 move, got ${m.length}`] : m[0].start !== `${D.thu} 15:00` ? [`moved to ${m[0].start}`] : [])];
    },
  },
  {
    id: "accept-invite",
    say: "周二那个design review我去",
    check: (r) => {
      const a = r.calendar.filter((c) => c.op === "calendar.respond");
      return [...done(r), ...noAsk(r), ...(a.length !== 1 ? [`expected 1 respond, got ${a.length} (${r.calendar.map((c) => c.op).join() || "none"})`] : a[0].response !== "accepted" ? [`answered ${a[0].response}`] : [])];
    },
  },
];
