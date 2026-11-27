/** The notes module's rules: which library is open, the index of it (pages, links, words), saving a page, and each
 * page's history (notes.md 4.3, 4.4; notes-two-layers.md 4.2, 4.6). The files are the truth; every table here can
 * be dropped and built again from them, except the history, which is Zirma's record of who changed what. */
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { newId, recordDomainEvent, type Migration, type World } from "@zirma/module-kit";
import { findTask, linkPage, parsePage, readableBlock, setProperty, taskRef, type Block, type ParsedPage } from "./markdown/index.ts";
import { fingerprint, idOf, Library, LibraryError, parentOf, safeName, ZIRMA_DIR, type PageFile, type SaveResult } from "./library.ts";
import type { HistoryEntry, NotePage, PageDetail, SearchHit } from "./types.ts";
import { addReject, addSkip, keptRow, moveRejects, noteKept, removeReject, removeSkip } from "./layer-store.ts";
import { addedLines } from "./kept-format.ts";

export const MIGRATIONS: Migration[] = [{
  id: "note:1",
  sql: `
CREATE TABLE note_library (
  one INTEGER PRIMARY KEY NOT NULL CHECK (one = 1),
  root TEXT NOT NULL,
  library TEXT NOT NULL,
  error TEXT,
  scanned_at TEXT
) STRICT;
CREATE TABLE note_pages (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  parent TEXT,
  file INTEGER NOT NULL,
  zirma INTEGER NOT NULL,
  icon TEXT,
  first TEXT NOT NULL DEFAULT '',
  fp TEXT,
  mtime REAL NOT NULL,
  size INTEGER NOT NULL
) STRICT;
CREATE TABLE note_links (
  page TEXT NOT NULL,
  target TEXT NOT NULL,
  resolved TEXT,
  embed INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX note_links_page ON note_links(page);
CREATE INDEX note_links_resolved ON note_links(resolved);
CREATE VIRTUAL TABLE note_text USING fts5(id UNINDEXED, title, body, tokenize = 'trigram');
CREATE TABLE note_history (
  id TEXT PRIMARY KEY NOT NULL,
  page TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('user', 'alfred')),
  kind TEXT NOT NULL CHECK (kind IN ('edit', 'create', 'rename', 'delete', 'links')),
  summary TEXT NOT NULL DEFAULT '',
  before TEXT,
  after TEXT,
  extra TEXT,
  undone INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX note_history_page ON note_history(page, at);
`,
}];

/** Saves of one page close together by the same hand are one change in its history (autosave writes every second). */
const EDIT_WINDOW_MS = 10 * 60_000;

export interface LibraryRow { root: string; library: string; error: string | null }

/** The open library: the one in settings, else the default (made the first time it is asked for). */
export function libraryRow(world: World, defaultRoot: string): LibraryRow {
  const row = world.db.prepare("SELECT root, library, error FROM note_library WHERE one = 1").get();
  if (row) return { root: row.root as string, library: row.library as string, error: (row.error as string | null) ?? null };
  return world.tx((db) => {
    const again = db.prepare("SELECT root, library, error FROM note_library WHERE one = 1").get();
    if (again) return { root: again.root as string, library: again.library as string, error: (again.error as string | null) ?? null };
    const library = randomBytes(8).toString("hex");
    db.prepare("INSERT INTO note_library (one, root, library) VALUES (1, ?, ?)").run(defaultRoot, library);
    return { root: defaultRoot, library, error: null };
  });
}

/** Points the notes at another folder. The old folder is left as it is; the index is built again from the new one,
 * and the library gets a new id so a late save meant for the old one is refused (research 3.4 rule 1). */
export function setLibrary(world: World, root: string): LibraryRow {
  const path = resolve(root);
  if (!isAbsolute(root) && !root.startsWith("~")) throw new LibraryError("bad_name", "The folder needs a full path");
  const library = randomBytes(8).toString("hex");
  world.tx((db) => {
    db.prepare("INSERT INTO note_library (one, root, library) VALUES (1, ?, ?) ON CONFLICT(one) DO UPDATE SET root = excluded.root, library = excluded.library, error = NULL, scanned_at = NULL").run(path, library);
    db.prepare("DELETE FROM note_pages").run();
    db.prepare("DELETE FROM note_links").run();
    db.prepare("DELETE FROM note_text").run();
    recordDomainEvent(world, { kind: "note.library_set", subject: "note:library", payload: { library } });
  });
  return { root: path, library, error: null };
}

function setLibraryError(world: World, error: string | null): void {
  world.tx((db) => db.prepare("UPDATE note_library SET error = ?, scanned_at = ? WHERE one = 1").run(error, new Date().toISOString()));
}

/* ── The index ── */

interface Indexed { icon: string | null; first: string; body: string; links: Array<{ target: string; embed: boolean }> }

