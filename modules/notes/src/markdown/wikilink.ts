/** `[[target]]`, `[[target|alias]]`, `[[target#heading]]`, `![[embed]]` as one inline piece while reading
 * (docs/research/notes-editor.md 3.1). A micromark text construct and its mdast side, written here because the
 * Obsidian link is not CommonMark: read without it, `[[a|b]]` is plain words and an alias link never reaches the
 * index. Inside code it is not a link (code is read before text). No line breaks inside, nothing empty. */
import type { Code, Construct, Effects, Extension, State, TokenizeContext } from "micromark-util-types";
import type { CompileContext, Extension as FromMarkdownExtension, Token } from "mdast-util-from-markdown";

/** The mdast node the extension makes. */
export interface WikiLinkNode {
  type: "wikiLink";
  /** What is between the brackets, as written. */
  value: string;
  embed: boolean;
  position?: { start: { offset?: number }; end: { offset?: number } };
}

const BRACKET_OPEN = 91, BRACKET_CLOSE = 93, BANG = 33;
const isLineEnding = (code: Code) => code === null || code === -5 || code === -4 || code === -3;

function tokenize(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  let size = 0;
  // micromark's token names are a typed map; ours are not in it.
  const enter = (name: string) => effects.enter(name as never);
  const exit = (name: string) => effects.exit(name as never);
  const start: State = (code) => {
    enter("wikiLink");
    if (code === BANG) { effects.consume(code); return first; }
    return first(code);
  };
  const first: State = (code) => {
    if (code !== BRACKET_OPEN) return nok(code);
    effects.consume(code);
    return second;
  };
  const second: State = (code) => {
    if (code !== BRACKET_OPEN) return nok(code);
    effects.consume(code);
    enter("wikiLinkData");
    return inside;
  };
  const inside: State = (code) => {
    if (isLineEnding(code) || code === BRACKET_OPEN) return nok(code);
    if (code === BRACKET_CLOSE) {
      if (!size) return nok(code);
      exit("wikiLinkData");
      effects.consume(code);
      return close;
    }
    effects.consume(code);
    size++;
    return inside;
  };
  const close: State = (code) => {
    if (code !== BRACKET_CLOSE) return nok(code);
    effects.consume(code);
    exit("wikiLink");
    return ok;
  };
  return start;
}

const construct: Construct = { name: "wikiLink", tokenize, add: "before" };

/** The syntax: ahead of links and images, so `[[` and `![[` are tried as wiki links first. */
export const wikiLinkSyntax: Extension = { text: { [BRACKET_OPEN]: construct, [BANG]: construct } };

/** The tree: a `wikiLink` node with what was between the brackets. */
export const wikiLinkFromMarkdown: FromMarkdownExtension = {
  enter: {
    wikiLink(this: CompileContext, token: Token) {
      this.enter({ type: "wikiLink", value: "", embed: false } as never, token);
    },
  },
  exit: {
    wikiLinkData(this: CompileContext, token: Token) {
      const node = this.stack[this.stack.length - 1] as unknown as WikiLinkNode;
      node.value = this.sliceSerialize(token);
    },
    wikiLink(this: CompileContext, token: Token) {
      const node = this.stack[this.stack.length - 1] as unknown as WikiLinkNode;
      node.embed = this.sliceSerialize(token).startsWith("!");
      this.exit(token);
    },
  },
};

/** What a wiki link names: `target#heading|alias` (a block reference `^id` stays part of the target's tail). */
export function splitWikiLink(value: string): { target: string; alias?: string } {
  const bar = value.indexOf("|");
  const target = (bar === -1 ? value : value.slice(0, bar)).trim();
  const alias = bar === -1 ? undefined : value.slice(bar + 1);
  return alias === undefined ? { target } : { target, alias };
}

/** The page a link's target names, without the heading or block it points into. */
export function linkPage(target: string): string {
  return target.split(/[#^]/)[0].trim();
}
