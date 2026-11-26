/** The library on disk (notes.md 4.1, 4.4; research 3.4): a folder of Markdown files that is the truth. A page is
 * `Name.md`, and a page with pages under it also has a folder `Name/`; a folder another app made without its `.md`
 * is a page too, with nothing written in it. Dot files and dot folders (`.obsidian/`, `.trash/`) are not pages.
 *
 * Everything here is synchronous on purpose: on the home node nothing else runs between "compare the fingerprint"
 * and "put the new file in place", so two saves of one file from Zirma cannot interleave (research 3.4 rule 3).
 * Another app writing in that moment is the one race left, and the displaced file is kept for it (rule 5). */
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/** Zirma's layer of the library (notes-two-layers.md 4.1): fixed, whatever the language. */
export const ZIRMA_DIR = "zirma_notes";
/** Where deleted pages and displaced versions go, inside the library (Obsidian's own convention for `.trash`). */
export const TRASH_DIR = ".trash";
export const VERSIONS_DIR = join(TRASH_DIR, ".versions");
/** "About you" is left out of git (notes-two-layers.md 4.8), under both names it can have. */
const GITIGNORE = `${ZIRMA_DIR}/关于你.md\n${ZIRMA_DIR}/About you.md\n`;

export interface PageFile {
  /** The page's path in the library without `.md`, with `/` between folders: `手冲/V60 参数`. */
  id: string;
  title: string;
  parent: string | null;
  /** Whether `<id>.md` exists (a folder without one is a page with nothing written in it). */
  file: boolean;
  /** In Zirma's layer. */
  zirma: boolean;
  mtime: number;
  size: number;
}

export type LibraryErrorCode = "not_found" | "exists" | "bad_name" | "outside" | "not_empty";
export class LibraryError extends Error {
  override name = "LibraryError";
  readonly code: LibraryErrorCode;
  constructor(code: LibraryErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** A text's fingerprint: what a save names as the version it was made from. */
export function fingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

/** A title as a file name the system and Obsidian both take: no slashes or the characters Windows forbids, no
 * leading dot, no control characters, not too long. Empty when nothing is left. */
export function safeName(title: string): string {
  return title
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120)
    .trim();
}

const isHidden = (name: string) => name.startsWith(".");

/** The page id as segments, refused if it could leave the library or names something hidden. */
function segments(id: string): string[] {
  const parts = id.split("/");
  if (!id || parts.some((part) => !part || part === "." || part === ".." || isHidden(part) || /[\u0000-\u001f\\]/.test(part))) {
    throw new LibraryError("bad_name", `Not a page in the library: ${id}`);
  }
  return parts;
}

export function idOf(path: string): string {
  return path.split(sep).join("/").replace(/\.md$/i, "");
}

const titleOf = (id: string) => id.slice(id.lastIndexOf("/") + 1);
export const parentOf = (id: string): string | null => (id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : null);

export class Library {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  /** Makes the library if it is not there: the folder, Zirma's layer in it, and the `.gitignore` for "About you". */
  ensure(): void {
    mkdirSync(join(this.root, ZIRMA_DIR), { recursive: true });
    const ignore = join(this.root, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, GITIGNORE);
  }

  exists(): boolean {
    try { return statSync(this.root).isDirectory(); } catch { return false; }
  }

  /** The file of a page (`<id>.md`), checked to stay inside the library even through symbolic links. */
  file(id: string): string {
    return this.inside(join(this.root, ...segments(id)) + ".md");
  }

  /** The folder of a page's sub-pages. */
  folder(id: string): string {
    return this.inside(join(this.root, ...segments(id)));
  }

  inside(path: string): string {
    const root = realpathSync(this.root);
    // The nearest part of the path that exists, resolved: a link pointing out of the library is refused.
    let probe = path;
    while (!existsSync(probe) && probe !== dirname(probe)) probe = dirname(probe);
    const real = realpathSync(probe);
    const rel = relative(root, real);
    if (rel.startsWith("..") || (rel && rel.split(sep).includes(".."))) throw new LibraryError("outside", "Outside the library");
    return path;
  }