function readIndexed(text: string): Indexed {
  const page = parsePage(text);
  const words = page.blocks.map((source) => readableBlock(source.block)).filter((line) => line.trim());
  const links: Indexed["links"] = [];
  for (const { block } of page.blocks) {
    if (!("content" in block)) continue;
    for (const run of block.content) if (run.t === "wiki") links.push({ target: run.target, embed: !!run.embed });
  }
  return { icon: page.front?.props.icon || null, first: (words[0] ?? "").replace(/\s+/g, " ").slice(0, 200), body: words.join("\n"), links };
}

function writeIndexed(world: World, file: PageFile, text: string | null): void {
  const { db } = world;
  const found = text === null ? null : readIndexed(text);
  db.prepare(`INSERT INTO note_pages (id, title, parent, file, zirma, icon, first, fp, mtime, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, parent = excluded.parent, file = excluded.file, zirma = excluded.zirma, icon = excluded.icon,
      first = excluded.first, fp = excluded.fp, mtime = excluded.mtime, size = excluded.size`)
    .run(file.id, file.title, file.parent, file.file ? 1 : 0, file.zirma ? 1 : 0, found?.icon ?? null, found?.first ?? "", text === null ? null : fingerprint(text), file.mtime, file.size);
  db.prepare("DELETE FROM note_links WHERE page = ?").run(file.id);
  db.prepare("DELETE FROM note_text WHERE id = ?").run(file.id);
  if (!found) return;
  const insert = db.prepare("INSERT INTO note_links (page, target, embed) VALUES (?, ?, ?)");
  for (const link of found.links) insert.run(file.id, link.target, link.embed ? 1 : 0);
  db.prepare("INSERT INTO note_text (id, title, body) VALUES (?, ?, ?)").run(file.id, file.title, found.body);
}

function dropIndexed(world: World, id: string): void {
  world.db.prepare("DELETE FROM note_pages WHERE id = ?").run(id);
  world.db.prepare("DELETE FROM note_links WHERE page = ?").run(id);
  world.db.prepare("DELETE FROM note_text WHERE id = ?").run(id);
}

/** Which page a link's target names (Obsidian's rules, without guessing): a path names that page; a bare name names
 * the one page with that name, and nothing when two pages share it. Case does not matter. */
export function resolveTarget(target: string, pages: ReadonlyMap<string, string[]>, ids: ReadonlySet<string>, from?: string | null): string | null {
  const name = linkPage(target).replace(/\.md$/i, "").replace(/^\/+/, "");
  if (!name) return null;
  const lower = name.toLowerCase();
  if (name.includes("/")) {
    if (ids.has(lower)) return lower;
    const ending = [...ids].filter((id) => id.endsWith(`/${lower}`));
    return ending.length === 1 ? ending[0] : null;
  }
  const named = pages.get(lower) ?? [];
  if (named.length === 1) return named[0];
  // Two pages of the same name: the one in the linking page's own folder, as Obsidian takes it; else not guessed.
  const folder = from ? (from.includes("/") ? from.slice(0, from.lastIndexOf("/")).toLowerCase() : "") : null;
  if (folder === null) return null;
  const here = named.filter((id) => (id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "") === folder);
  return here.length === 1 ? here[0] : null;
}

function resolveAll(world: World): void {
  const rows = world.db.prepare("SELECT id, title FROM note_pages WHERE file = 1 OR file = 0").all();
  const byLower = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const row of rows) {
    const id = row.id as string;
    byLower.set(id.toLowerCase(), id);
    const key = (row.title as string).toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), id.toLowerCase()]);
  }
  const ids = new Set(byLower.keys());
  const update = world.db.prepare("UPDATE note_links SET resolved = ? WHERE rowid = ?");
  for (const link of world.db.prepare("SELECT rowid, page, target, resolved FROM note_links").all()) {
    const found = resolveTarget(link.target as string, byName, ids, link.page as string);
    const id = found ? byLower.get(found) ?? null : null;
    if (id !== link.resolved) update.run(id, link.rowid as number);
  }
}

/** Reads what changed in the library into the index: new and changed files (by time and size, then fingerprint),
 * pages gone, and pages moved (a path gone and another with the same fingerprint appearing in the same pass is a
 * move, and the page's history moves with it). Returns how many pages changed. */
