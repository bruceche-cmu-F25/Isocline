/** Other companies' marks, shown where Isocline connects to them: model providers, Google, Tailscale, connectors.
 *
 * The drawings are the files in ./svg (where each came from: ./README.md). To add one, put a cleaned SVG there;
 * its file name is its name here. A mark in one colour has no fill of its own, so it is drawn in the text colour
 * and follows light and dark; the others keep their colours.
 */
import { useId } from "react";

const FILES = import.meta.glob<string>("./svg/*.svg", { query: "?raw", import: "default", eager: true });
const MARKS = new Map(Object.entries(FILES).map(([path, svg]) => [path.slice("./svg/".length, -".svg".length), svg]));

/** A model provider's mark: the file named after its id (Pi's), or after the id with parts dropped from the end,
 * so "openai-codex" and "minimax-cn" find "openai" and "minimax". Undefined when there is none. */
export function providerMark(id: string, kind?: "subscription" | "key"): string | undefined {
  // The subscription is to Claude; the key is Anthropic's.
  if (id === "anthropic" && kind === "subscription") return "claude";
  for (let name = id; name; name = name.slice(0, Math.max(0, name.lastIndexOf("-")))) {
    // Google's models are Gemini; the plain G is the Google account.
    if (name === "google") return "gemini";
    if (MARKS.has(name)) return name;
  }
  return undefined;
}

/** A connector's mark: the catalog entry it came from, else its own name, else a part of its address
 * ("mcp.notion.com" finds "notion"). Undefined when there is none, and the row shows its first letter. */
export function connectorMark(server: { catalog?: string; name?: string; where?: string }): string | undefined {
  const names = [server.catalog, server.name?.toLowerCase()];
  try { if (server.where?.startsWith("http")) names.push(...new URL(server.where).hostname.split(".").slice(0, -1).reverse()); } catch { /* a command line */ }
  return names.find((name): name is string => !!name && MARKS.has(name));
}

/** The mark of the provider in a "provider/model" id. */
export const modelMark = (model: string | null | undefined) => (model?.includes("/") ? providerMark(model.slice(0, model.indexOf("/"))) : undefined);

/** A mark by name; nothing if there is no such mark. It sits next to the name in words, so it is hidden from screen readers. */
export function Logo({ name }: { name: string }) {
  const id = useId();
  const svg = MARKS.get(name);
  if (!svg) return null;
  // Gradients and masks are found by id, and ids are per document: each place a mark is drawn gets its own.
  return <span className="logo" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg.replaceAll("LOGO-", `${id}-`) }} />;
}
