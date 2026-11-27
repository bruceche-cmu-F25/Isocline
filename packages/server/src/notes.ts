/** The notes on the home node (notes.md 4.11, research 3.4): where the library is by default, the one address that
 * saves a page's text (not an operation: operations keep their input, and autosave would copy the user's notes into
 * the event log), and a watcher that reads the library again whenever another app changes a file in it. */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { currentStage, recordDomainEvent } from "@zirma/core";
import { savePage, type SaveAnswer } from "@zirma/module-notes";
import type { Home } from "./home.ts";
import { MAX_FILE_BYTES, sniff } from "./files.ts";
import { mirrorNoteTicks } from "./note-todos.ts";
import { HttpError, readBytes, readJson, send } from "./wire.ts";

/** Pages larger than this are not saved through the editor. */
export const MAX_PAGE_BYTES = 5 * 1024 * 1024;

/** The installed app keeps the notes in `~/Documents/notes`; a development or trial node keeps its own next to its
 * world, so it never writes into the user's real notes (AGENTS.md "Never touch"). ZIRMA_NOTES_DIR overrides both. */
export function defaultNotesRoot(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.ZIRMA_NOTES_DIR) return env.ZIRMA_NOTES_DIR;
  return currentStage(env) === "production" && !env.ZIRMA_DATA_DIR ? join(homedir(), "Documents", "notes") : join(dataDir, "notes");
}

interface NotesModuleHandle {
  library(world: Home["world"]): { library: import("@zirma/module-notes").Library; id: string };
  indexChanged?(world: Home["world"], ids: readonly string[]): number | null;
}

function notesOf(home: Home): NotesModuleHandle {
  const module = home.modules.find((candidate) => candidate.id === "note") as unknown as NotesModuleHandle | undefined;
  if (!module?.library) throw new HttpError(404, "Notes are not on this home node");
  return module;
}

/** POST /api/notes/save {library, id, base, text}: 200 {fp}, or 409 with why (another library; the file is not the
 * version the text was made from, with the file as it is now; a page of Zirma's). */
