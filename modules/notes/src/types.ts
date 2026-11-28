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
  /** Where the user put it among the pages beside it (dragged in the tree); null when never placed: after those, by name. */
  rank?: number | null;
}

export interface NotesSnapshot {
  library: { id: string; root: string; error: string | null };
  pages: NotePage[];
  /** Zirma's suggestions waiting for the user, by page (notes-two-layers.md 4.5). */
  suggestions?: Array<{ id: string; page: string }>;
  /** Zirma's latest change to one of its pages, for "Zirma updated …" with Undo. */
  kept?: { page: string; entry: string; at: string } | null;
  /** Whether Zirma keeps its layer, when its daily pass is, and whether a pass is running now. */
  compile?: { enabled: boolean; daily: string; running: boolean };
}

/** What a device shows of a page of Zirma's: its lines with numbered sources, the source pages in order, when it was
 * brought up to date, and whether it was changed outside Zirma (then Zirma leaves it alone until the user decides). */
export interface KeptDetail {
  state: "ok" | "edited";
  updated: string | null;
  sections: Array<{ heading: string | null; lines: Array<{ index: number; text: string; refs: number[] }> }>;
  /** Numbered from 1 in the order they first appear. `page` is the user's page, when the source is one. */
  sources: Array<{ page: string | null; label: string }>;
}

/** One of Zirma's suggestions, waiting for the user's yes or no. */
export interface Suggestion {
  id: string;
  page: string;
  /** `edit`: change words in the page; `move`: put the page under another; `remember`: a fact about the user from
   * outside the notes, for the page about them. */
  kind: "edit" | "move" | "remember";
  find: string | null;
  replace: string | null;
  /** For a move: the page to go under; "" for the top. */
  under: string | null;
  reason: string;
  sources: Array<{ page: string | null; label: string }>;
  at: string;
}

export interface PageDetail extends NotePage {
  /** The library this was read from: a save names it, and is refused in another. */
  library: string;
  text: string;
  /** The text's fingerprint: the first save's `base`. Null for a page with nothing written. */
  fp: string | null;
  /** Pages that link here, Zirma's after the user's. */
  mentions: NotePage[];
  /** For a page of Zirma's: its lines and sources. */
  kept?: KeptDetail | null;
  /** Zirma's suggestions waiting on this page. */
  suggestions?: Suggestion[];
}

export interface SearchHit { id: string; title: string; line: string }

export interface HistoryEntry {
  id: string;
  page: string;
  at: string;
  actor: "user" | "alfred";
  kind: "edit" | "create" | "rename" | "delete" | "links" | "adopt";
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
export const NOTE_OPS = [
  "note.create", "note.move", "note.order", "note.delete", "note.discard", "note.icon", "note.undo", "note.library", "note.edit",
  "note.reject", "note.adopt", "note.return", "note.suggestion", "note.compile",
] as const;
export type NoteOp = (typeof NOTE_OPS)[number];
export const NOTE_QUERIES = ["note.page", "note.search", "note.history"] as const;
