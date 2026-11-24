/** Text as it is said aloud: what of a reply is read, and in what pieces (docs/design/voice.md §2). Pure, for tests. */

/** Markdown as it would be read aloud: code, links' addresses, tables and marks left out. */
export function forSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " ")          // code blocks
    .replace(/^\s*\|.*\|\s*$/gm, " ")              // table rows
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")         // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")       // links: their words
    .replace(/<?https?:\/\/[^\s>)]+>?/g, " ")      // bare addresses
    .replace(/`([^`]+)`/g, "$1")                   // inline code: its words
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "") // headings, quotes, list marks
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^\n]*?\S)\1/g, "$2") // emphasis
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Pieces to ask for one at a time: whole sentences, short ones joined, none longer than the node takes. */
export function sentences(text: string, max = 160): string[] {
  const parts = text.split(/(?<=[。！？!?；;…])\s*|(?<=[.])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    // A sentence longer than a piece is cut at a comma, or anywhere.
    const chunks = part.length <= max ? [part] : part.split(/(?<=[，,、])/).reduce<string[]>((acc, bit) => {
      if (acc.length && acc.at(-1)!.length + bit.length <= max) acc[acc.length - 1] += bit; else acc.push(bit);
      return acc;
    }, []).flatMap((bit) => bit.match(new RegExp(`[\\s\\S]{1,${max}}`, "g")) ?? []);
    for (const chunk of chunks) {
      const last = out.at(-1);
      // Join a short sentence to the one before, so the voice does not stop and start at every full stop.
      if (last && last.length < 24 && last.length + chunk.length <= max) out[out.length - 1] = `${last} ${chunk}`;
      else out.push(chunk);
    }
  }
  return out;
}

/** The first `count` sentences, for saying a long reply in short. */
export function firstSentences(text: string, count: number): { text: string; more: boolean } {
  const parts = text.split(/(?<=[。！？!?])\s*|(?<=[.])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
  return { text: parts.slice(0, count).join(" "), more: parts.length > count };
}