export async function notesRoute(home: Home, req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<boolean> {
  if (path === "/api/notes/attach") return attach(home, req, res, url);
  if (path === "/api/notes/file") return file(home, req, res, url);
  if (path === "/api/notes/reveal") return reveal(home, req, res);
  if (path !== "/api/notes/save") return false;
  if (req.method !== "POST") throw new HttpError(405, "POST only");
  const body = await readJson<{ library?: unknown; id?: unknown; base?: unknown; text?: unknown }>(req, MAX_PAGE_BYTES);
  if (typeof body.library !== "string" || typeof body.id !== "string" || typeof body.text !== "string" || !(typeof body.base === "string" || body.base === null)) {
    throw new HttpError(400, "library, id, base and text are required");
  }
  const { library, id } = notesOf(home).library(home.world);
  // What the page was, to see which to-dos were ticked or unticked by this save.
  let before: string | null = null;
  try { before = library.read(body.id)?.text ?? null; } catch (error) {
    // The save itself says what is wrong with the file; only the to-dos' mirror is lost here, so say that.
    home.log(`notes: could not read "${body.id}" before saving; its ticked to-dos will not reach the todo list: ${(error as Error).message}`);
  }
  let answer: SaveAnswer;
  try {
    answer = savePage(home.world, library, id, { library: body.library, id: body.id, base: body.base, text: body.text });
  } catch (error) {
    if ((error as Error).name === "LibraryError") throw new HttpError(400, (error as Error).message, (error as { code?: string }).code);
    throw error;
  }
  if (answer.ok) {
    announce(home, body.id);
    if (before !== null) mirrorNoteTicks(home.world, id, body.id, before, body.text, (message) => home.log(message));
  }
  send(res, answer.ok ? 200 : 409, answer);
  return true;
}

/** Devices learn of a change through an event (they read the state again when one comes). Autosave writes every
 * second or so: a page's saves are told at most every two seconds, and the last of a burst is always told, so an
 * open page on another device takes it in. The event carries the page's path only, never its words. */
const ANNOUNCE_MS = 2000;
/** Per home node (a test opens several in one process), and only pages told within the last window. */
const announcers = new WeakMap<Home, Map<string, { at: number; timer?: NodeJS.Timeout }>>();
function announce(home: Home, page: string): void {
  let announced = announcers.get(home);
  if (!announced) announcers.set(home, announced = new Map());
  for (const [name, entry] of announced) if (!entry.timer && Date.now() - entry.at >= ANNOUNCE_MS) announced.delete(name);
  const tell = () => {
    announced.set(page, { at: Date.now() });
    try { home.world.tx(() => recordDomainEvent(home.world, { kind: "note.saved", subject: `note:${page}`, actor: "user", payload: { page } })); } catch { /* the world is closing */ }
  };
  const last = announced.get(page);
  if (!last || Date.now() - last.at >= ANNOUNCE_MS) { tell(); return; }
  if (last.timer) return;
  last.timer = setTimeout(tell, ANNOUNCE_MS - (Date.now() - last.at));
  last.timer.unref();
}

/** Reads the library again a moment after a file in it changes (another app, a sync service). Follows the library
 * when the user points the notes elsewhere. The home node's own saves are read at once; seeing them again here costs
 * one look at a file's time and size. */
export function watchNotes(home: Home, log: (message: string) => void): () => void {
  let module: NotesModuleHandle;
  try { module = notesOf(home); } catch { return () => {}; }
  let watcher: FSWatcher | null = null;
  let root = "";
  let timer: NodeJS.Timeout | undefined;
  let running = false, again = false;
  /** The pages the watcher saw change since the last read; null: something it could not name (read everything). */
  let names: Set<string> | null = new Set();
  // A change during a pass gets one more pass after it: the running one may have listed the folder already.
  const read = () => {
    if (running) { again = true; return; }
    const changed = names;
    names = new Set();
    running = true;
    // Just the pages that changed when the watcher named them all (a save, an edit in another app); the whole
    // folder otherwise (a move, a folder, a file it could not name).
    const quick = changed && changed.size && module.indexChanged ? (() => { try { return module.indexChanged!(home.world, [...changed]) !== undefined; } catch { return false; } })() : false;
    (quick ? Promise.resolve() : home.syncModule("note")).catch((error: Error) => log(`notes: ${error.message}`)).finally(() => {
      running = false;
      if (again) { again = false; read(); }
    });
  };
  const pass = (name?: string | null) => {
    if (!name) names = null;
    else if (names) {
      const path = String(name).split(/[\\/]/).join("/");
      if (/\.md$/i.test(path) && !path.split("/").some((part) => part.startsWith("."))) names.add(path.replace(/\.md$/i, ""));
      else if (!path.split("/").some((part) => part.startsWith("."))) names = null;
    }
    clearTimeout(timer);
    timer = setTimeout(read, 400);
  };
  const follow = () => {
    let now: string;
    try { now = module.library(home.world).library.root; } catch { return; }
    if (now === root && watcher) return;
    watcher?.close();
    watcher = null;
    root = now;
    try {
      watcher = watch(root, { recursive: true }, (_event, name) => {
        // Saving writes a temporary file first, and versions go to the trash: neither is a page.
        if (name && /(^|\/)\.[^/]*$/.test(String(name)) && !String(name).endsWith(".md")) return;
        if (name && String(name).split(/[\\/]/).some((part) => part.startsWith("."))) return;
        pass(name ? String(name) : null);
      });
      watcher.on("error", () => { watcher?.close(); watcher = null; });
    } catch (error) {
      log(`notes: cannot watch ${root}: ${(error as Error).message}`);
    }
    pass(null);
  };
  follow();
  const every = setInterval(follow, 10_000);
  return () => { clearInterval(every); clearTimeout(timer); watcher?.close(); };
}

/** A page id from the address, or null for none. */
function pageParam(url: URL): string | null {
  const page = url.searchParams.get("page") ?? url.searchParams.get("from");
  return page && page.length <= 1000 ? page : null;
}

/** POST /api/notes/attach?page=<id>&name=<file name>, the bytes as the body: a file the user put in a page (a pasted
 * picture, a dropped PDF), kept in the library's attachment folder. Answers the name to embed. */
async function attach(home: Home, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method !== "POST") throw new HttpError(405, "POST only");
  const bytes = await readBytes(req, MAX_FILE_BYTES, () => new HttpError(413, "A file can be 20 MB at most", "file_too_big"));
  if (!bytes.length) throw new HttpError(400, "The file is empty", "empty");
  const { library } = notesOf(home).library(home.world);
  try {
    const saved = library.saveAttachment(pageParam(url), (url.searchParams.get("name") ?? "file").slice(0, 200), bytes);
    send(res, 201, { ...saved, image: sniff(bytes)?.kind === "image" });
  } catch (error) {
    if ((error as Error).name === "LibraryError") throw new HttpError(400, (error as Error).message, (error as { code?: string }).code);
    throw error;
  }
  return true;
}

/** GET /api/notes/file?name=<embed target>&from=<page>, or ?path=<a picture's path>&from=<page>: a file in the
 * library, found as Obsidian finds it. Only bytes to a browser: a picture is shown as a picture, anything else is
 * handed over as a download; neither may run anything. */
function file(home: Home, req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "GET only");
  const { library } = notesOf(home).library(home.world);
  const target = url.searchParams.get("name") ?? url.searchParams.get("path") ?? "";
  let found: string | null = null;
  try { found = target.length <= 1000 ? library.findFile(target, pageParam(url)) : null; } catch { found = null; }
  if (!found || /\.md$/i.test(found)) throw new HttpError(404, "No such file in the notes");
  const bytes = readFileSync(found);
  const kind = sniff(bytes);
  const name = found.split(/[\\/]/).pop()!;
  res.writeHead(200, {
    "Content-Type": kind?.kind === "image" ? kind.type : kind?.kind === "pdf" ? "application/pdf" : "application/octet-stream",
    "Content-Length": bytes.length, "Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    ...(kind?.kind === "image" ? {} : { "Content-Disposition": `${kind?.kind === "pdf" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}` }),
  });
  res.end(req.method === "HEAD" ? undefined : bytes);
  return true;
}

/** POST /api/notes/reveal {id?}: shows the notes folder, or one page's file, in the Finder of the Mac the home node
 * runs on. Only that Mac may ask (access.ts). */
async function reveal(home: Home, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "POST") throw new HttpError(405, "POST only");
  const body = await readJson<{ id?: unknown }>(req);
  const { library } = notesOf(home).library(home.world);
  let target = library.root;
  if (typeof body.id === "string" && body.id) {
    try { const file = library.file(body.id); if (existsSync(file)) target = file; } catch { /* the folder, then */ }
  }
  if (process.platform !== "darwin") throw new HttpError(501, "Only on a Mac");
  execFile("/usr/bin/open", target === library.root ? [target] : ["-R", target], () => {});
  send(res, 200, {});
  return true;
}
