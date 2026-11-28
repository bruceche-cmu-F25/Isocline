/** Colours for code in replies: comments, strings, numbers and keywords, for the languages replies mostly carry.
 * Not a parser: one pass over the text, which is right for the common cases and never wrong about the text itself
 * (every character comes back, in order). A language it does not know, or a very long block, stays plain. */

export type TokenKind = "comment" | "string" | "number" | "keyword" | "literal" | "tag" | "attr" | "plain";
export interface Token { kind: TokenKind; text: string }

interface Family {
  line: string[];
  block?: [string, string];
  quotes: string[];
  /** Python's and others' three-quote strings. */
  triple?: boolean;
  keywords: ReadonlySet<string>;
  literals?: ReadonlySet<string>;
}

const words = (text: string): ReadonlySet<string> => new Set(text.split(/\s+/).filter(Boolean));
const LITERALS = words("true false null undefined nil None True False NaN Infinity self this super");

const C_LIKE = { line: ["//"], block: ["/*", "*/"] as [string, string], literals: LITERALS };
const FAMILIES: Record<string, Family> = {
  js: { ...C_LIKE, quotes: ['"', "'", "`"], keywords: words(`
    abstract as async await break case catch class const continue debugger declare default delete do else enum export
    extends finally for from function get if implements import in instanceof interface keyof let namespace new of
    private protected public readonly return satisfies set static switch throw try type typeof var void while with yield`) },
  py: { line: ["#"], quotes: ['"', "'"], triple: true, literals: LITERALS, keywords: words(`
    and as assert async await break class continue def del elif else except finally for from global if import in is
    lambda match case nonlocal not or pass raise return try while with yield print`) },
  sh: { line: ["#"], quotes: ['"', "'"], literals: LITERALS, keywords: words(`
    if then else elif fi for while until do done case esac in function return local export source set unset echo exit
    cd sudo npm npx node git brew pip python python3 curl`) },
  go: { ...C_LIKE, quotes: ['"', "'", "`"], keywords: words(`
    break case chan const continue default defer else fallthrough for func go goto if import interface map package range
    return select struct switch type var`) },
  rust: { ...C_LIKE, quotes: ['"'], keywords: words(`
    as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref
    return static struct trait type unsafe use where while Self Some Ok Err`) },
  java: { ...C_LIKE, quotes: ['"', "'"], keywords: words(`
    abstract break case catch class const continue default do else enum extends final finally for fun if implements import
    in instanceof interface is new object override package private protected public return static struct switch throw
    throws try typedef using val var void volatile when while namespace template typename auto int long char float double
    bool boolean string let func guard protocol extension import init deinit inout`) },
  css: { ...C_LIKE, quotes: ['"', "'"], keywords: words("@media @import @container @supports @keyframes @font-face !important") },
  sql: { line: ["--"], block: ["/*", "*/"], quotes: ["'", '"'], literals: words("NULL TRUE FALSE null true false"), keywords: words(`
    select from where and or not insert into values update set delete create table index view drop alter add column
    primary key foreign references join left right inner outer on group by order having limit offset as distinct union
    all case when then else end in is like between exists returning with begin commit rollback
    SELECT FROM WHERE AND OR NOT INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE INDEX VIEW DROP ALTER ADD COLUMN
    PRIMARY KEY FOREIGN REFERENCES JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET AS DISTINCT UNION
    ALL CASE WHEN THEN ELSE END IN IS LIKE BETWEEN EXISTS RETURNING WITH BEGIN COMMIT ROLLBACK`) },
  json: { line: [], quotes: ['"'], literals: words("true false null"), keywords: words("") },
  yaml: { line: ["#"], quotes: ['"', "'"], literals: words("true false null yes no ~"), keywords: words("") },
  ruby: { line: ["#"], quotes: ['"', "'"], literals: LITERALS, keywords: words(`
    alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry
    return self super then undef unless until when while yield require attr_accessor`) },
  lua: { line: ["--"], quotes: ['"', "'"], literals: LITERALS, keywords: words("and break do else elseif end for function goto if in local not or repeat return then until while") },
};

/** The names a fence may give, to the family that colours them. */
const ALIASES: Record<string, string> = {
  js: "js", jsx: "js", javascript: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", typescript: "js",
  py: "py", python: "py", python3: "py",
  sh: "sh", bash: "sh", zsh: "sh", shell: "sh", console: "sh", fish: "sh",
  go: "go", golang: "go", rust: "rust", rs: "rust",
  java: "java", kotlin: "java", kt: "java", c: "java", h: "java", cpp: "java", "c++": "java", cc: "java", cs: "java", csharp: "java",
  swift: "java", scala: "java", dart: "java", php: "java",
  css: "css", scss: "css", less: "css",
  sql: "sql", sqlite: "sql", postgres: "sql", postgresql: "sql", mysql: "sql",
  json: "json", jsonc: "js", json5: "js",
  yaml: "yaml", yml: "yaml", toml: "yaml", ini: "yaml", dockerfile: "sh", makefile: "sh", make: "sh",
  ruby: "ruby", rb: "ruby", lua: "lua",
};
const MARKUP = new Set(["html", "xml", "svg", "vue", "svelte"]);