  /** Every page, folders included, in no particular order. Hidden files and folders are skipped. */
  list(): PageFile[] {
    const out: PageFile[] = [];
    const walk = (dir: string, prefix: string) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      const files = new Set(entries.filter((entry) => entry.isFile() && /\.md$/i.test(entry.name)).map((entry) => entry.name.replace(/\.md$/i, "")));
      for (const entry of entries) {
        if (isHidden(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isFile() && /\.md$/i.test(entry.name)) {
          const id = prefix + entry.name.replace(/\.md$/i, "");
          const stats = statSync(full);
          out.push({ id, title: titleOf(id), parent: parentOf(id), file: true, zirma: id === ZIRMA_DIR || id.startsWith(`${ZIRMA_DIR}/`), mtime: stats.mtimeMs, size: stats.size });
        } else if (entry.isDirectory()) {
          const id = prefix + entry.name;
          const before = out.length;
          walk(full, `${id}/`);
          // A folder with no page of its own but pages in it is a page with nothing written. A folder of only files
          // (the attachments) is not a page; nor is Zirma's own folder.
          if (!files.has(entry.name) && id !== ZIRMA_DIR && out.length > before) {
            const stats = statSync(full);
            out.push({ id, title: titleOf(id), parent: parentOf(id), file: false, zirma: id.startsWith(`${ZIRMA_DIR}/`), mtime: stats.mtimeMs, size: 0 });
          }
        }
      }
    };
    walk(this.root, "");
    // Pages straight inside Zirma's folder have no parent page.
    for (const page of out) if (page.parent === ZIRMA_DIR) page.parent = null;
    return out;
  }

