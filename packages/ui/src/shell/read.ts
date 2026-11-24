/** Reading one line as things to put down: "周五前交报告" is a todo due Friday, "明天下午3点和王老师喝咖啡" an event
 * tomorrow at 15:00. The ask bar shows what it read while the words are typed, and Enter puts them where they belong
 * with no model and no question in between (shell/AskBar.tsx). After prototype/less-talk.html.
 *
 * It reads a day and an hour, nothing cleverer, and when unsure it reads nothing: a question, a request to change
 * something that exists, a sentence with no day or hour in it all go to Alfred as before. Several things in one
 * line, apart by commas, are read one by one.
 */

export interface Reading {
  /** An hour that is not a deadline makes an event; a day alone, or a deadline, makes a todo. */
  kind: "todo" | "event";
  title: string;
  /** YYYY-MM-DD; null when only an hour was said (today is meant). */
  day: string | null;
  /** HH:MM */
  start: string | null;
  /** HH:MM, when the line said when it ends. */
  end: string | null;
  /** A deadline ("by Friday", "周五前"). */
  by: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");
const parse = (day: string) => { const [y, m, d] = day.split("-").map(Number); return new Date(y, m - 1, d); };
const ymd = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const plus = (day: string, n: number) => { const date = parse(day); date.setDate(date.getDate() + n); return ymd(date); };
const clock = (hour: number, minute: number) => `${pad(hour)}:${pad(minute)}`;

const ZH_DAY: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const ZH_NUM: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
const EN_DAY: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const EN_MONTH = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** The hour a part of the day stands for when no hour was said. */
const PERIOD: Record<string, number> = { 早上: 9, 上午: 10, 中午: 12, 下午: 15, 傍晚: 18, 晚上: 19, 今晚: 19, morning: 9, noon: 12, afternoon: 15, evening: 19, tonight: 19 };
const ZH_PERIOD = "早上|上午|中午|下午|傍晚|晚上|今晚";
const ZH_HOUR = "\\d{1,2}|十[一二]?|[一二两三四五六七八九]";
const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const ZH_WEEKDAY = /(?:这|本)?(下)?(?:周|星期|礼拜)([一二三四五六日天])/;
const EN_WEEKDAY = /\b(?:on\s+|this\s+)?(next\s+)?(mon|tue|wed|thu|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?\b/i;

/** The next such weekday, today included; `next` is the one in the week after this (weeks start on Monday). */
export function weekday(today: string, target: number, next: boolean): string {
  const dow = parse(today).getDay();
  if (!next) return plus(today, (target - dow + 7) % 7);
  const monday = plus(today, -((dow + 6) % 7) + 7);
  return plus(monday, (target + 6) % 7);
}

/** A month and a day with no year: this year's, or next year's once this year's has passed. */
function dated(today: string, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const year = Number(today.slice(0, 4));
  const made = (y: number) => { const date = new Date(y, month - 1, day); return date.getMonth() === month - 1 ? ymd(date) : null; };
  const now = made(year);
  return now && now >= today ? now : made(year + 1) ?? now;
}

/** An hour as it is said in Chinese: 下午4点 is 16, a bare 3点 is the afternoon's. */
function zhHour(period: string | undefined, said: string): number {
  let hour = /\d/.test(said) ? Number(said) : ZH_NUM[said];
  if ((period === "下午" || period === "晚上" || period === "今晚" || period === "傍晚") && hour < 12) hour += 12;
  else if (period === "中午" && hour < 11) hour += 12;
  else if (!period && hour >= 1 && hour <= 7) hour += 12;
  return hour;
}
const zhMinute = (said: string | undefined) => (said === "半" ? 30 : Number(said ?? 0));
const enHour = (said: string, half: string | undefined) => Number(said) % 12 + (/p/i.test(half ?? "") ? 12 : 0);

/** Words that make the line something to ask Alfred, not something to put down as it stands. */
const ASKS = [
  /[?？]\s*$/, /(?:吗|呢|么)\s*[。.!！]?\s*$/,
  /^\s*(?:帮我|帮忙|请|麻烦|怎么|怎样|为什么|为啥|哪|什么|有什么|有没有|查|找|搜|看看|总结|告诉|把|将|取消|删|改|挪|移)/,
  /^\s*(?:what|why|how|which|who|when|where|help|should|can|could|would|please|show|find|list|search|summar|tell|move|cancel|delete|reschedule|change|is|are|do|does|did)\b/i,
  // Changing something that is already there, or something that repeats: Alfred's to work out.
  /改到|挪到|移到|推到|推迟|提前|延后|取消|删掉|删除|改成|改为|每(?:周|天|月|个|逢)/,
  /\b(?:move|reschedule|postpone|cancel|delete|every|each)\b/i,
];

/** Words that only join a part to the one before it ("顺便帮我…", "and also find…"). */
const LINKS = /^\s*(?:顺便|顺带|另外|还有|然后|再|也|还|并且|而且|and|also|then|plus)\s*/i;

/** What one clause says about a day and an hour, and what is left of it as a title. */
export function readClause(text: string, today: string): Omit<Reading, "kind"> {
  let rest = ` ${text.replace(/明早/g, "明天早上").replace(/明晚/g, "明天晚上")} `, day: string | null = null, start: string | null = null, end: string | null = null, by = false;
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => boolean | void, mark = " ") => {
    const m = rest.match(re);
    if (!m || fn(m) === false) return false;
    rest = rest.replace(m[0], mark);
    return true;
  };
  if (/\bby\s+(?:next\s+|the\s+)?(?:mon|tue|wed|thu|fri|sat|sun|tomorrow|today|weekend|\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(rest)) { by = true; rest = rest.replace(/\bby\s+/i, " "); }

  // The hour first, so "3-4pm" is not read as the fourth of March.
  const DAY = "\u0001", HOUR = "\u0002";
  const hour = (re: RegExp, fn: (m: RegExpMatchArray) => boolean | void) => take(re, fn, HOUR);
  hour(/(\d{1,2})[:：](\d{2})\s*(?:[-–~]|到|至|to)\s*(\d{1,2})[:：](\d{2})/, (m) => { start = clock(Number(m[1]), Number(m[2])); end = clock(Number(m[3]), Number(m[4])); })
    || hour(new RegExp(`(${ZH_PERIOD})?\\s*(${ZH_HOUR})\\s*点?\\s*(半)?\\s*(?:[-–~]|到|至)\\s*(${ZH_PERIOD})?\\s*(${ZH_HOUR})\\s*点\\s*(半|\\d{1,2})?\\s*分?`), (m) => {
      const from = zhHour(m[1], m[2]);
      let to = zhHour(m[4] ?? m[1], m[5]);
      if (to <= from && to < 12) to += 12;
      start = clock(from, zhMinute(m[3])); end = clock(to, zhMinute(m[6]));
    })
    || hour(/\b(?:at\s+|from\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:[-–~]|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i, (m) => {
      if (Number(m[1]) > 12 || Number(m[4]) > 12) return false;
      const to = enHour(m[4], m[6]);
      let from = enHour(m[1], m[3] ?? m[6]);
      if (!m[3] && from > to) from = (from + 12) % 24;
      start = clock(from, Number(m[2] ?? 0)); end = clock(to, Number(m[5] ?? 0));
    })
    || hour(new RegExp(`(${ZH_PERIOD})?\\s*(\\d{1,2})[:：](\\d{2})\\s*(am|pm)?`, "i"), (m) => {
      let hour = Number(m[2]);
      if (hour > 23 || Number(m[3]) > 59) return false;
      if (m[4]) {
        if (hour < 1 || hour > 12) return false;
        hour = enHour(m[2], m[4]);
      } else if (hour < 12 && ["下午", "晚上", "今晚", "傍晚"].includes(m[1] ?? "")) hour += 12;
      if (m[1] === "今晚" && !day) day = today;
      start = clock(hour, Number(m[3]));
    })
    || hour(new RegExp(`(${ZH_PERIOD})?\\s*(${ZH_HOUR})\\s*点\\s*(半|\\d{1,2})?\\s*分?`), (m) => {
      // 早一点, 快一点: "a little", not one o'clock.
      if (m[2] === "一" && !m[1]) return false;
      if (m[1] === "今晚") day = today;
      start = clock(zhHour(m[1], m[2]), zhMinute(m[3]));
    })
    || hour(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i, (m) => {
      if (Number(m[1]) > 12) return false;
      start = clock(enHour(m[1], m[3]), Number(m[2] ?? 0));
    });
  const timed = !!start;

  // The day. A date wins over a weekday said with it ("12-3 周四").
  const set = (value: string | null) => { if (!value) return false; day = value; };
  const onDate = take(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/, (m) => set(dated(today, Number(m[1]), Number(m[2]))), DAY)
    || take(new RegExp(`\\b(?:on\\s+)?(${MONTHS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i"), (m) => set(dated(today, EN_MONTH.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, Number(m[2]))), DAY)
    || take(new RegExp(`\\b(?:on\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS})\\b`, "i"), (m) => set(dated(today, EN_MONTH.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, Number(m[1]))), DAY)
    || take(/(?<![\d.:：])(\d{1,2})[-/](\d{1,2})(?![\d:：点])/, (m) => set(dated(today, Number(m[1]), Number(m[2]))), DAY);
  if (onDate) take(ZH_WEEKDAY, () => {}) || take(EN_WEEKDAY, () => {});
  else {
    take(/大后天/, () => { day = plus(today, 3); }, DAY)
      || take(/后天/, () => { day = plus(today, 2); }, DAY)
      || take(/明天|明早|明晚|\btomorrow\b/i, (m) => { day = plus(today, 1); if (!start && m[0] === "明早") start = clock(PERIOD.早上, 0); if (!start && m[0] === "明晚") start = clock(PERIOD.晚上, 0); }, DAY)
      || take(/今天|\btoday\b/i, () => { day = today; }, DAY)
      || take(/(下)?周末|\b(?:the\s+|this\s+)?(next\s+)?weekend\b/i, (m) => { day = weekday(today, 6, !!(m[1] || m[2])); }, DAY)
      || take(ZH_WEEKDAY, (m) => { day = weekday(today, ZH_DAY[m[2]], !!m[1]); }, DAY)
      || take(EN_WEEKDAY, (m) => { day = weekday(today, EN_DAY[m[2].toLowerCase()], !!m[1]); }, DAY);
  }
  // "周五前", "下午3点前": a deadline.
  const before = new RegExp(`[${DAY}${HOUR}][\\s${DAY}${HOUR}]*(?:之前|以前|前)`);
  if (before.test(rest)) { by = true; rest = rest.replace(before, " "); }
  rest = rest.replace(new RegExp(`[${DAY}${HOUR}]`, "g"), " ");

  // A part of the day with no hour: its usual hour.
  if (!timed) {
    take(new RegExp(`${ZH_PERIOD}|\\b(?:in the\\s+|this\\s+)?(?:morning|noon|afternoon|evening)\\b|\\btonight\\b`, "i"), (m) => {
      const key = m[0].trim().toLowerCase().replace(/^(in the|this)\s+/, "");
      if (!start) start = clock(PERIOD[key], 0);
      if ((key === "今晚" || key === "tonight") && !day) day = today;
    });
  } else rest = rest.replace(new RegExp(ZH_PERIOD), " ");

  return { title: titled(rest) || titled(rest, false), day, start, end, by };
}

/** What is left of a clause once its day and hour are taken out, without the words that only carried them. */
function titled(rest: string, lean = true): string {
  let title = rest
    // A time zone said in passing: the user's own time is meant.
    .replace(/\b(?:[pecm][sd]t|utc|gmt)\b/gi, " ").replace(/(?:当地|本地|北京|太平洋)时间/g, " ")
    .replace(/\s+/g, " ").trim();
  const edges = () => { title = title.replace(/^[\s，,。.、:：;；的在于]+|[\s，,。.、:：;；]+$/g, "").replace(/\s+(?:at|on|by|from)$/i, "").trim(); };
  edges();
  if (lean) {
    title = title
      .replace(/^(?:记得|记一下|提醒我|别忘了?)\s*/, "")
      // "我…有", "也有事要": what carried the sentence, not what the thing is called. Only where a subject or "也"
      // stands before them: 有氧运动, 还书 and 我妈生日 keep their first word.
      .replace(/^(?:我们?|咱们?)(?=\s|那天|当天|也|还|有|要|得|需要)\s*(?:那天|当天)?\s*(?:也|还)?\s*(?:有事儿?要|有事儿?|需要|得|要|有一个|有个|有)?\s*/, "")
      .replace(/^(?:也|还(?=要|有|得|需要))\s*(?:有事儿?要|有事儿?|需要|得|要|有一个|有个|有)?\s*/, "")
      .replace(/^(?:有事儿?要|有事儿?|需要|有一个|有个)\s*/, "")
      .replace(/^(?:remind me to|i\s+(?:also\s+)?(?:have|need|want|got)(?:\s+to)?|i've got|i'll|need to|have to|also)\s+/i, "")
      .replace(/^(?:an?|the)\s+/i, "");
    edges();
  }
  return title;
}

/** What the line says to put down, in the order it says it; nothing when it is a question, when it asks to change
 * what is already there, or when some part of it names no day and no hour of its own. */
export function readLine(text: string, today: string): Reading[] {
  const line = text.trim();
  if (!line || line.length > 300 || ASKS.some((ask) => ask.test(line))) return [];
  const read: Array<Omit<Reading, "kind">> = [];
  const clauses = line.split(/[，,；;。\n]+/).map((part) => part.trim()).filter(Boolean);
  // A later part that asks Alfred for something ("…，顺便帮我想想周末去哪") makes the whole line Alfred's.
  if (clauses.slice(1).some((clause) => ASKS[2]!.test(clause.replace(LINKS, "")) || ASKS[3]!.test(clause.replace(LINKS, "")))) return [];
  for (const clause of clauses) {
    const got = readClause(clause, today);
    if ([got.start, got.end].some((time) => time !== null && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) return [];
    const last = read.at(-1);
    const placed = (item: Omit<Reading, "kind">) => !!(item.day || item.start);
    // A day or an hour said by itself belongs to what came before it ("买菜，明天").
    if (placed(got) && !got.title && last && !placed(last)) Object.assign(last, { day: got.day, start: got.start, end: got.end, by: got.by });
    // Words with no day of their own go on with what came before ("明天3点开会，带电脑").
    else if (!placed(got) && last && placed(last)) { if (got.title) last.title = `${last.title}，${got.title}`; }
    else read.push(got);
  }
  if (!read.length || read.some((item) => !item.title || !(item.day || item.start))) return [];
  return read.map((item) => ({ ...item, kind: item.start && !item.by ? "event" : "todo" }));
}
