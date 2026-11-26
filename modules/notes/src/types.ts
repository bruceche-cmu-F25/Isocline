/** What a device sees of the notes. */

export interface NotePage {
  /** The page's path in the library without `.md`: `手冲/V60 参数`. */
  id: string;
  /** The file name: a page's title is its file name (notes.md 4.3). */
  title: string;
  parent: string | null;
  /** False for a folder with no page of its own. */
  file: boolean;
  /** In Zirma's layer (`zirma_notes/`). */
  zirma: boolean;
  /** A line icon's name (`cup`), from the page's properties. */
  icon: string | null;
  /** The page's first words. */
  first: string;
  mtime: number;
}

export interface NotesSnapshot {
  library: { id: string; root: string; error: string | null };
  pages: NotePage[];
}

export interface PageDetail extends NotePage {
  /** The library this was read from: a save names it, and is refused in another. */
  library: string;
  text: string;
  /** The text's fingerprint: the first save's `base`. Null for a page with nothing written. */
  fp: string | null;
  /** Pages that link here, Zirma's after the user's. */
  mentions: NotePage[];
}

export interface SearchHit { id: string; title: string; line: string }

export interface HistoryEntry {
  id: string;
  page: string;
  at: string;
  actor: "user" | "alfred";
  kind: "edit" | "create" | "rename" | "delete" | "links";
  summary: string;
  lines: Array<{ k: "add" | "del"; text: string }>;
  extra: Record<string, string>;
  undone: boolean;
  undoable: boolean;
}

/** The line icons a page can take, by name (notes-two-layers.md 4.2). */
export const PAGE_ICONS = [
  "doc", "book", "cup", "map", "calendar", "person", "star", "flag", "bulb", "leaf", "flask", "code", "home", "heart", "compass", "palette", "music", "chat",
] as const;
export type PageIcon = (typeof PAGE_ICONS)[number];

/** The operations a device may ask of the notes module (POST /api/ops/<name>). Saving a page's text is not one of
 * them: it is POST /api/notes/save. */
export const NOTE_OPS = ["note.create", "note.move", "note.delete", "note.discard", "note.icon", "note.undo", "note.library", "note.edit"] as const;
export type NoteOp = (typeof NOTE_OPS)[number];
export const NOTE_QUERIES = ["note.page", "note.search", "note.history"] as const;