/** Longer than this, a block is left plain: colouring it is not worth the time on every streamed word. */
export const HIGHLIGHT_LIMIT = 20_000;

export function languageOf(lang: string | undefined): string | null {
  if (!lang) return null;
  const name = lang.trim().toLowerCase();
  return MARKUP.has(name) ? "markup" : ALIASES[name] ?? null;
}

const WORD = /[A-Za-z_$][\w$]*/y;
/** In a shell and in CSS a dash belongs to the word (`--save-dev`, `font-size`), and CSS has `@media`, `!important`. */
const DASHED = /[A-Za-z_$@!][\w$-]*/y;
const NUMBER = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/y;

export function highlight(code: string, lang: string | undefined): Token[] {
  const family = languageOf(lang);
  if (!family || code.length > HIGHLIGHT_LIMIT) return [{ kind: "plain", text: code }];
  return family === "markup" ? markup(code) : scan(code, FAMILIES[family]);
}

function scan(code: string, family: Family): Token[] {
  const out: Token[] = [];
  let plain = "";
  const push = (kind: TokenKind, text: string) => {
    if (kind === "plain") { plain += text; return; }
    if (plain) { out.push({ kind: "plain", text: plain }); plain = ""; }
    out.push({ kind, text });
  };
  let i = 0;
  while (i < code.length) {
    const rest = (prefix: string) => code.startsWith(prefix, i);
    const line = family.line.find(rest);
    if (line) {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? code.length : end;
      push("comment", code.slice(i, stop));
      i = stop;
      continue;
    }
    if (family.block && rest(family.block[0])) {
      const end = code.indexOf(family.block[1], i + family.block[0].length);
      const stop = end === -1 ? code.length : end + family.block[1].length;
      push("comment", code.slice(i, stop));
      i = stop;
      continue;
    }
    const quote = family.quotes.find(rest);
    if (quote) {
      const fence = family.triple && code.startsWith(quote.repeat(3), i) ? quote.repeat(3) : quote;
      let j = i + fence.length;
      while (j < code.length && !code.startsWith(fence, j)) {
        // A one-quote string ends at the line's end even when it is not closed.
        if (fence.length === 1 && quote !== "`" && code[j] === "\n") break;
        j += code[j] === "\\" ? 2 : 1;
      }
      const stop = Math.min(code.length, code.startsWith(fence, j) ? j + fence.length : j);
      push("string", code.slice(i, stop));
      i = stop;
      continue;
    }
    const ch = code[i];
    const before = i > 0 ? code[i - 1] : "";
    if (/\d/.test(ch) && !/[\w$]/.test(before)) {
      NUMBER.lastIndex = i;
      const match = NUMBER.exec(code);
      if (match) { push("number", match[0]); i += match[0].length; continue; }
    }
    const dashed = family === FAMILIES.sh || family === FAMILIES.css;
    if ((dashed ? /[A-Za-z_$@!]/ : /[A-Za-z_$]/).test(ch) && !/[\w$-]/.test(before)) {
      const pattern = dashed ? DASHED : WORD;
      pattern.lastIndex = i;
      const word = pattern.exec(code)![0];
      push(family.keywords.has(word) ? "keyword" : family.literals?.has(word) ? "literal" : "plain", word);
      i += word.length;
      continue;
    }
    push("plain", ch);
    i++;
  }
  if (plain) out.push({ kind: "plain", text: plain });
  return out;
}

/** HTML and XML: comments, tag names, attribute names and their quoted values. */
function markup(code: string): Token[] {
  const out: Token[] = [];
  const pattern = /(<!--[\s\S]*?(?:-->|$))|(<\/?[A-Za-z][\w:.-]*)|(\s[A-Za-z_:@][\w:.-]*)(?==)|("[^"]*"|'[^']*')|(\/?>)/g;
  let last = 0;
  let inTag = false;
  for (const match of code.matchAll(pattern)) {
    const at = match.index;
    if (at > last) out.push({ kind: "plain", text: code.slice(last, at) });
    if (match[1]) out.push({ kind: "comment", text: match[1] });
    else if (match[2]) { out.push({ kind: "tag", text: match[2] }); inTag = true; }
    else if (match[3] && inTag) out.push({ kind: "attr", text: match[3] });
    else if (match[4] && inTag) out.push({ kind: "string", text: match[4] });
    else if (match[5]) { out.push({ kind: inTag ? "tag" : "plain", text: match[5] }); inTag = false; }
    else out.push({ kind: "plain", text: match[0] });
    last = at + match[0].length;
  }
  if (last < code.length) out.push({ kind: "plain", text: code.slice(last) });
  return out;
}
