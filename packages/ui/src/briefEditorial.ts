/** The edition's own words, used alongside its saved calendar and todo records.
 * New editions use headings and bullets. Older editions used bold labels and prose. */
export interface BriefEditorial {
  agenda: string[];
  deadlines: string[];
  mail: string[];
  advice: string[];
  notes: string[];
  coverage: string[];
}

type Section = keyof BriefEditorial;

function section(label: string): Section | null {
  const name = label.trim().replace(/[:：]$/, "").replace(/\s*[（(][^()（）]+[)）]$/, "").trim().toLowerCase();
  if (/^(schedule|today|agenda|calendar|今日日程|今天的日程|日程|今日安排)$/.test(name)) return "agenda";
  if (/^(due today|deadlines|todos|to-dos|到期事项|今日到期|待办|今日待办)$/.test(name)) return "deadlines";
  if (/^(mail|decisions|mail\s*\/\s*(todos\s*\/\s*)?decisions|邮件与决定|邮件和决定|邮件|待决定事项)$/.test(name)) return "mail";
  if (/^(suggested start|start here|recommendation|建议先做|建议先从|建议先做的事|建议)$/.test(name)) return "advice";
  return null;
}

function heading(line: string): { key: Section; rest: string } | null {
  const hash = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
  const bold = /^\*\*(.+?)\*\*[:：]?\s*(.*)$/.exec(line);
  const label = hash?.[1] ?? bold?.[1];
  if (!label) return null;
  const key = section(label);
  return key ? { key, rest: hash ? "" : bold?.[2] ?? "" } : null;
}

/** Split a legacy run-on mail paragraph only where the next words assert a separate fact.
 * Dates, lists of recipients, and conditions such as ", if payment is on file" stay attached. */
function mailClauses(text: string): string[] {
  const independent = /^(?:and\s+)?(?:[\p{L}\p{N}’'./&-]+\s+){1,12}(?:needs?|requires?|closes?|renews?|expires?|warrants?|is due|are due)\b/iu;
  const pieces = text.split(/,\s+/);
  const rows = [pieces[0]!];
  for (const piece of pieces.slice(1)) {
    if (!/^(?:if|unless|since|because|which|whose|when|where|who|so|although|until|that|provided|while|as)\b/i.test(piece) && independent.test(piece)) {
      rows.push(piece.replace(/^and\s+/i, ""));
    } else {
      rows[rows.length - 1] += ", " + piece;
    }
  }
  return rows;
}

function pushRow(result: BriefEditorial, key: Section, text: string, legacy: boolean) {
  const value = text.trim();
  if (!value) return;
  // Keep Markdown, URLs, quotes, and explicitly authored list items as written.
  if (!legacy || key === "notes" || key === "advice" || /[\n`*_[\]"“”<>]|https?:\/\//.test(value)) {
    result[key].push(value);
    return;
  }
  for (const clause of value.split(/[;；]\s*/).filter(Boolean)) {
    const advice = key === "deadlines" && /^(.+?)[—–]\s*(I(?:['’]d| would) (?:start|begin)\b.+)$/i.exec(clause);
    if (advice) {
      result.deadlines.push(advice[1]!.trim());
      result.advice.push(advice[2]!);
    } else if (key === "mail") {
      // Some editions put a report about tool access at the end of the mail paragraph.
      const limits = /(?:^|[—–])\s*(pending (?:assistant )?approvals? (?:aren[’']t|are not|weren[’']t|were not) (?:visible|accessible)\b.*)$/i.exec(clause);
      const mail = limits ? clause.slice(0, limits.index).trim() : clause;
      if (mail) result.mail.push(...mailClauses(mail));
      if (limits) result.coverage.push(limits[1]!);
    } else {
      result[key].push(clause);
    }
  }
}

export function readBriefEditorial(reply: string): BriefEditorial {
  const result: BriefEditorial = { agenda: [], deadlines: [], mail: [], advice: [], notes: [], coverage: [] };
  let key: Section = "notes";
  let pending: string[] = [];
  let legacy = false;
  let fence = "";
  const flush = () => {
    pushRow(result, key, pending.join("\n"), legacy);
    pending = [];
    legacy = false;
  };
  for (const line of reply.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence || marker) {
      pending.push(line);
      if (!fence) fence = marker!;
      else if (marker && marker.startsWith(fence)) fence = "";
      continue;
    }
    const label = heading(line);
    if (label) {
      flush();
      key = label.key;
      if (label.rest) { legacy = true; pending.push(label.rest); }
    } else if (/^#{1,6}\s/.test(line)) {
      flush();
      key = "notes";
      pending.push(line);
    } else if (!line.trim()) {
      flush();
    } else {
      const bullet = /^[-*+]\s+(.+)$/.exec(line);
      if (bullet && key !== "notes") {
        flush();
        pending.push(bullet[1]!);
      } else {
        pending.push(line);
      }
    }
  }
  flush();
  return result;
}

/** What a mail row is, as the edition tagged it. Editions written before the tags have none. */
export type MailKind = "risk" | "decide" | "due" | "fyi";
export interface MailRow {
  /** The row without its tag and its message id. */
  text: string;
  kind: MailKind | null;
  /** A `due` row's date (YYYY-MM-DD), when the tag gave one. */
  due?: string;
  /** The id of the message the row is about. */
  mail?: string;
}

const KINDS: Array<[MailKind, RegExp]> = [
  ["risk", /^(risk|风险)$/],
  ["decide", /^(decide|decision|your call|等你|等你决定|待决定)$/],
  ["due", /^(due|deadline|期限|截止)$/],
  ["fyi", /^(fyi|告知|知悉)$/],
];

/** `[Risk] …words… (mail:ID)`: a leading tag and a trailing message id, both optional, in either language.
 * A bracket that is not one of the known tags is the row's own words and stays. */
export function readMailRow(row: string): MailRow {
  let text = row.trim();
  const result: MailRow = { text, kind: null };
  const cite = /\s*[(（]\s*(?:mail|邮件)\s*[:：]\s*([\w-]{1,64})\s*[)）]\s*([.。]?)$/i.exec(text);
  if (cite) {
    result.mail = cite[1]!;
    text = text.slice(0, cite.index).trimEnd();
    if (cite[2] && !/[.。!?！？]$/.test(text)) text += cite[2];
  }
  const tag = /^\*{0,2}(?:\[([^\[\]]{1,24})\]|【([^【】]{1,24})】)\*{0,2}\s*[:：]?\s*/.exec(text);
  if (tag && tag[0].length < text.length) {
    const label = (tag[1] ?? tag[2])!.trim().toLowerCase();
    const date = /\d{4}-\d\d-\d\d/.exec(label)?.[0];
    const name = (date ? label.replace(date, "") : label).trim();
    const kind = KINDS.find(([, names]) => names.test(name))?.[0];
    if (kind) {
      result.kind = kind;
      if (kind === "due" && date) result.due = date;
      text = text.slice(tag[0].length);
    }
  }
  result.text = text;
  return result;
}