  read(id: string): { text: string; fp: string; mtime: number } | null {
    const path = this.file(id);
    try {
      const text = readFileSync(path, "utf8");
      return { text, fp: fingerprint(text), mtime: statSync(path).mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /**
   * Saves a page's text if the file is still the version the text was made from (`base`; null for a page that is
   * not on disk yet). A different file on disk is never written over: the answer carries what is there instead.
   * The new text goes to a temporary file first and is renamed into place, so nobody reads half a page; the file it
   * replaces is moved aside first and compared once more, so another app's write in that instant is kept
   * (`.trash/.versions/`) and reported, not lost. `beforeSwap` is for tests: it runs in that instant.
   */
  save(id: string, base: string | null, text: string, hooks: { beforeSwap?: () => void } = {}): SaveResult {
    const path = this.file(id);
    const current = this.read(id);
    if ((base === null && current) || (base !== null && current?.fp !== base)) return { ok: false, current };
    mkdirSync(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.${randomBytes(6).toString("hex")}.zirma-saving`);
    writeFileSync(temporary, text);
    hooks.beforeSwap?.();
    let displaced: string | null = null;
    if (existsSync(path)) {
      displaced = this.versionPath(id);
      mkdirSync(dirname(displaced), { recursive: true });
      renameSync(path, displaced);
    }
    renameSync(temporary, path);
    const fp = fingerprint(text);
    if (displaced) {
      const was = readFileSync(displaced, "utf8");
      if (fingerprint(was) === base) unlinkSync(displaced);
      else return { ok: false, current: { text: was, fp: fingerprint(was), mtime: Date.now() }, written: fp, kept: relative(this.root, displaced) };
    }
    return { ok: true, fp };
  }

  private versionPath(id: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return join(this.root, VERSIONS_DIR, `${id.replace(/\//g, " ∕ ")} ${stamp} ${randomBytes(3).toString("hex")}.md`);
  }

  /** A name for a new page under `parent` that no page there has yet: the title, else "title 2", "title 3"… */
  freeName(parent: string | null, title: string): string {
    const base = safeName(title);
    if (!base) throw new LibraryError("bad_name", "A page needs a name");
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${base} ${n}`;
      const id = parent ? `${parent}/${name}` : name;
      if (!existsSync(this.file(id)) && !existsSync(this.folder(id))) return id;
    }
  }

  /** Writes a new page. Refuses a name that is taken. */
  create(id: string, text: string): string {
    if (existsSync(this.file(id)) || existsSync(this.folder(id))) throw new LibraryError("exists", `A page is already called ${titleOf(id)}`);
    const saved = this.save(id, null, text);
    if (!saved.ok) throw new LibraryError("exists", `A page is already called ${titleOf(id)}`);
    return id;
  }

  /** Moves a page (its file and its folder of sub-pages) to a new id: a rename, a move, or both. If the second of
   * the two moves fails, the first is undone, so a page is never left half moved. */
  move(from: string, to: string): void {
    if (from === to) return;
    if (to.startsWith(`${from}/`)) throw new LibraryError("bad_name", "A page cannot go inside itself");
    const file = this.file(from), folder = this.folder(from);
    const hasFile = existsSync(file), hasFolder = existsSync(folder) && lstatSync(folder).isDirectory();
    if (!hasFile && !hasFolder) throw new LibraryError("not_found", `No page ${from}`);
    const toFile = this.file(to), toFolder = this.folder(to);
    // The same name in another case is the same page on macOS: renaming to it is allowed.
    const sameIgnoringCase = from.toLowerCase() === to.toLowerCase();
    if (!sameIgnoringCase && (existsSync(toFile) || existsSync(toFolder))) throw new LibraryError("exists", `A page is already called ${titleOf(to)}`);
    mkdirSync(dirname(toFile), { recursive: true });
    if (hasFile) renameSync(file, toFile);
    if (hasFolder) {
      try { renameSync(folder, toFolder); } catch (error) {
        if (hasFile) renameSync(toFile, file);
        throw error;
      }
    }
  }

  /** Removes a page's file that has nothing in it worth keeping (discardPage decides), and its folder if empty. */
  removeUntouched(id: string): void {
    rmSync(this.file(id), { force: true });
    try { if (!readdirSync(this.folder(id)).length) rmSync(this.folder(id), { recursive: true }); } catch { /* no folder */ }
  }

  /** Moves a page and its sub-pages into `.trash/<when>/`. Returns where, for putting it back. */
  trash(id: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const place = join(TRASH_DIR, `${stamp} ${randomBytes(3).toString("hex")}`);
    const into = join(this.root, place);
    const file = this.file(id), folder = this.folder(id);
    const hasFile = existsSync(file), hasFolder = existsSync(folder);
    if (!hasFile && !hasFolder) throw new LibraryError("not_found", `No page ${id}`);
    mkdirSync(into, { recursive: true });
    const name = titleOf(id);
    if (hasFile) renameSync(file, join(into, `${name}.md`));
    if (hasFolder) renameSync(folder, join(into, name));
    return place;
  }

  /** Puts a trashed page back where it was. Refuses if a page took its name since. */
  restore(id: string, place: string): void {
    const from = join(this.root, place);
    if (!place.startsWith(TRASH_DIR) || place.includes("..")) throw new LibraryError("outside", "Not in the trash");
    const name = titleOf(id);
    const file = join(from, `${name}.md`), folder = join(from, name);
    if (!existsSync(file) && !existsSync(folder)) throw new LibraryError("not_found", "It is no longer in the trash");
    if (existsSync(this.file(id)) || existsSync(this.folder(id))) throw new LibraryError("exists", `A page is already called ${name}`);
    mkdirSync(dirname(this.file(id)), { recursive: true });
    if (existsSync(file)) renameSync(file, this.file(id));
    if (existsSync(folder)) renameSync(folder, this.folder(id));
    rmSync(from, { recursive: true, force: true });
  }

  /** Where new attachments go for a page (notes.md 4.4 #7): Obsidian's own setting when the library has one
   * (`.obsidian/app.json`, read only), else `Attachments/` at the top. A path inside the library, `/` between parts. */
  attachmentDir(page: string | null): string {
    let setting: unknown;
    try { setting = JSON.parse(readFileSync(join(this.root, ".obsidian", "app.json"), "utf8")).attachmentFolderPath; } catch { setting = undefined; }
    const folder = page ? parentOf(page) ?? "" : "";
    if (typeof setting !== "string" || !setting.trim()) return "Attachments";
    const said = setting.trim().replace(/\\/g, "/");
    if (said === "/") return "";
    if (said === "./" || said === ".") return folder;
    if (said.startsWith("./")) return [folder, said.slice(2)].filter(Boolean).join("/").replace(/\/+$/, "");
    return said.replace(/^\/+|\/+$/g, "");
  }

  /** Keeps a file the user put in a page (a pasted picture, a dropped PDF). A pasted picture with no name of its
   * own is named as Obsidian names one; a name that is taken gets a number. Answers the name to embed (`![[name]]`). */
  saveAttachment(page: string | null, name: string, bytes: Uint8Array): { name: string; path: string } {
    const dir = this.attachmentDir(page);
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) : "";
    let stem = safeName(dot > 0 ? name.slice(0, dot) : name);
    if (!stem || /^image$/i.test(stem)) {
      const now = new Date(), pad = (n: number) => String(n).padStart(2, "0");
      stem = `Pasted image ${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    }
    const at = dir ? join(this.root, ...dir.split("/")) : this.root;
    this.inside(at);
    mkdirSync(at, { recursive: true });
    for (let n = 0; ; n++) {
      const file = `${n ? `${stem} ${n}` : stem}${ext ? `.${ext}` : ""}`;
      const path = join(at, file);
      if (existsSync(path)) continue;
      writeFileSync(path, bytes, { flag: "wx" });
      return { name: file, path: [dir, file].filter(Boolean).join("/") };
    }
  }

  /** The file an embed or a picture names (`![[图.png]]`, `![](图/a.png)`), as Obsidian finds it: a path from the
   * page's folder or the library's top, else the one file anywhere in the library with that name (the attachment
   * folder's first, then the shortest path). Hidden folders are not looked in. Null when there is none. */
  findFile(target: string, from: string | null): string | null {
    const name = decodeURIComponent(target.replace(/[#?].*$/, "")).replace(/^\/+/, "");
    if (!name || name.split("/").some((part) => !part || part === ".." || isHidden(part))) return null;
    const folder = from ? parentOf(from) : null;
    for (const base of [folder, null]) {
      const path = join(this.root, ...(base ? base.split("/") : []), ...name.split("/"));
      try { if (statSync(path).isFile()) return this.inside(path); } catch { /* not here */ }
    }
    if (name.includes("/")) return null;
    const lower = name.toLowerCase();
    const found: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 12) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (isHidden(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile() && entry.name.toLowerCase() === lower) found.push(full);
      }
    };
    walk(this.root, 0);
    if (!found.length) return null;
    const preferred = join(this.root, ...this.attachmentDir(from).split("/").filter(Boolean));
    found.sort((a, b) => Number(!a.startsWith(preferred)) - Number(!b.startsWith(preferred)) || a.length - b.length);
    return this.inside(found[0]);
  }

  /** Displaced versions older than `days` are removed (notes-two-layers.md §9 #3: 30 days). */
  pruneVersions(days = 30): void {
    const dir = join(this.root, VERSIONS_DIR);
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    const before = Date.now() - days * 86_400_000;
    for (const name of names) {
      const path = join(dir, name);
      try { if (statSync(path).mtimeMs < before) unlinkSync(path); } catch { /* gone already */ }
    }
  }
}

export type SaveResult =
  | { ok: true; fp: string }
  /** Not saved: the file is not the version the text was made from. `current` is what is on disk now (null: the page
   * is gone). When another app wrote in the very moment of the save, the new text did go in (`written`) and theirs
   * was kept aside at `kept`: putting theirs back is one more save. */
  | { ok: false; current: { text: string; fp: string; mtime: number } | null; written?: string; kept?: string };
