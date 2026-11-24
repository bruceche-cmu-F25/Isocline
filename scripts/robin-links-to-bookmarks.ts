/** One-off: turns the links of a pi-web-robin install into a browser bookmarks file, so they come into Isocline the
 * way anyone's bookmarks do (Links page → ⋯ → Import bookmarks; docs/design/links.md §4.10.4). The app itself knows
 * nothing of Robin. Robin's database is only read.
 *
 *   node scripts/robin-links-to-bookmarks.ts [out.html]
 *     ROBIN_DB    Robin's database   (default ~/.pi/robin/tasks.sqlite)
 *     ROBIN_REPO  Robin's checkout   (default ~/pi-web-robin), for its own family rules; without it, groups stay flat
 *
 * Folders: Robin's family (学习, 求职…) when it has one, then the group. The file holds private addresses: it is written
 * to ~/Downloads by default, never into this repository.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const db = process.env.ROBIN_DB ?? join(homedir(), ".pi/robin/tasks.sqlite");
const repo = process.env.ROBIN_REPO ?? join(homedir(), "pi-web-robin");
const out = resolve(process.argv[2] ?? join(homedir(), "Downloads/robin-bookmarks.html"));
if (out.startsWith(resolve(import.meta.dirname, ".."))) throw new Error("Write the file outside this repository: it holds private addresses.");

interface Link { title: string; url: string; group?: string; createdAt: string }
const links = new DatabaseSync(db, { readOnly: true }).prepare("SELECT payload FROM links ORDER BY position").all()
  .map((row) => JSON.parse(row.payload as string) as Link);

// Robin's own families (link-families.ts), named as its panel names them.
const FAMILY: Record<string, string> = { jobs: "求职", learning: "学习", ideas: "灵感", daily: "日常", projects: "项目", money: "财务" };
let familyOf: (group: string) => string | undefined = () => undefined;
const rules = join(repo, "extension/robin/link-families.ts");
if (existsSync(rules)) familyOf = (await import(pathToFileURL(rules).href)).familyOf;
else console.warn(`No ${rules}: groups are written without families.`);

const tree = new Map<string, Map<string, Link[]>>();
for (const link of links) {
  const group = link.group?.trim() || "";
  const family = group ? FAMILY[familyOf(group) ?? ""] ?? "" : "";
  const groups = tree.get(family) ?? new Map<string, Link[]>();
  tree.set(family, groups);
  // A group named the same as its family adds nothing: its links sit right in the family's folder.
  const key = group === family ? "" : group;
  groups.set(key, [...(groups.get(key) ?? []), link]);
}

const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const when = (iso: string) => Math.floor(Date.parse(iso) / 1000) || 0;
const anchor = (link: Link, pad: string) => `${pad}<DT><A HREF="${esc(link.url)}" ADD_DATE="${when(link.createdAt)}">${esc(link.title)}</A>`;
const folder = (name: string, body: string[], pad: string) => [`${pad}<DT><H3>${esc(name)}</H3>`, `${pad}<DL><p>`, ...body, `${pad}</DL><p>`];
const lines: string[] = [];
for (const [family, groups] of tree) {
  const body = [...groups].flatMap(([group, items]) => group
    ? folder(group, items.map((link) => anchor(link, family ? "      " : "    ")), family ? "    " : "  ")
    : items.map((link) => anchor(link, family ? "    " : "  ")));
  lines.push(...(family ? folder(family, body, "  ") : body));
}
writeFileSync(out, ["<!DOCTYPE NETSCAPE-Bookmark-file-1>", '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
  "<TITLE>Bookmarks</TITLE>", "<H1>Bookmarks</H1>", "<DL><p>", ...lines, "</DL><p>", ""].join("\n"));
console.log(`${links.length} links in ${[...tree.values()].reduce((n, groups) => n + groups.size, 0)} groups → ${out}`);
