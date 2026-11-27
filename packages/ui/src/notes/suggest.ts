/** The assistant's suggestions shown where they apply in one of the user's pages (notes-two-layers.md 4.5): the words
 * to change struck through, the new words beside them, and under the block one line saying why, with No and Yes.
 * Only decorations: nothing is in the page until the user says yes, and the home node then writes exactly what was
 * shown. A suggestion whose words cannot be found in the page as it now reads is listed above the page instead. */
import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PmNode } from "prosemirror-model";
import type { Suggestion } from "@zirma/module-notes/types";
import { t } from "../i18n/index.ts";

export const suggestKey = new PluginKey("suggestions");

export interface SuggestHooks {
  list(): readonly Suggestion[];
  decide(suggestion: Suggestion, accept: boolean): void;
}

/** Markdown words as the editor shows them: links by name, emphasis without its marks. */
export function shown(markdown: string): string {
  return markdown
    .replace(/!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_all, target: string, alias?: string) => alias ?? target)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)(.+?)\1/g, "$2")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

export interface Placed { suggestion: Suggestion; from: number; to: number; after: number }

/** Where each edit suggestion's words are in the page as it now reads (the first block that has them). */
export function placeEdits(doc: PmNode, suggestions: readonly Suggestion[]): { placed: Placed[]; unplaced: Suggestion[] } {
  const left = suggestions.filter((one) => one.kind === "edit" && one.find);
  const placed: Placed[] = [];
  doc.descendants((node, pos) => {
    if (!left.length) return false;
    if (!node.isTextblock) return true;
    let text = "";
    const at: number[] = [];
    node.forEach((child, offset) => {
      if (!child.isText) return;
      for (let i = 0; i < child.text!.length; i++) { text += child.text![i]; at.push(pos + 1 + offset + i); }
    });
    for (let i = left.length - 1; i >= 0; i--) {
      const want = shown(left[i].find!);
      const found = want ? text.indexOf(want) : -1;
      if (found === -1) continue;
      placed.push({ suggestion: left[i], from: at[found], to: at[found + want.length - 1] + 1, after: pos + node.nodeSize });
      left.splice(i, 1);
    }
    return false;
  });
  return { placed, unplaced: left };
}

/** The card under a suggestion: why, on what it rests, and No / Yes. Plain DOM: it lives inside the editor. */
export function suggestionCard(suggestion: Suggestion, decide: SuggestHooks["decide"]): HTMLElement {
  const card = document.createElement("div");
  card.className = "nt-sug nt-sug-card";
  card.contentEditable = "false";
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", t("notes.sug.label"));
  const why = document.createElement("p");
  why.className = "nt-sug-why";
  const sources = suggestion.sources.map((source) => source.label).filter(Boolean);
  why.textContent = suggestion.reason + (sources.length ? ` · ${t("notes.sug.from")} ${sources.map((name) => t("notes.sug.page", { title: name })).join(" ")}` : "");
  const acts = document.createElement("div");
  acts.className = "nt-sug-acts";
  for (const [label, accept, primary] of [[t("notes.sug.no"), false, false], [t("notes.sug.yes"), true, true]] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = primary ? "nt-btn nt-pri" : "nt-btn";
    button.textContent = label;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => decide(suggestion, accept));
    acts.append(button);
  }
  card.append(why, acts);
  return card;
}

function decorations(state: EditorState, hooks: SuggestHooks): DecorationSet {
  const list = hooks.list();
  if (!list.length) return DecorationSet.empty;
  const { placed } = placeEdits(state.doc, list);
  const decos: Decoration[] = [];
  for (const { suggestion, from, to, after } of placed) {
    decos.push(Decoration.inline(from, to, { class: "nt-sug-del" }));
    decos.push(Decoration.widget(to, () => {
      const span = document.createElement("span");
      span.className = "nt-sug-ins";
      span.textContent = shown(suggestion.replace ?? "");
      return span;
    }, { side: 1, key: `ins-${suggestion.id}-${suggestion.replace}`, ignoreSelection: true }));
    decos.push(Decoration.widget(after, () => suggestionCard(suggestion, hooks.decide), { side: 1, key: `card-${suggestion.id}`, ignoreSelection: true, stopEvent: () => true }));
  }
  return DecorationSet.create(state.doc, decos);
}

export function suggestPlugin(hooks: SuggestHooks): Plugin {
  return new Plugin({ key: suggestKey, props: { decorations: (state) => decorations(state, hooks) } });
}

/** The block whose words are most like `words` (a line the assistant gathered from it), or -1. */
export function likeliestBlock(doc: PmNode, words: string): number {
  const pairs = (text: string) => {
    const plain = text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
    const out = new Set<string>();
    for (let i = 0; i < plain.length - 1; i++) out.add(plain.slice(i, i + 2));
    return out;
  };
  const want = pairs(words);
  if (!want.size) return -1;
  let best = -1, score = 0.25;
  doc.forEach((node, offset) => {
    const have = pairs(node.textContent);
    if (!have.size) return;
    let shared = 0;
    for (const pair of want) if (have.has(pair)) shared++;
    const now = shared / Math.min(want.size, have.size + 1);
    if (now > score) { score = now; best = offset; }
  });
  return best;
}