export function indexLibrary(world: World, library: Library, announce = false): number {
  if (!library.exists()) throw new LibraryError("not_found", "The notes folder is not there");
  const files = library.list();
  const known = new Map(world.db.prepare("SELECT id, fp, mtime, size, file FROM note_pages").all().map((row) => [row.id as string, row]));
  const seen = new Set(files.map((file) => file.id));
  const gone = [...known.keys()].filter((id) => !seen.has(id));
  let changed = 0;
  world.tx(() => {
    const goneByFp = new Map<string, string>();
    for (const id of gone) {
      const fp = known.get(id)!.fp as string | null;
      if (fp) goneByFp.set(fp, id);
    }
    for (const file of files) {
      const was = known.get(file.id);
      if (was && was.mtime === file.mtime && was.size === file.size && (was.file === 1) === file.file) continue;
      const text = file.file ? library.read(file.id)?.text ?? null : null;
      if (was && text !== null && was.fp === fingerprint(text) && (was.file === 1) === file.file) {
        world.db.prepare("UPDATE note_pages SET mtime = ?, size = ? WHERE id = ?").run(file.mtime, file.size, file.id);
        continue;
      }
      if (!was && text !== null) {
        const movedFrom = goneByFp.get(fingerprint(text));
        if (movedFrom) {
          world.db.prepare("UPDATE note_history SET page = ? WHERE page = ?").run(file.id, movedFrom);
          goneByFp.delete(fingerprint(text));
        }
      }
      writeIndexed(world, file, text);
      changed++;
    }
    for (const id of gone) { dropIndexed(world, id); changed++; }
    if (changed) resolveAll(world);
    // Read from the folder (another app, a sync service): devices learn of it through the event, and read again.
    if (changed && announce) recordDomainEvent(world, { kind: "note.indexed", subject: "note:library", payload: { changed } });
  });
  return changed;
}

/** Reads just these pages into the index, for the folder watcher: a file written or added is read again; anything
 * else (a file gone, a folder, a name it cannot tell) takes the whole pass, which also sees moves. Returns how many
 * pages changed, or null when it did the whole pass. */
export function indexFiles(world: World, library: Library, ids: readonly string[]): number | null {
  if (!ids.length || ids.length > 50) return indexLibrary(world, library, true);
  const files: PageFile[] = [];
  for (const id of ids) {
    let stats;
    try { stats = statSync(library.file(id)); } catch { return indexLibrary(world, library, true); }
    if (!stats.isFile()) return indexLibrary(world, library, true);
    const known = world.db.prepare("SELECT mtime, size FROM note_pages WHERE id = ?").get(id);
    // A new page under a folder that was not a page yet is easier for the whole pass.
    if (!known && id.includes("/") && !world.db.prepare("SELECT 1 FROM note_pages WHERE id = ?").get(parentOf(id))) return indexLibrary(world, library, true);
    if (known && known.mtime === stats.mtimeMs && known.size === stats.size) continue;
    files.push({ id, title: id.split("/").pop()!, parent: id.startsWith(`${ZIRMA_DIR}/`) && !id.slice(ZIRMA_DIR.length + 1).includes("/") ? null : parentOf(id), file: true, zirma: id.startsWith(`${ZIRMA_DIR}/`), mtime: stats.mtimeMs, size: stats.size });
  }
  if (!files.length) return 0;
  world.tx(() => {
    for (const file of files) writeIndexed(world, file, library.read(file.id)?.text ?? null);
    resolveAll(world);
    recordDomainEvent(world, { kind: "note.indexed", subject: "note:library", payload: { changed: files.length } });
  });
  return files.length;
}

/** Reads one page into the index right after Zirma wrote it (the watcher would, a moment later). */
export function indexOne(world: World, library: Library, id: string): void {
  const file = library.list().find((page) => page.id === id);
  if (!file) dropIndexed(world, id);
  else writeIndexed(world, file, file.file ? library.read(id)?.text ?? null : null);
  resolveAll(world);
}

/* ── Reading ── */

const toPage = (row: Record<string, unknown>): NotePage => ({
  id: row.id as string, title: row.title as string, parent: (row.parent as string | null) ?? null, file: row.file === 1, zirma: row.zirma === 1,
  icon: (row.icon as string | null) ?? null, first: row.first as string, mtime: Math.round(row.mtime as number),
});

export function listPages(world: World): NotePage[] {
  return world.db.prepare("SELECT * FROM note_pages ORDER BY lower(title), id").all().map(toPage);
}

export function getPage(world: World, id: string): NotePage | null {
  const row = world.db.prepare("SELECT * FROM note_pages WHERE id = ?").get(id);
  return row ? toPage(row) : null;
}

export function pageDetail(world: World, library: Library, libraryId: string, id: string): PageDetail {
  const page = getPage(world, id);
  const read = library.read(id);
  if (!page && !read) throw new LibraryError("not_found", `No page ${id}`);
  const mentions = world.db.prepare(`SELECT DISTINCT p.* FROM note_links l JOIN note_pages p ON p.id = l.page WHERE l.resolved = ? AND l.page != ? ORDER BY p.zirma, lower(p.title)`)
    .all(id, id).map(toPage);
  return {
    ...(page ?? { id, title: id.split("/").pop()!, parent: parentOf(id), file: !!read, zirma: id.startsWith(`${ZIRMA_DIR}/`), icon: null, first: "", mtime: read?.mtime ?? 0 }),
    library: libraryId,
    text: read?.text ?? "",
    fp: read?.fp ?? null,
    mentions,
  };
}

/** Words searched for in titles and in the words of pages. A term of three characters or more uses the trigram
 * index; a shorter one ("会议") is a plain match on the same words (research 3.4: trigrams cannot find it). */
