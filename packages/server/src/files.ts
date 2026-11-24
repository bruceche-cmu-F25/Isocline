/** The bytes of the files the user sends with a message (core files.ts keeps what each one is).
 *
 * A file arrives whole in one upload. What it is, is made out from its bytes, never from the name or type the device
 * gave: an image (PNG, JPEG, GIF, WebP), a PDF, or text (valid UTF-8 without control bytes). Anything else is refused.
 * It is written under its id in `<data>/files/`, readable by this user only. A PDF's text is read out once, here,
 * with `pdftotext` when this machine has it, into `<id>.txt`; without it, or for a scan, the file is kept and the
 * model is told there was nothing to read.
 *
 * Files never sent with a message are removed after a day.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, type ReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addFile, dropUnattachedFiles, fileName, newId, type Attachment, type FileInfo, type FileKind, type World } from "@isocline/core";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** A text file past this is not put into the message; the model reads it from disk when it wants to. */
export const INLINE_TEXT_BYTES = 60 * 1024;
const UNATTACHED_MS = 24 * 3600_000;
const PDF_TIMEOUT_MS = 30_000;

export class UploadError extends Error {
  override name = "UploadError";
  readonly code: "empty" | "too_big" | "unsupported";
  constructor(code: UploadError["code"], message: string) { super(message); this.code = code; }
}

/** What these bytes are, from the bytes. */
export function sniff(bytes: Uint8Array): { kind: FileKind; type: string } | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { kind: "image", type: "image/png" };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: "image", type: "image/jpeg" };
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { kind: "image", type: "image/gif" };
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { kind: "image", type: "image/webp" };
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return { kind: "pdf", type: "application/pdf" };
  // Text: it decodes as UTF-8 and has no control bytes but tab, newline, return and form feed.
  for (const byte of b.subarray(0, 64 * 1024)) if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) return null;
  try { new TextDecoder("utf-8", { fatal: true }).decode(b); } catch { return null; }
  return { kind: "text", type: "text/plain" };
}

/** A text file's own type, by what it is called; `text/plain` when the name says nothing. */
const TEXT_TYPES: Record<string, string> = { md: "text/markdown", json: "application/json", csv: "text/csv", tsv: "text/tab-separated-values", html: "text/html", xml: "application/xml", yaml: "application/yaml", yml: "application/yaml" };
const textType = (name: string) => TEXT_TYPES[name.split(".").at(-1)?.toLowerCase() ?? ""] ?? "text/plain";

function run(command: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: PDF_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve({ ok: !error, out: String(stdout) }));
  });
}

export interface FileStoreOptions {
  dataDir: string;
  world: World;
  log?: (message: string) => void;
  /** Reads a PDF's text into a file and says how many pages it has; the real one runs `pdftotext`. For tests. */
  readPdf?: (pdf: string, out: string) => Promise<{ pages?: number; readable: boolean }>;
}

export class FileStore {
  readonly dir: string;
  readonly #options: FileStoreOptions;
  #sweeper: NodeJS.Timeout;

  constructor(options: FileStoreOptions) {
    this.#options = options;
    this.dir = join(options.dataDir, "files");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.sweep();
    this.#sweeper = setInterval(() => this.sweep(), 3600_000);
    this.#sweeper.unref();
  }

  path(id: string): string { return join(this.dir, id); }

  /** Keeps one uploaded file and says what it is. */
  async save(input: { name: string; bytes: Uint8Array }): Promise<FileInfo> {
    const bytes = input.bytes;
    if (!bytes.length) throw new UploadError("empty", "The file is empty");
    if (bytes.length > MAX_FILE_BYTES) throw new UploadError("too_big", "A file can be 20 MB at most");
    const found = sniff(bytes);
    if (!found) throw new UploadError("unsupported", "Only images, PDFs and text files can be attached");
    const id = newId();
    const name = fileName(input.name);
    await writeFile(this.path(id), bytes, { mode: 0o600 });
    let extra: { pages?: number; readable?: boolean } = {};
    if (found.kind === "pdf") extra = await (this.#options.readPdf ?? pdfText)(this.path(id), `${this.path(id)}.txt`).catch(() => ({ readable: false }));
    try {
      return addFile(this.#options.world, {
        id, name, kind: found.kind, type: found.kind === "text" ? textType(name) : found.type, size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"), ...extra,
      });
    } catch (error) {
      this.#remove(id);
      throw error;
    }
  }

  read(id: string): Buffer { return readFileSync(this.path(id)); }

  /** The file to send as it is read, with its size; throws when its bytes are not there. */
  open(id: string): { size: number; stream(): ReadStream } {
    const path = this.path(id);
    return { size: statSync(path).size, stream: () => createReadStream(path) };
  }

  /** The files of a run as the engine takes them: an image by its path, a text file by its path (the engine puts a
   * small one into the message and reads a large one when it wants), a PDF by the text read out of it. */
  attach(files: readonly FileInfo[]): Attachment[] {
    return files.flatMap((file): Attachment[] => {
      const path = this.path(file.id);
      if (!existsSync(path)) return [];
      if (file.kind === "image") return [{ name: file.name, as: "image", type: file.type, size: file.size, path }];
      if (file.kind === "text") return [{ name: file.name, as: "text", type: file.type, size: file.size, path }];
      const pages = file.pages ? `${file.pages} page${file.pages === 1 ? "" : "s"}` : "";
      const text = `${path}.txt`;
      if (file.readable && existsSync(text)) return [{ name: file.name, as: "text", type: "text/plain", size: statSync(text).size, path: text, note: ["PDF", pages, "the text read out of it; layout, images and tables are not kept"].filter(Boolean).join(", ") }];
      return [{ name: file.name, as: "text", type: "text/plain", size: 0, note: ["PDF", pages, "no text could be read from it (a scan, or this machine has no PDF reader); you have not seen its contents, so say so"].filter(Boolean).join(", ") }];
    });
  }

  /** Forgets files uploaded more than a day ago and never sent. */
  sweep(now: number = Date.now()): number {
    try {
      const gone = dropUnattachedFiles(this.#options.world, now - UNATTACHED_MS);
      for (const id of gone) this.#remove(id);
      if (gone.length) this.#options.log?.(`files: removed ${gone.length} never sent`);
      return gone.length;
    } catch { return 0; }
  }

  #remove(id: string): void {
    for (const path of [this.path(id), `${this.path(id)}.txt`]) rmSync(path, { force: true });
  }

  close(): void { clearInterval(this.#sweeper); }
}

/** `pdftotext` (Poppler), when this machine has it. A PDF that yields next to no text counts as not readable. */
async function pdfText(pdf: string, out: string): Promise<{ pages?: number; readable: boolean }> {
  const info = await run("pdfinfo", [pdf]);
  const pages = Number(/^Pages:\s+(\d+)/m.exec(info.out)?.[1]) || undefined;
  const text = await run("pdftotext", ["-enc", "UTF-8", "-nopgbrk", pdf, out]);
  const readable = text.ok && existsSync(out) && readFileSync(out, "utf8").replace(/\s+/g, "").length >= 40;
  if (!readable) rmSync(out, { force: true });
  else chmodSync(out, 0o600);
  return { ...(pages ? { pages } : {}), readable };
}