export function searchPages(world: World, query: string, limit = 20): SearchHit[] {
  const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return [];
  const where: string[] = [];
  const params: (string | number)[] = [];
  for (const term of terms) {
    if ([...term].length >= 3) {
      where.push("note_text MATCH ?");
      params.push(`"${term.replace(/"/g, '""')}"`);
    } else {
      where.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
      const like = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
      params.push(like, like);
    }
  }
  const rows = world.db.prepare(`SELECT id, title, body FROM note_text WHERE ${where.join(" AND ")} LIMIT ?`).all(...params, limit * 3);
  const lower = terms.map((term) => term.toLowerCase());
  return rows
    .map((row) => {
      const title = row.title as string, body = row.body as string;
      const inTitle = lower.every((term) => title.toLowerCase().includes(term));
      const line = body.split("\n").find((text) => lower.some((term) => text.toLowerCase().includes(term))) ?? "";
      return { id: row.id as string, title, line: line.slice(0, 240), score: (inTitle ? 2 : 0) + (line ? 1 : 0) };
    })
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit)
    .map(({ score: _score, ...hit }) => hit);
}

/* ── Writing ── */

export type SaveAnswer =
  | { ok: true; fp: string }
  | { ok: false; reason: "library" }
  | { ok: false; reason: "changed"; current: { text: string; fp: string } | null; kept?: string }
  | { ok: false; reason: "zirma" };

/** Zirma's layer is written by Zirma's own task, never by a save from the editor (notes-two-layers.md 4.4: the
 * boundary is the library service's, by path). */
const inZirma = (id: string) => id === ZIRMA_DIR || id.startsWith(`${ZIRMA_DIR}/`);

/**
 * A save from the editor (research 3.4): refused when it was made in another library, refused when the file is not
 * the version it was made from (the answer carries the file as it is now), else written, read into the index, and
 * kept in the page's history.
 */
export function savePage(world: World, library: Library, libraryId: string, input: { library: string; id: string; base: string | null; text: string }, hooks?: { beforeSwap?: () => void }): SaveAnswer {
  if (input.library !== libraryId) return { ok: false, reason: "library" };
  if (inZirma(input.id)) return { ok: false, reason: "zirma" };
  const before = library.read(input.id);
  const saved: SaveResult = library.save(input.id, input.base, input.text, hooks);
  world.tx(() => {
    indexOne(world, library, input.id);
    // What did go in is history even when another app's version had to be set aside in the same moment.
    if (saved.ok || saved.written) recordEdit(world, input.id, before?.text ?? "", input.text, "user");
  });
  if (saved.ok) return saved;
  return { ok: false, reason: "changed", current: saved.current ? { text: saved.current.text, fp: saved.current.fp } : null, ...(saved.kept ? { kept: saved.kept } : {}) };
}

/** One change to a page's words in its history. The user's saves close together are one change; Zirma's each stand
 * alone, so each can be taken back by itself. Returns the entry's id. */
export function recordEdit(world: World, page: string, before: string, after: string, actor: "user" | "alfred", summary = "", extra?: Record<string, unknown>): string | null {
  if (before === after) return null;
  const now = new Date();
  const last = world.db.prepare("SELECT * FROM note_history WHERE page = ? ORDER BY at DESC, rowid DESC LIMIT 1").get(page);
  if (actor === "user" && !summary && !extra && last && !last.summary && !last.extra && last.kind === "edit" && last.actor === actor && !last.undone && last.after === before && now.getTime() - Date.parse(last.at as string) < EDIT_WINDOW_MS) {
    world.db.prepare("UPDATE note_history SET after = ?, at = ? WHERE id = ?").run(after, now.toISOString(), last.id as string);
    return last.id as string;
  }
  const id = newId();
  world.db.prepare("INSERT INTO note_history (id, page, at, actor, kind, summary, before, after, extra) VALUES (?, ?, ?, ?, 'edit', ?, ?, ?, ?)")
    .run(id, page, now.toISOString(), actor, summary, before, after, extra ? JSON.stringify(extra) : null);
  recordDomainEvent(world, { kind: "note.edited", subject: `note:${page}`, actor, payload: { page } });
  return id;
}

export function recordStep(world: World, page: string, kind: "create" | "rename" | "delete" | "links" | "adopt", extra: Record<string, unknown>, texts: { before?: string; after?: string } = {}, actor: "user" | "alfred" = "user"): string {
  const id = newId();
  world.db.prepare("INSERT INTO note_history (id, page, at, actor, kind, before, after, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, page, new Date().toISOString(), actor, kind, texts.before ?? null, texts.after ?? null, JSON.stringify(extra));
  recordDomainEvent(world, { kind: `note.${kind === "links" ? "links_updated" : kind === "create" ? "created" : kind === "rename" ? "renamed" : kind === "adopt" ? "adopted" : "deleted"}`, subject: `note:${page}`, actor, payload: { page, ...extra } });
  return id;
}

/** A new page: at the top of the user's layer unless a parent is named, with a name no page there has yet. */
export function createPage(world: World, library: Library, input: { parent?: string | null; title: string; text?: string; actor?: "user" | "alfred" }): { id: string } {
  if (input.parent && inZirma(input.parent)) throw new LibraryError("bad_name", "Zirma's pages are Zirma's");
  const id = library.freeName(input.parent ?? null, input.title);
  const text = input.text ?? `---\ncreated: ${new Date().toISOString().slice(0, 10)}\n---\n`;
  library.create(id, text);
  world.tx(() => {
    indexOne(world, library, id);
    recordStep(world, id, "create", { id }, { after: text }, input.actor ?? "user");
  });
  return { id };
}

/** Pages whose links name `id` change those links to `to` (notes.md 4.4 #5): only links that would no longer find
 * the page. Each page is one save with its own fingerprint; a page that is being changed elsewhere is skipped and
 * reported, never written over. */
function linkingPages(world: World, id: string): string[] {
  return world.db.prepare("SELECT DISTINCT page FROM note_links WHERE resolved = ?").all(id).map((row) => row.page as string);
}

function relink(world: World, library: Library, from: string, to: string, pages: readonly string[]): { changed: string[]; skipped: string[] } {
  const titleTo = to.split("/").pop()!;
  const othersNamed = world.db.prepare("SELECT count(*) AS n FROM note_pages WHERE lower(title) = lower(?) AND id != ? AND id != ?").get(titleTo, from, to)!.n as number;
  const changed: string[] = [], skipped: string[] = [];
  for (const page of pages) {
    if (page === from) continue;
    const read = library.read(page);
    if (!read) continue;
    const parsed = parsePage(read.text);
    const edits: Array<{ start: number; end: number; text: string }> = [];
    for (const source of parsed.blocks) {
      const { block } = source;
      if (!("content" in block)) continue;
      const slice = parsed.body.slice(source.start, source.end);
      let at = 0;
      for (const run of block.content) {
        if (run.t !== "wiki") continue;
        const found = slice.indexOf(run.raw, at);
        if (found === -1) continue;
        at = found + run.raw.length;
        const name = linkPage(run.target);
        const pointsHere = name.toLowerCase() === from.toLowerCase() || name.toLowerCase() === from.split("/").pop()!.toLowerCase() || from.toLowerCase().endsWith(`/${name.toLowerCase()}`);
        if (!pointsHere) continue;
        const short = !name.includes("/") && !othersNamed;
        const target = (short ? titleTo : to) + run.target.slice(linkPage(run.target).length === run.target.length ? run.target.length : run.target.search(/[#^]/));
        const raw = `${run.embed ? "!" : ""}[[${target}${run.alias !== undefined ? `|${run.alias}` : ""}]]`;
        if (raw !== run.raw) edits.push({ start: source.start + found, end: source.start + found + run.raw.length, text: raw });
      }
    }
    if (!edits.length) continue;
    let body = parsed.body;
    for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
    const text = (parsed.bom ? "\uFEFF" : "") + body;
    const saved = library.save(page, read.fp, text);
    if (!saved.ok) { skipped.push(page); continue; }
    // A page of Zirma's that followed a rename is still as Zirma left it.
    if (inZirma(page) && keptRow(world, page)?.fp === read.fp) noteKept(world, page, text, saved.fp);
    indexOne(world, library, page);
    recordStep(world, page, "links", { from, to }, { before: read.text, after: text });
    changed.push(page);
  }
  return { changed, skipped };
}

/** Renames and/or moves a page with its sub-pages; links that would lose it follow (notes.md 4.4 #5). */
export function movePage(world: World, library: Library, input: { id: string; title?: string; parent?: string | null }): { id: string; changed: string[]; skipped: string[] } {
  if (inZirma(input.id)) throw new LibraryError("bad_name", "Zirma's pages are Zirma's; make one yours first");
  const title = input.title !== undefined ? safeName(input.title) : input.id.split("/").pop()!;
  if (!title) throw new LibraryError("bad_name", "A page needs a name");
  const parent = input.parent !== undefined ? input.parent : parentOf(input.id);
  if (parent && inZirma(parent)) throw new LibraryError("bad_name", "Zirma's pages are Zirma's");
  const to = parent ? `${parent}/${title}` : title;
  if (to === input.id) return { id: to, changed: [], skipped: [] };
  // Which pages link here is read before the move: after it, their links no longer find the page.
  const linking = linkingPages(world, input.id).map((page) => (page === input.id || page.startsWith(`${input.id}/`) ? to + page.slice(input.id.length) : page));
  library.move(input.id, to);
  let result = { changed: [] as string[], skipped: [] as string[] };
  world.tx(() => {
    // The page, and every page under it, keep their history under the new names.
    world.db.prepare("UPDATE note_history SET page = ? || substr(page, ?) WHERE page = ? OR page LIKE ? ESCAPE '\\'")
      .run(to, input.id.length + 1, input.id, `${input.id.replace(/[\\%_]/g, "\\$&")}/%`);
    indexLibrary(world, library);
    recordStep(world, to, "rename", { from: input.id, to });
    result = relink(world, library, input.id, to, linking);
  });
  return { id: to, ...result };
}

/** Moves a page and its sub-pages to the library's trash. */
export function trashPage(world: World, library: Library, id: string): { place: string } {
  const place = library.trash(id);
  world.tx(() => {
    indexLibrary(world, library);
    // A page of Zirma's the user deleted: Zirma does not keep that subject again (notes-two-layers.md 4.4).
    if (inZirma(id)) addSkip(world, id.split("/").pop()!, "deleted");
    recordStep(world, id, "delete", { place, ...(inZirma(id) ? { skip: id.split("/").pop()! } : {}) });
  });
  return { place };
}

/** A page made here a moment ago and left as it was made (no words, no other change, no pages under it) is not
 * kept: opening "new page" or following a link to a page that is not there should not leave empty files behind.
 * Removed outright, not to the trash: there is nothing in it. Anything else about it keeps it. */
export function discardPage(world: World, library: Library, id: string): { ok: true } | { ok: false; reason: "changed" | "gone" } {
  if (inZirma(id)) return { ok: false, reason: "changed" };
  const rows = world.db.prepare("SELECT * FROM note_history WHERE page = ?").all(id);
  const read = library.read(id);
  if (!read) return { ok: false, reason: "gone" };
  const made = rows.length === 1 && rows[0].kind === "create" && rows[0].undone === 0 ? rows[0] : null;
  if (!made || made.after !== read.text || library.list().some((page) => page.parent === id)) return { ok: false, reason: "changed" };
  library.removeUntouched(id);
  world.tx(() => {
    world.db.prepare("DELETE FROM note_history WHERE page = ?").run(id);
    indexLibrary(world, library);
    recordDomainEvent(world, { kind: "note.discarded", subject: `note:${id}`, payload: { page: id } });
  });
  return { ok: true };
}

/** Sets or removes the page's icon (by name, `icon: cup`): one line at the top of the file changes. */
export function setIcon(world: World, library: Library, libraryId: string, input: { id: string; icon: string | null }): SaveAnswer {
  const read = library.read(input.id);
  if (!read) throw new LibraryError("not_found", `No page ${input.id}`);
  return savePage(world, library, libraryId, { library: libraryId, id: input.id, base: read.fp, text: setProperty(read.text, "icon", input.icon) });
}

/* ── History ── */

/** The lines one change took out and put in, for showing (a short line diff of the two versions). */
export function changedLines(before: string, after: string, most = 12): Array<{ k: "add" | "del"; text: string }> {
  const a = before.split(/\r?\n/), b = after.split(/\r?\n/);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out: Array<{ k: "add" | "del"; text: string }> = [];
  for (const line of a.slice(head, a.length - tail)) if (line.trim()) out.push({ k: "del", text: line });
  for (const line of b.slice(head, b.length - tail)) if (line.trim()) out.push({ k: "add", text: line });
  return out.slice(0, most);
}

export function listHistory(world: World, page: string, most = 50): HistoryEntry[] {
  return world.db.prepare("SELECT * FROM note_history WHERE page = ? ORDER BY at DESC, rowid DESC LIMIT ?").all(page, most).map((row) => ({
    id: row.id as string, page: row.page as string, at: row.at as string, actor: row.actor as "user" | "alfred", kind: row.kind as HistoryEntry["kind"],
    summary: row.summary as string, undone: row.undone === 1,
    lines: row.kind === "edit" || row.kind === "links" ? changedLines((row.before as string | null) ?? "", (row.after as string | null) ?? "") : [],
    extra: row.extra ? JSON.parse(row.extra as string) : {},
    // Undo needs the texts; past the time they are kept, an entry is only a record.
    undoable: row.kind === "edit" || row.kind === "links" || row.kind === "create" || row.kind === "adopt" ? row.before !== null || row.after !== null : true,
  }));
}

/** `to` in `current` swapped back to `from`: the whole file when it is still exactly `to`, else just the lines the
 * change touched, when they are still there, once. Null when they are not: the page changed there since. */
export function swapBack(current: string, from: string, to: string): string | null {
  if (current === to) return from;
  let head = 0;
  while (head < from.length && head < to.length && from[head] === to[head]) head++;
  let tail = 0;
  while (tail < from.length - head && tail < to.length - head && from[from.length - 1 - tail] === to[to.length - 1 - tail]) tail++;
  // Whole lines, with one line of context on each side so a pure insertion or removal has something to find.
  let start = to.lastIndexOf("\n", head - 1);
  start = start <= 0 ? 0 : to.lastIndexOf("\n", start - 1) + 1;
  const toEnd = to.length - tail;
  let end = to.indexOf("\n", toEnd);
  end = end === -1 ? to.length : to.indexOf("\n", end + 1) === -1 ? to.length : to.indexOf("\n", end + 1);
  const fromEnd = from.length - (to.length - end);
  const toPart = to.slice(start, end), fromPart = from.slice(start, fromEnd);
  if (!toPart) return null;
  const at = current.indexOf(toPart);
  if (at === -1 || current.indexOf(toPart, at + 1) !== -1) return null;
  return current.slice(0, at) + fromPart + current.slice(at + toPart.length);
}

export type UndoAnswer = { ok: true } | { ok: false; reason: "changed" | "gone" | "exists" | "not_undoable" };

/** Takes one change back, or puts it back again (`redo`). Only the lines it changed are touched, and only while they
 * are still as it left them (notes-two-layers.md 4.6). */
export function flipHistory(world: World, library: Library, entryId: string, redo = false): UndoAnswer {
  const row = world.db.prepare("SELECT * FROM note_history WHERE id = ?").get(entryId);
  if (!row) throw new LibraryError("not_found", "No such change");
  if ((row.undone === 1) !== redo) return { ok: true };
  const page = row.page as string;
  const extra = row.extra ? JSON.parse(row.extra as string) as Record<string, string> : {};
  const before = row.before as string | null, after = row.after as string | null;
  const mark = () => world.tx(() => {
    world.db.prepare("UPDATE note_history SET undone = ? WHERE id = ?").run(redo ? 0 : 1, entryId);
    recordDomainEvent(world, { kind: redo ? "note.redone" : "note.undone", subject: `note:${page}`, payload: { entry: entryId, page } });
  });
  try {
    switch (row.kind) {
      case "edit": case "links": {
        if (before === null || after === null) return { ok: false, reason: "not_undoable" };
        const read = library.read(page);
        if (!read) return { ok: false, reason: "gone" };
        const next = redo ? swapBack(read.text, after, before) : swapBack(read.text, before, after);
        if (next === null) return { ok: false, reason: "changed" };
        const saved = library.save(page, read.fp, next);
        if (!saved.ok) return { ok: false, reason: "changed" };
        world.tx(() => {
          indexOne(world, library, page);
          if (inZirma(page)) {
            noteKept(world, page, next, saved.fp);
            const store = { ...extra } as Record<string, unknown>;
            // A line the user removed and then put back is no longer one they said no to; removed again, it is.
            if (typeof store.words === "string") {
              if (!redo && typeof store.reject === "number") { removeReject(world, store.reject); delete store.reject; }
              if (redo) store.reject = addReject(world, page, store.words, (store.sources as string[] | undefined) ?? []);
            }
            // Zirma's change taken back: what it added is not added again (notes-two-layers.md 4.6).
            if (row.actor === "alfred") {
              if (!redo) store.rejects = addedLines(before, after).map((line) => addReject(world, page, line.words, line.sources));
              else { for (const reject of (store.rejects as number[] | undefined) ?? []) removeReject(world, reject); delete store.rejects; }
            }
            world.db.prepare("UPDATE note_history SET extra = ? WHERE id = ?").run(JSON.stringify(store), entryId);
          }
        });
        mark();
        return { ok: true };
      }
      case "create": {
        if (!redo) {
          const read = library.read(page);
          if (!read) return { ok: false, reason: "gone" };
          if (after !== null && read.text !== after) return { ok: false, reason: "changed" };
          const place = library.trash(page);
          world.tx(() => {
            world.db.prepare("UPDATE note_history SET extra = ? WHERE id = ?").run(JSON.stringify({ ...extra, place }), entryId);
            indexLibrary(world, library);
            if (inZirma(page)) addSkip(world, page.split("/").pop()!, "deleted");
          });
        } else {
          if (!extra.place) return { ok: false, reason: "gone" };
          library.restore(page, extra.place);
          world.tx(() => {
            indexLibrary(world, library);
            if (inZirma(page)) removeSkip(world, page.split("/").pop()!);
          });
        }
        mark();
        return { ok: true };
      }
      case "delete": {
        if (!redo) library.restore(page, extra.place);
        else {
          const place = library.trash(page);
          world.tx(() => world.db.prepare("UPDATE note_history SET extra = ? WHERE id = ?").run(JSON.stringify({ ...extra, place }), entryId));
        }
        world.tx(() => {
          indexLibrary(world, library);
          if (extra.skip) { if (redo) addSkip(world, extra.skip, "deleted"); else removeSkip(world, extra.skip); }
        });
        mark();
        return { ok: true };
      }
      case "rename": {
        const [now, back] = redo ? [extra.from, extra.to] : [extra.to, extra.from];
        library.move(now, back);
        world.tx(() => {
          world.db.prepare("UPDATE note_history SET page = ? || substr(page, ?) WHERE page = ? OR page LIKE ? ESCAPE '\\'")
            .run(back, now.length + 1, now, `${now.replace(/[\\%_]/g, "\\$&")}/%`);
          indexLibrary(world, library);
        });
        mark();
        return { ok: true };
      }
      case "adopt": {
        // Taking a page of Zirma's back to Zirma: the file goes back to its place and its words to Zirma's, while
        // the user's copy is still exactly as it was taken. Doing it again takes it once more.
        const [here, there, now, back] = redo ? [extra.from, extra.to, before, after] : [extra.to, extra.from, after, before];
        if (now === null || back === null) return { ok: false, reason: "not_undoable" };
        const read = library.read(here);
        if (!read) return { ok: false, reason: "gone" };
        if (read.text !== now) return { ok: false, reason: "changed" };
        if (library.read(there)) return { ok: false, reason: "exists" };
        library.create(there, back);
        library.removeUntouched(here);
        world.tx(() => {
          world.db.prepare("UPDATE note_history SET page = ? WHERE page = ?").run(there, here);
          moveRejects(world, here, there);
          if (redo) addSkip(world, extra.from.split("/").pop()!, "adopted");
          else { noteKept(world, there, back, library.read(there)!.fp); removeSkip(world, extra.from.split("/").pop()!); }
          indexLibrary(world, library);
        });
        mark();
        return { ok: true };
      }
    }
  } catch (error) {
    if (error instanceof LibraryError) return { ok: false, reason: error.code === "exists" ? "exists" : error.code === "not_found" ? "gone" : "changed" };
    throw error;
  }
  return { ok: false, reason: "not_undoable" };
}

/** Undo texts older than `days` are let go: the entry stays as a record (notes-two-layers.md §9 #3). */
export function pruneHistory(world: World, days = 30): void {
  const before = new Date(Date.now() - days * 86_400_000).toISOString();
  world.tx((db) => db.prepare("UPDATE note_history SET before = NULL, after = NULL WHERE at < ? AND (before IS NOT NULL OR after IS NOT NULL)").run(before));
}

/* ── For Zirma's tools ── */

/** A change Zirma proposed (`note_edit`), applied once the user said yes: the words it named are replaced if they
 * are still in the page exactly once; otherwise the proposal no longer fits and nothing is written. */
export function applyEdit(world: World, library: Library, libraryId: string, input: { id: string; find: string; replace: string }): SaveAnswer | { ok: false; reason: "stale" } {
  const read = library.read(input.id);
  if (!read) throw new LibraryError("not_found", `No page ${input.id}`);
  const at = read.text.indexOf(input.find);
  if (!input.find || at === -1 || read.text.indexOf(input.find, at + 1) !== -1) return { ok: false, reason: "stale" };
  const text = read.text.slice(0, at) + input.replace + read.text.slice(at + input.find.length);
  return savePage(world, library, libraryId, { library: libraryId, id: input.id, base: read.fp, text });
}

export function blocksOf(text: string): Block[] {
  return parsePage(text).blocks.map((source) => source.block);
}

export type { ParsedPage };
export { idOf };

/* ── To-dos and the todo list ── */

/** The to-dos whose box changed between two versions of a page, by their todo ref: what the todo list mirrors. */
export function taskChanges(libraryId: string, page: string, before: string, after: string): Array<{ ref: string; checked: boolean }> {
  const boxes = (text: string) => {
    const blocks = parsePage(text).blocks.map((source) => source.block);
    const out = new Map<string, boolean>();
    blocks.forEach((block, i) => { const ref = taskRef(libraryId, page, blocks, i); if (ref && block.kind === "item") out.set(ref, !!block.checked); });
    return out;
  };
  const was = boxes(before), now = boxes(after);
  return [...now].filter(([ref, checked]) => was.has(ref) && was.get(ref) !== checked).map(([ref, checked]) => ({ ref, checked }));
}

/** Ticks or unticks one to-do in its page because the user finished or reopened it on the todo list: only the box in
 * that line changes, the page's history says so, and nothing is written when the box is already so, when the to-do
 * is not found by its words, or when the page is not in this library. */
export function setTaskChecked(world: World, library: Library, libraryId: string, ref: string, checked: boolean): boolean {
  const found = /^note:([^:]+):(.+)#([0-9a-f]+):(\d+)$/.exec(ref);
  if (!found || found[1] !== libraryId || inZirma(found[2])) return false;
  const [, , page, key, nth] = found;
  const read = library.read(page);
  if (!read) return false;
  const parsed = parsePage(read.text);
  const index = findTask(parsed.blocks.map((source) => source.block), key, Number(nth));
  if (index === -1) return false;
  const source = parsed.blocks[index];
  if (source.block.kind !== "item" || !!source.block.checked === checked) return false;
  const box = /\[[ xX]\]/.exec(source.marker ?? "");
  if (!box) return false;
  const at = source.start + box.index;
  const body = parsed.body.slice(0, at) + (checked ? "[x]" : "[ ]") + parsed.body.slice(at + 3);
  const text = (parsed.bom ? "\uFEFF" : "") + body;
  const saved = library.save(page, read.fp, text);
  if (!saved.ok) return false;
  world.tx(() => {
    indexOne(world, library, page);
    const id = newId();
    world.db.prepare("INSERT INTO note_history (id, page, at, actor, kind, summary, before, after) VALUES (?, ?, ?, 'user', 'edit', ?, ?, ?)")
      .run(id, page, new Date().toISOString(), checked ? "todo.done" : "todo.reopened", read.text, text);
    recordDomainEvent(world, { kind: "note.saved", subject: `note:${page}`, actor: "user", payload: { page } });
  });
  return true;
}

