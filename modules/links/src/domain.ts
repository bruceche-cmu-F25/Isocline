/** Link rules, shared by device commands, Zirma's tools and the page lookup (docs/design/links.md).
 *
 * Two kinds of thing live here. A place is an address the user keeps going to: a name and an address, in an order
 * the user chose. A clip is something they saved: it is told what it is from its address (url.ts), looked up on the
 * web for its title (fetch.ts, later), filed under at most one topic, and marked unread, seen or to do.
 * One address is one place and one clip at most.
 */
import { changedFields, isArea, newId, unknownArea, recordDomainEvent, type Migration, type World } from "@zirma/module-kit";
import { CLIP_STATES, type Clip, type ClipState, type Place, type PlaceFolder, type Topic } from "./types.ts";
import { classify, isShortener, nameFromUrl, normalizeUrl, parseShareText, tidyTitle } from "./url.ts";
import { COVER_MIGRATION } from "./covers.ts";
import { MAX_TOPIC_DEPTH, topicDepth, topicPath, topicTree, under } from "./tree.ts";
import { IMPORT_CHUNK, MAX_IMPORT, type ImportEntry } from "./bookmarks.ts";

export type LinkResult<T> = T | { error: string };
const failed = (result: object): result is { error: string } => "error" in result;

/** The places every world starts with. They are the user's from then on: renamed, moved or removed like any other. */
const DEFAULT_PLACES = [["Google", "https://www.google.com"], ["Gmail", "https://mail.google.com"], ["YouTube", "https://www.youtube.com"]];

export const MIGRATIONS: Migration[] = [{
  id: "link:1",
  sql: `
CREATE TABLE link_topics (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  area TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX link_topics_name ON link_topics(lower(name));
CREATE TABLE link_items (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  kind TEXT NOT NULL CHECK (kind IN ('place', 'clip')),
  url TEXT NOT NULL CHECK (length(url) BETWEEN 8 AND 2100),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  title_source TEXT NOT NULL DEFAULT 'url' CHECK (title_source IN ('given', 'page', 'url')),
  platform TEXT NOT NULL DEFAULT 'web',
  type TEXT NOT NULL DEFAULT 'article' CHECK (type IN ('video', 'article', 'post', 'repo', 'doc')),
  site TEXT NOT NULL DEFAULT '',
  author TEXT,
  description TEXT,
  note TEXT,
  topic_id TEXT REFERENCES link_topics(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'unread' CHECK (state IN ('unread', 'seen', 'todo')),
  position INTEGER NOT NULL DEFAULT 0,
  saved_at TEXT NOT NULL,
  fetch TEXT NOT NULL DEFAULT 'done' CHECK (fetch IN ('pending', 'done', 'failed')),
  fetch_error TEXT,
  fetch_tries INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE UNIQUE INDEX link_items_url ON link_items(kind, url);
CREATE INDEX link_items_saved ON link_items(kind, saved_at);

${DEFAULT_PLACES.map(([title, url], index) => `INSERT INTO link_items (id, kind, url, title, title_source, position, saved_at) VALUES ('place-${index + 1}', 'place', '${url}', '${title}', 'given', ${index}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));`).join("\n")}
`,
}, {
  // A site's own icon, kept once per host and shown from here (a device never asks the site for it). A row without
  // bytes says the site was asked and had none, so it is not asked again for a while.
  id: "link:2",
  sql: `
CREATE TABLE link_icons (
  host TEXT PRIMARY KEY NOT NULL CHECK (length(host) BETWEEN 1 AND 255),
  type TEXT,
  bytes BLOB,
  checked_at TEXT NOT NULL
) STRICT;
`,
}, {
  id: "link:3",
  sql: `
CREATE TABLE link_folders (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 60),
  position INTEGER NOT NULL
) STRICT;
ALTER TABLE link_items ADD COLUMN folder_id TEXT REFERENCES link_folders(id) CHECK (folder_id IS NULL OR kind = 'place');
CREATE INDEX link_places_folder ON link_items(folder_id, position) WHERE kind = 'place';
CREATE VIEW link_place_tiles AS
  SELECT id, title, position, folder_id, 0 AS is_folder FROM link_items WHERE kind = 'place'
  UNION ALL
  SELECT id, title, position, NULL, 1 FROM link_folders;
`,
}, COVER_MIGRATION, {
  id: "link:5",
  sql: `
ALTER TABLE link_items ADD COLUMN shared_title TEXT CHECK (length(shared_title) BETWEEN 1 AND 300);
UPDATE link_items SET fetch = 'pending', fetch_tries = 0, fetch_error = NULL
  WHERE kind = 'clip' AND platform IN ('bilibili', 'xiaohongshu') AND title_source = 'url';
UPDATE link_covers SET checked_at = 0 WHERE bytes IS NULL AND clip_id IN
  (SELECT id FROM link_items WHERE kind = 'clip' AND platform = 'bilibili' AND type = 'video');
`,
  apply(db) {
    // Older clients saved every word around a URL as a note. Only split recognizable platform signatures.
    const rows = db.prepare("SELECT id, url, title, title_source, note FROM link_items WHERE kind = 'clip' AND platform IN ('bilibili', 'xiaohongshu')").all();
    const repair = db.prepare("UPDATE link_items SET title = ?, shared_title = ?, note = ? WHERE id = ?");
    for (const row of rows) {
      const url = row.url as string;
      const share = parseShareText(url, (row.note as string | null) ?? "");
      const title = row.title_source === "url" ? nameFromUrl(url) : row.title as string;
      if (share.title || title !== row.title) repair.run(title, share.title ?? null, share.note ?? null, row.id);
    }
  },
}, {
  // Xiaohongshu notes are now read as a phone reads them, which also says whether a note is a video: every saved
  // note is looked up again (a title the user gave stays).
  id: "link:6",
  sql: `UPDATE link_items SET fetch = 'pending', fetch_tries = 0, fetch_error = NULL
  WHERE kind = 'clip' AND platform = 'xiaohongshu' AND fetch != 'pending';`,
}, {
  // Categories become a tree (links.md §4.10): a topic may sit under another, and names are unique among siblings
  // only. A site no longer has to be pinned: it can live in the tree alone. An import is kept so it can be undone.
  id: "link:7",
  sql: `
ALTER TABLE link_topics ADD COLUMN parent_id TEXT REFERENCES link_topics(id);
DROP INDEX link_topics_name;
CREATE UNIQUE INDEX link_topics_name ON link_topics(coalesce(parent_id, 'area:' || coalesce(area, '')), lower(name));
CREATE INDEX link_topics_parent ON link_topics(parent_id);
ALTER TABLE link_items ADD COLUMN pinned INTEGER NOT NULL DEFAULT 1 CHECK (pinned IN (0, 1));
CREATE INDEX link_items_topic ON link_items(topic_id);
DROP VIEW link_place_tiles;
CREATE VIEW link_place_tiles AS
  SELECT id, title, position, folder_id, 0 AS is_folder FROM link_items WHERE kind = 'place' AND pinned = 1
  UNION ALL
  SELECT id, title, position, NULL, 1 FROM link_folders;
CREATE TABLE link_imports (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  at TEXT NOT NULL,
  item_ids TEXT NOT NULL DEFAULT '[]',
  topic_ids TEXT NOT NULL DEFAULT '[]'
) STRICT;
`,
}, {
  // Titles lose what only repeats where they are ("GitHub - owner/repo: …", "… - YouTube"): every title a page gave,
  // and sites' (none of which a page named, but bookmarks bring the page's title in). A title the user gave a clip stays.
  id: "link:8",
  sql: "",
  apply(db) {
    const rows = db.prepare("SELECT id, url, title, description FROM link_items WHERE title_source = 'page' OR kind = 'place'").all();
    const write = db.prepare("UPDATE link_items SET title = ?, description = COALESCE(description, ?) WHERE id = ?");
    for (const row of rows) {
      const tidy = tidyTitle(row.title as string, row.url as string);
      if (tidy.title !== row.title) write.run(tidy.title.slice(0, 300), tidy.description?.slice(0, 600) ?? null, row.id as string);
    }
  },
}];

const text = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** The host an item's icon is kept under. */
export const hostOf = (url: string) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } };

function toPlace(row: Record<string, unknown>): Place {
  return {
    id: row.id as string, title: row.title as string, url: row.url as string, position: row.position as number,
    ...(row.folder_id ? { folderId: row.folder_id as string } : {}),
    ...(row.topic_id ? { topicId: row.topic_id as string } : {}),
    ...(row.pinned === 0 ? { unpinned: true as const } : {}),
    ...(row.has_icon ? { icon: hostOf(row.url as string) } : {}),
  };
}
function clipTitle(row: Record<string, unknown>): Pick<Clip, "title" | "titleSource"> {
  return row.title_source === "url" && row.shared_title
    ? { title: row.shared_title as string, titleSource: "share" }
    : { title: row.title as string, titleSource: row.title_source as Clip["titleSource"] };
}
function toClip(row: Record<string, unknown>): Clip {
  return {
    id: row.id as string, url: row.url as string, ...clipTitle(row),
    platform: row.platform as string, type: row.type as Clip["type"], site: row.site as string,
    ...(row.author ? { author: row.author as string } : {}), ...(row.description ? { description: row.description as string } : {}),
    ...(row.note ? { note: row.note as string } : {}), ...(row.topic_id ? { topicId: row.topic_id as string } : {}),
    ...(row.duration_seconds ? { durationSeconds: row.duration_seconds as number } : {}),
    ...(row.has_cover ? { cover: `cover_${row.id}` } : {}),
    state: row.state as ClipState, savedAt: row.saved_at as string, fetch: row.fetch as Clip["fetch"],
    ...(row.fetch_error ? { fetchError: row.fetch_error as string } : {}),
    ...(row.has_icon ? { icon: hostOf(row.url as string) } : {}),
  };
}

/** Every item with whether its site's icon is kept. SQLite has no function for a URL's host, so hosts are matched
 * here: there are few of them. */
function withIcons(world: World, rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const kept = new Set(world.db.prepare("SELECT host FROM link_icons WHERE bytes IS NOT NULL").all().map((row) => row.host as string));
  return rows.map((row) => ({ ...row, has_icon: kept.has(hostOf(row.url as string)) }));
}

export function listPlaces(world: World): Place[] {
  return withIcons(world, world.db.prepare("SELECT * FROM link_items WHERE kind = 'place' ORDER BY position, rowid").all()).map(toPlace);
}

export function listFolders(world: World): PlaceFolder[] {
  return world.db.prepare("SELECT id, title, position FROM link_folders ORDER BY position, rowid").all().map(toFolder);
}

function toFolder(row: Record<string, unknown>): PlaceFolder {
  return { id: row.id as string, title: row.title as string, position: row.position as number };
}
/** Newest first. */
export function listClips(world: World, options: { limit?: number } = {}): Clip[] {
  return withIcons(world, world.db.prepare(`SELECT i.*, c.bytes IS NOT NULL AS has_cover, c.duration_seconds
    FROM link_items i LEFT JOIN link_covers c ON c.clip_id = i.id WHERE kind = 'clip' ORDER BY saved_at DESC, i.rowid DESC LIMIT ?`).all(Math.min(options.limit ?? 2000, 5000))).map(toClip);
}
export function listTopics(world: World): Topic[] {
  return world.db.prepare("SELECT * FROM link_topics ORDER BY created_at, rowid").all().map(toTopic);
}
function toTopic(row: Record<string, unknown>): Topic {
  return { id: row.id as string, name: row.name as string, ...(row.area ? { area: row.area as string } : {}), ...(row.parent_id ? { parentId: row.parent_id as string } : {}) };
}

function row(world: World, id: string, kind: "place" | "clip"): Record<string, unknown> | undefined {
  return world.db.prepare("SELECT * FROM link_items WHERE id = ? AND kind = ?").get(id, kind);
}
const said = (kind: string, id: string, payload: Record<string, unknown>) => ({ kind: `link.${kind}`, subject: `link:${id}`, payload });

// ---- topics: a tree under the areas (links.md §4.10.1) ------------------------------------------------------

const DEPTH_ERROR = `Categories go at most ${MAX_TOPIC_DEPTH} levels deep under an area.`;

function topicRow(world: World, id: string): Record<string, unknown> | undefined {
  return world.db.prepare("SELECT * FROM link_topics WHERE id = ?").get(id);
}
/** The topic of that name among one node's children: a topic's, or an area's top level. */
function sibling(world: World, name: string, parentId: string | null, area: string | null): Record<string, unknown> | undefined {
  return world.db.prepare("SELECT * FROM link_topics WHERE coalesce(parent_id, 'area:' || coalesce(area, '')) = ? AND lower(name) = lower(?)")
    .get(parentId ?? `area:${area ?? ""}`, name);
}
const currentTree = (world: World) => topicTree(listTopics(world));

/** The topic of that name, made if there is none. With `parentId` it is looked for (and made) under that topic;
 * with `area`, at the top of that area; with neither, anywhere (an older device names a topic by name alone). */
export function ensureTopic(world: World, input: { name: string; area?: string; parentId?: string }): LinkResult<Topic> {
  const name = text(input.name, 60);
  if (!name) return { error: "A topic needs a name." };
  return world.tx((db) => {
    let area = input.area?.trim() || null;
    const parentId = input.parentId?.trim() || null;
    if (parentId) {
      const parent = topicRow(world, parentId);
      if (!parent) return { error: "No such topic to put it under." };
      const found = sibling(world, name, parentId, null);
      if (found) return toTopic(found);
      if (topicDepth(currentTree(world), parentId) >= MAX_TOPIC_DEPTH) return { error: DEPTH_ERROR };
      area = parent.area as string | null;
    } else {
      if (area && !isArea(world, area)) return { error: unknownArea(world) };
      // With no area named, a topic of that name anywhere will do; with one, only its top level.
      const found = sibling(world, name, null, area)
        ?? (area ? undefined : db.prepare("SELECT * FROM link_topics WHERE lower(name) = lower(?) ORDER BY parent_id IS NOT NULL, created_at LIMIT 1").get(name));
      if (found) return toTopic(found);
    }
    const id = newId();
    db.prepare("INSERT INTO link_topics (id, name, area, parent_id, created_at) VALUES (?, ?, ?, ?, ?)").run(id, name, area, parentId, new Date().toISOString());
    recordDomainEvent(world, { kind: "link.topic_added", subject: `link-topic:${id}`, payload: { name, ...(area ? { area } : {}), ...(parentId ? { parentId } : {}) } });
    return toTopic(topicRow(world, id)!);
  });
}

/** Renames a topic, moves it to another area, or puts it under another topic (`parentId`; empty puts it back at the
 * top of its area). What is under it moves with it. */
export function updateTopic(world: World, id: string, patch: { name?: string; area?: string; parentId?: string }): LinkResult<Topic> {
  return world.tx((db) => {
    const found = topicRow(world, id);
    if (!found) return { error: "No such topic." };
    const name = patch.name === undefined ? found.name as string : text(patch.name, 60);
    if (!name) return { error: "A topic needs a name." };
    let parentId = found.parent_id as string | null;
    let area = found.area as string | null;
    const tree = currentTree(world);
    if (patch.parentId !== undefined) parentId = patch.parentId.trim() || null;
    if (parentId) {
      const parent = topicRow(world, parentId);
      if (!parent) return { error: "No such topic to put it under." };
      if (under(tree, id).has(parentId)) return { error: "A topic cannot go under itself." };
      const height = (tree.children.get(id)?.length ? 1 : 0) + 1;
      if (topicDepth(tree, parentId) + height > MAX_TOPIC_DEPTH) return { error: DEPTH_ERROR };
      area = parent.area as string | null;
    } else if (patch.area !== undefined) {
      area = patch.area.trim() || null;
      if (area && area !== found.area && !isArea(world, area)) return { error: unknownArea(world) };
    }
    const taken = sibling(world, name, parentId, area);
    if (taken && taken.id !== id) return { error: `There is already a category named "${name}" there.` };
    if (name !== found.name || area !== found.area || parentId !== found.parent_id) {
      db.prepare("UPDATE link_topics SET name = ?, area = ?, parent_id = ? WHERE id = ?").run(name, area, parentId, id);
      if (area !== found.area) {
        const below = [...under(tree, id)].filter((topic) => topic !== id);
        const move = db.prepare("UPDATE link_topics SET area = ? WHERE id = ?");
        for (const topic of below) move.run(area, topic);
      }
      recordDomainEvent(world, { kind: "link.topic_changed", subject: `link-topic:${id}`, payload: { name, area, parentId, was: found.name as string } });
    }
    return toTopic(topicRow(world, id)!);
  });
}

/** Removes a topic and nothing else: what was filed under it, and the topics under it, move up one level (a link
 * at the top of an area is unfiled). A topic that meets one of the same name up there joins it. */
export function removeTopic(world: World, id: string): LinkResult<{ name: string; moved: number }> {
  return world.tx((db) => {
    const found = topicRow(world, id);
    if (!found) return { error: "No such topic." };
    const up = found.parent_id as string | null;
    const moved = Number(db.prepare("UPDATE link_items SET topic_id = ? WHERE topic_id = ?").run(up, id).changes);
    for (const child of db.prepare("SELECT * FROM link_topics WHERE parent_id = ?").all(id)) {
      const meets = sibling(world, child.name as string, up, found.area as string | null);
      if (meets && meets.id !== child.id) {
        db.prepare("UPDATE link_items SET topic_id = ? WHERE topic_id = ?").run(meets.id as string, child.id as string);
        db.prepare("UPDATE link_topics SET parent_id = ? WHERE parent_id = ?").run(meets.id as string, child.id as string);
        db.prepare("DELETE FROM link_topics WHERE id = ?").run(child.id as string);
      } else db.prepare("UPDATE link_topics SET parent_id = ? WHERE id = ?").run(up, child.id as string);
    }
    db.prepare("DELETE FROM link_topics WHERE id = ?").run(id);
    recordDomainEvent(world, { kind: "link.topic_removed", subject: `link-topic:${id}`, payload: { name: found.name as string, moved } });
    return { name: found.name as string, moved };
  });
}

/** Two topics become one: everything filed under `id`, and under the topics below it, goes to `into`, and `id` and
 * the topics below it are gone. */
export function mergeTopic(world: World, id: string, into: string): LinkResult<{ name: string; into: string; moved: number }> {
  return world.tx((db) => {
    const from = topicRow(world, id), target = topicRow(world, into);
    if (!from || !target) return { error: "No such topic." };
    const gone = under(currentTree(world), id);
    if (gone.has(into)) return { error: "A topic cannot be merged into one under it." };
    const move = db.prepare("UPDATE link_items SET topic_id = ? WHERE topic_id = ?");
    let moved = 0;
    for (const topic of gone) moved += Number(move.run(into, topic).changes);
    const drop = db.prepare("DELETE FROM link_topics WHERE id = ?");
    for (const topic of [...gone].reverse()) drop.run(topic);
    recordDomainEvent(world, { kind: "link.topic_merged", subject: `link-topic:${id}`, payload: { name: from.name as string, into: target.name as string, intoId: into, moved } });
    return { name: from.name as string, into: target.name as string, moved };
  });
}

// ---- places ------------------------------------------------------------------------------------------------

/** Pins an address to the places (or answers the one already there). */
export function pinPlace(world: World, input: { url: string; title?: string }): LinkResult<{ place: Place; existing: boolean }> {
  let url: string;
  try { url = normalizeUrl(input.url); } catch (error) { return { error: (error as Error).message }; }
  return world.tx((db) => {
    const found = db.prepare("SELECT * FROM link_items WHERE kind = 'place' AND url = ?").get(url);
    if (found && found.pinned === 0) {
      const id = found.id as string;
      db.prepare("UPDATE link_items SET pinned = 1, position = ? WHERE id = ?").run(nextTile(world), id);
      recordDomainEvent(world, said("pinned", id, { title: found.title as string, url }));
      return { place: toPlace(row(world, id, "place")!), existing: false };
    }
    if (found) return { place: toPlace(found), existing: true };
    const id = newId();
    const title = text(input.title, 60) || siteName(url);
    db.prepare("INSERT INTO link_items (id, kind, url, title, title_source, position, saved_at) VALUES (?, 'place', ?, ?, 'given', ?, ?)").run(id, url, title, nextTile(world), new Date().toISOString());
    recordDomainEvent(world, said("pinned", id, { title, url }));
    return { place: toPlace(row(world, id, "place")!), existing: false };
  });
}

/** The position after the last tile in the top row. */
function nextTile(world: World): number {
  return world.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM link_place_tiles WHERE folder_id IS NULL").get()!.next as number;
}

/** Files a site under a topic (empty: unfiled), or pins it to the top row or takes it off (it stays in the tree). */
export function updatePlace(world: World, id: string, patch: { topicId?: string; pinned?: boolean }): LinkResult<Place> {
  return world.tx((db) => {
    const found = row(world, id, "place");
    if (!found) return { error: "No such place." };
    let topicId = found.topic_id as string | null;
    if (patch.topicId !== undefined) {
      if (patch.topicId && !topicRow(world, patch.topicId)) return { error: "No such topic." };
      topicId = patch.topicId || null;
    }
    if (topicId !== found.topic_id) {
      db.prepare("UPDATE link_items SET topic_id = ? WHERE id = ?").run(topicId, id);
      recordDomainEvent(world, said("changed", id, { title: found.title as string, changes: ["topicId"] }));
    }
    if (patch.pinned !== undefined && patch.pinned !== (found.pinned === 1)) {
      if (patch.pinned) db.prepare("UPDATE link_items SET pinned = 1, position = ? WHERE id = ?").run(nextTile(world), id);
      else {
        db.prepare("UPDATE link_items SET pinned = 0, folder_id = NULL WHERE id = ?").run(id);
        if (found.folder_id) removeEmptyFolder(world, found.folder_id as string);
        writeOrder(world, siblings(world));
      }
      recordDomainEvent(world, said(patch.pinned ? "pinned" : "unpinned", id, { title: found.title as string }));
    }
    return toPlace(withIcons(world, [row(world, id, "place")!])[0]);
  });
}

/** A short name for a site from its address: "mail.google.com" → "Mail.google", "github.com" → "Github". */
function siteName(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, "").split(".").slice(0, -1).join(".") || new URL(url).hostname;
  return (host.charAt(0).toUpperCase() + host.slice(1)).slice(0, 60);
}

export function renamePlace(world: World, id: string, title: string): LinkResult<Place | PlaceFolder> {
  const name = text(title, 60);
  if (!name) return { error: "A place needs a name." };
  return world.tx((db) => {
    const found = row(world, id, "place");
    if (!found) {
      const folder = db.prepare("SELECT * FROM link_folders WHERE id = ?").get(id);
      if (!folder) return { error: "No such place." };
      if (folder.title !== name) {
        db.prepare("UPDATE link_folders SET title = ? WHERE id = ?").run(name, id);
        recordDomainEvent(world, said("renamed", id, { title: name, was: folder.title as string }));
      }
      return toFolder({ ...folder, title: name });
    }
    if (found.title !== name) {
      db.prepare("UPDATE link_items SET title = ? WHERE id = ?").run(name, id);
      recordDomainEvent(world, said("renamed", id, { title: name, was: found.title as string }));
    }
    return toPlace({ ...found, title: name });
  });
}

/** Ordered peers in the same grid. Folders and top-level sites share positions. */
function siblings(world: World, folderId?: string) {
  return world.db.prepare("SELECT id, is_folder FROM link_place_tiles WHERE folder_id IS ? ORDER BY position, id").all(folderId ?? null)
    .map((tile) => ({ id: tile.id as string, isFolder: !!tile.is_folder }));
}

function writeOrder(world: World, tiles: ReturnType<typeof siblings>) {
  const place = world.db.prepare("UPDATE link_items SET position = ? WHERE id = ? AND position != ?");
  const folder = world.db.prepare("UPDATE link_folders SET position = ? WHERE id = ? AND position != ?");
  tiles.forEach((tile, i) => (tile.isFolder ? folder : place).run(i, tile.id, i));
}

function removeEmptyFolder(world: World, folderId: string) {
  world.db.prepare("DELETE FROM link_folders WHERE id = ? AND NOT EXISTS (SELECT 1 FROM link_items WHERE folder_id = ?)").run(folderId, folderId);
}

/** Replace a folder in the top-level row with its sites in their displayed order. */
export function ungroupPlaces(world: World, id: string): LinkResult<{ id: string }> {
  return world.tx((db) => {
    const root = siblings(world);
    const index = root.findIndex((entry) => entry.id === id && entry.isFolder);
    if (index < 0) return { error: "No such folder." };
    const members = siblings(world, id);
    db.prepare("UPDATE link_items SET folder_id = NULL WHERE folder_id = ?").run(id);
    db.prepare("DELETE FROM link_folders WHERE id = ?").run(id);
    root.splice(index, 1, ...members);
    writeOrder(world, root);
    recordDomainEvent(world, said("ungrouped", id, { placeIds: members.map((entry) => entry.id) }));
    return { id };
  });
}

/** Two sites become a folder in the target site's top-level position. */
export function groupPlaces(world: World, input: { id: string; targetId: string; title: string }): LinkResult<{ folder: PlaceFolder }> {
  const title = text(input.title, 60);
  if (!title) return { error: "A folder needs a name." };
  if (input.id === input.targetId) return { error: "Choose two different places." };
  return world.tx((db) => {
    const source = row(world, input.id, "place"), target = row(world, input.targetId, "place");
    if (!source || !target) return { error: "No such place." };
    if (target.folder_id !== null) {
      if (source.folder_id === target.folder_id) {
        return { folder: toFolder(db.prepare("SELECT * FROM link_folders WHERE id = ?").get(target.folder_id as string)!) };
      }
      return { error: "The target place is already in a folder." };
    }
    const folder = { id: newId(), title, position: target.position as number };
    db.prepare("INSERT INTO link_folders (id, title, position) VALUES (?, ?, ?)").run(folder.id, title, folder.position);
    const move = db.prepare("UPDATE link_items SET folder_id = ?, position = ? WHERE id = ?");
    move.run(folder.id, 0, input.targetId);
    move.run(folder.id, 1, input.id);
    if (source.folder_id) removeEmptyFolder(world, source.folder_id as string);
    recordDomainEvent(world, said("grouped", folder.id, { title, placeIds: [input.targetId, input.id] }));
    return { folder };
  });
}

/** Move to a folder or the top-level grid. A missing neighbour means append. */
export function movePlace(world: World, input: { id: string; folderId?: string; beforeId?: string }): LinkResult<{ id: string }> {
  return world.tx((db) => {
    const tile = db.prepare("SELECT * FROM link_place_tiles WHERE id = ?").get(input.id);
    if (!tile) return { error: "No such place or folder." };
    if (input.folderId !== undefined) {
      if (tile.is_folder) return { error: "Folders can only be moved in Places." };
      if (!db.prepare("SELECT 1 FROM link_folders WHERE id = ?").get(input.folderId)) return { error: "No such folder." };
    }
    const peers = siblings(world, input.folderId);
    if (input.beforeId !== undefined && !peers.some((peer) => peer.id === input.beforeId)) return { error: "The target is no longer in this grid." };
    if (input.id === input.beforeId) return { id: input.id };
    const next = peers.filter((peer) => peer.id !== input.id);
    const index = input.beforeId === undefined ? next.length : next.findIndex((peer) => peer.id === input.beforeId);
    next.splice(index, 0, { id: input.id, isFolder: !!tile.is_folder });
    if (next.length === peers.length && next.every((peer, i) => peer.id === peers[i].id)) return { id: input.id };
    if (tile.folder_id !== (input.folderId ?? null)) {
      db.prepare("UPDATE link_items SET folder_id = ? WHERE id = ?").run(input.folderId ?? null, input.id);
      if (tile.folder_id) removeEmptyFolder(world, tile.folder_id as string);
    }
    writeOrder(world, next);
    recordDomainEvent(world, said("moved", input.id, { folderId: input.folderId ?? null, beforeId: input.beforeId ?? null }));
    return { id: input.id };
  });
}

/** Older clients reorder top-level sites. Their ordering leaves folders and folder contents in place. */
export function orderPlaces(world: World, ids: readonly string[]): Place[] {
  return world.tx(() => {
    const current = siblings(world);
    const sites = current.filter((tile) => !tile.isFolder).map((tile) => tile.id);
    const ordered = [...new Set(ids.filter((id) => sites.includes(id))), ...sites.filter((id) => !ids.includes(id))];
    if (ordered.some((id, i) => id !== sites[i])) {
      let index = 0;
      const next = current.map((tile) => tile.isFolder ? tile : { ...tile, id: ordered[index++] });
      writeOrder(world, next);
      recordDomainEvent(world, { kind: "link.places_ordered", subject: "link:places", payload: { count: next.length } });
    }
    return listPlaces(world);
  });
}

// ---- clips -------------------------------------------------------------------------------------------------

export interface SaveInput {
  url: string;
  /** A title the user or Zirma already knows; the page's own is looked up otherwise. */
  title?: string;
  /** From a platform's clipboard share. A subsequently fetched page title takes priority. */
  sharedTitle?: string;
  note?: string;
  /** An existing topic's id, or a topic's name (made if new). */
  topicId?: string;
  topic?: string;
  /** For a new topic: the area it sits in. */
  area?: string;
  /** For a new topic: the topic it goes under. */
  parentId?: string;
}

/** Saves an address as a clip. The same address again is the same clip: nothing is added, but a note or a topic
 * given this time is put on it if it had none. The page is looked up afterwards (`fetch: pending`). */
export function saveClip(world: World, input: SaveInput): LinkResult<{ clip: Clip; existing: boolean }> {
  let url: string;
  try { url = normalizeUrl(input.url); } catch (error) { return { error: (error as Error).message }; }
  return world.tx((db) => {
    let topicId: string | null = null;
    if (input.topicId) {
      if (!db.prepare("SELECT 1 FROM link_topics WHERE id = ?").get(input.topicId)) return { error: "No such topic." };
      topicId = input.topicId;
    } else if (input.topic?.trim()) {
      const topic = ensureTopic(world, { name: input.topic, area: input.area, parentId: input.parentId });
      if (failed(topic)) return topic;
      topicId = topic.id;
    }
    const { platform, type, host } = classify(url);
    // A cached client still submits the whole share caption as a note. Apply the same signature rule there.
    const share = input.sharedTitle ? { title: input.sharedTitle, note: input.note } : parseShareText(url, input.note ?? "");
    const sharedTitle = platform === "bilibili" || platform === "xiaohongshu" ? text(share.title, 300) || null : null;
    const given = text(input.title, 300) || null;
    const note = text(share.note, 500) || null;
    const found = db.prepare("SELECT * FROM link_items WHERE kind = 'clip' AND url = ?").get(url);
    if (found) {
      const before = toClip(found);
      db.prepare(`UPDATE link_items SET note = COALESCE(note, ?), topic_id = COALESCE(topic_id, ?),
        shared_title = COALESCE(shared_title, ?),
        title = CASE WHEN title_source = 'url' AND ? IS NOT NULL THEN ? ELSE title END,
        title_source = CASE WHEN title_source = 'url' AND ? IS NOT NULL THEN 'given' ELSE title_source END WHERE id = ?`)
        .run(note, topicId, sharedTitle, given, given, given, found.id as string);
      const after = toClip(row(world, found.id as string, "clip")!);
      const changes = changedFields(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>);
      if (changes) recordDomainEvent(world, said("changed", after.id, { title: after.title, changes }));
      return { clip: after, existing: true };
    }
    const id = newId();
    db.prepare(`INSERT INTO link_items (id, kind, url, title, title_source, shared_title, platform, type, site, note, topic_id, state, saved_at, fetch)
      VALUES (?, 'clip', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?, 'pending')`)
      .run(id, url, given || nameFromUrl(url), given ? "given" : "url", sharedTitle, platform, type, host, note, topicId, new Date().toISOString());
    const clip = toClip(row(world, id, "clip")!);
    recordDomainEvent(world, said("saved", id, { title: clip.title, url, type, platform }));
    return { clip, existing: false };
  });
}

export interface ClipPatch {
  title?: string;
  /** Empty clears it. */
  note?: string;
  /** A topic's id; empty unfiles it. */
  topicId?: string;
  /** A topic's name, made if new (with `area`). */
  topic?: string;
  area?: string;
  parentId?: string;
  state?: ClipState;
}

export function updateClip(world: World, id: string, patch: ClipPatch): LinkResult<Clip> {
  return world.tx((db) => {
    const found = row(world, id, "clip");
    if (!found) return { error: `No saved link with id "${id}".` };
    const before = toClip(found);
    if (patch.state !== undefined && !CLIP_STATES.includes(patch.state)) return { error: `state must be one of: ${CLIP_STATES.join(", ")}` };
    let topicId = found.topic_id as string | null;
    if (patch.topicId !== undefined) {
      if (patch.topicId && !db.prepare("SELECT 1 FROM link_topics WHERE id = ?").get(patch.topicId)) return { error: "No such topic." };
      topicId = patch.topicId || null;
    } else if (patch.topic !== undefined) {
      if (!patch.topic.trim()) topicId = null;
      else {
        const topic = ensureTopic(world, { name: patch.topic, area: patch.area, parentId: patch.parentId });
        if (failed(topic)) return topic;
        topicId = topic.id;
      }
    }
    const title = patch.title === undefined ? null : text(patch.title, 300);
    if (patch.title !== undefined && !title) return { error: "A title cannot be empty." };
    db.prepare(`UPDATE link_items SET title = COALESCE(?, title), title_source = CASE WHEN ? IS NULL THEN title_source ELSE 'given' END,
      note = CASE WHEN ? = 1 THEN ? ELSE note END, topic_id = ?, state = COALESCE(?, state) WHERE id = ?`)
      .run(title, title, patch.note === undefined ? 0 : 1, patch.note === undefined ? null : text(patch.note, 500) || null, topicId, patch.state ?? null, id);
    const after = toClip(row(world, id, "clip")!);
    const changes = changedFields(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>);
    if (changes) recordDomainEvent(world, said("changed", id, { title: after.title, changes }));
    return after;
  });
}

/** Removes a place or a clip for good. */
export function removeLink(world: World, id: string): LinkResult<{ title: string; kind: "place" | "clip" }> {
  return world.tx((db) => {
    const found = db.prepare("SELECT kind, title, title_source, shared_title, url, folder_id FROM link_items WHERE id = ?").get(id);
    if (!found) return { error: `No link with id "${id}".` };
    db.prepare("DELETE FROM link_items WHERE id = ?").run(id);
    if (found.folder_id) removeEmptyFolder(world, found.folder_id as string);
    const { title } = clipTitle(found);
    recordDomainEvent(world, said("removed", id, { title, url: found.url as string, kind: found.kind as string }));
    return { title, kind: found.kind as "place" | "clip" };
  });
}

/** Asks for a clip's page to be looked up again. */
export function refetchClip(world: World, id: string): LinkResult<Clip> {
  return world.tx((db) => {
    if (!row(world, id, "clip")) return { error: `No saved link with id "${id}".` };
    db.prepare("UPDATE link_items SET fetch = 'pending', fetch_error = NULL, fetch_tries = 0 WHERE id = ?").run(id);
    recordDomainEvent(world, said("refetch", id, {}));
    return toClip(row(world, id, "clip")!);
  });
}

// ---- looking pages up ---------------------------------------------------------------------------------------

/** Clips whose page has not been looked up yet, oldest first. */
export function pendingClips(world: World, limit = 10): Clip[] {
  return world.db.prepare("SELECT * FROM link_items WHERE kind = 'clip' AND fetch = 'pending' ORDER BY saved_at, rowid LIMIT ?").all(limit).map(toClip);
}

/** What the page said about itself. A title the user or Zirma gave stays; an address that only stood for another
 * (a share link) becomes the page it led to, unless that page is already saved. */
export function recordPage(world: World, id: string, given: { url?: string; title?: string; site?: string; author?: string; description?: string; video?: boolean }): void {
  let page = given;
  world.tx((db) => {
    const found = row(world, id, "clip");
    if (!found) return;
    let url = found.url as string, platform = found.platform as string, type = found.type as string, site = found.site as string;
    if (page.url && isShortener(url)) {
      try {
        const landed = normalizeUrl(page.url);
        if (!db.prepare("SELECT 1 FROM link_items WHERE kind = 'clip' AND url = ? AND id != ?").get(landed, id)) {
          url = landed;
          ({ platform, type, host: site } = classify(landed));
        }
      } catch { /* keep the address as saved */ }
    }
    // A Xiaohongshu note is a video or pictures, and only its page tells which.
    if (platform === "xiaohongshu") type = page.video ? "video" : "post";
    const takeTitle = found.title_source !== "given" && !!page.title;
    const tidy = page.title ? tidyTitle(page.title, url) : undefined;
    const title = takeTitle ? tidy!.title : found.title_source === "url" ? nameFromUrl(url) : found.title as string;
    page = { ...page, description: page.description || tidy?.description };
    db.prepare(`UPDATE link_items SET url = ?, platform = ?, type = ?, site = ?, title = ?, title_source = ?, author = ?, description = ?,
      fetch = 'done', fetch_error = NULL WHERE id = ?`)
      .run(url, platform, type, text(page.site, 80) || site, title.slice(0, 300), takeTitle ? "page" : found.title_source as string,
        text(page.author, 120) || null, text(page.description, 600) || null, id);
    const displayTitle = !takeTitle && found.title_source === "url" ? found.shared_title as string || title : title;
    recordDomainEvent(world, said("fetched", id, { title: displayTitle.slice(0, 200), found: !!page.title }));
  });
}

/** The page could not be looked up. `again`: worth another try later (the network, a timeout), up to three tries. */
export function recordPageFailure(world: World, id: string, error: string, again: boolean): void {
  world.tx((db) => {
    const found = row(world, id, "clip");
    if (!found) return;
    const tries = (found.fetch_tries as number) + 1;
    const giveUp = !again || tries >= 3;
    db.prepare("UPDATE link_items SET fetch = ?, fetch_error = ?, fetch_tries = ? WHERE id = ?").run(giveUp ? "failed" : "pending", error.slice(0, 200), tries, id);
    if (giveUp) recordDomainEvent(world, said("fetch_failed", id, { title: clipTitle(found).title, error: error.slice(0, 200) }));
  });
}

// ---- icons -------------------------------------------------------------------------------------------------

const ICON_RETRY_MS = 7 * 86_400_000;

/** Sites whose icon has not been asked for (or was not there a week ago), each with one of its addresses to ask at. */
export function iconsToFetch(world: World, limit = 8, now: number = Date.now()): Array<{ host: string; url: string }> {
  const known = new Map(world.db.prepare("SELECT host, bytes IS NOT NULL AS found, checked_at FROM link_icons").all().map((row) => [row.host as string, row]));
  const wanted = new Map<string, string>();
  for (const row of world.db.prepare("SELECT url FROM link_items ORDER BY kind DESC, rowid").all()) {
    const host = hostOf(row.url as string), seen = known.get(host);
    if (!host || wanted.has(host) || seen?.found || (seen && now - Date.parse(seen.checked_at as string) < ICON_RETRY_MS)) continue;
    wanted.set(host, row.url as string);
    if (wanted.size >= limit) break;
  }
  return [...wanted].map(([host, url]) => ({ host, url }));
}

/** The site's icon, or that it has none. Not an event by itself: `noteIcons` says once that some arrived. */
export function recordIcon(world: World, host: string, icon: { type: string; bytes: Uint8Array } | null): void {
  world.tx((db) => db.prepare(`INSERT INTO link_icons (host, type, bytes, checked_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(host) DO UPDATE SET type = excluded.type, bytes = excluded.bytes, checked_at = excluded.checked_at`)
    .run(host, icon?.type ?? null, icon ? Buffer.from(icon.bytes) : null, new Date().toISOString()));
}

/** Tells devices that icons arrived, so they draw them. */
export function noteIcons(world: World, count: number): void {
  world.tx(() => recordDomainEvent(world, { kind: "link.icons", subject: "link:icons", payload: { count } }));
}

export function getIcon(world: World, host: string): { type: string; bytes: Uint8Array } | null {
  const row = world.db.prepare("SELECT type, bytes FROM link_icons WHERE host = ? AND bytes IS NOT NULL").get(host.toLowerCase());
  return row ? { type: row.type as string, bytes: row.bytes as Uint8Array } : null;
}

/** One line per clip, as a model reads it. */
export function formatClip(clip: Clip, topics: readonly Topic[]): string {
  const path = topicPath(topicTree(topics), clip.topicId, undefined, "/");
  return [
    `${clip.id}  ${clip.title}`, `${clip.type} on ${clip.platform === "web" ? clip.site : clip.platform}`,
    ...(path ? [`topic: ${path}`] : ["no topic"]), clip.state, ...(clip.note ? [`note: ${clip.note}`] : []), clip.url,
  ].join(" | ");
}

/** The user removed an area: its topics move to `moveTo`, or to no area. */
export function moveTopicsOutOfArea(world: World, id: string, moveTo: string | null): number {
  return Number(world.db.prepare("UPDATE link_topics SET area = ? WHERE area = ?").run(moveTo, id).changes);
}

// ---- bringing bookmarks in (links.md §4.10.4) ---------------------------------------------------------------

/** Writes one part of an import the user confirmed. Each request names its import, so the parts add up to one thing
 * that can be undone. An address already kept is not added again; if it had no category, it takes this one. Sites
 * go into the tree without being pinned; saved things come in as seen, with the title the browser kept. */
export function importLinks(world: World, input: { importId: string; entries: readonly ImportEntry[] }): LinkResult<{ added: number; filed: number; skipped: number }> {
  if (!/^[\w-]{1,64}$/.test(input.importId)) return { error: "An import needs an id." };
  if (input.entries.length > IMPORT_CHUNK * 2) return { error: `Send at most ${IMPORT_CHUNK * 2} bookmarks at a time.` };
  return world.tx((db) => {
    const now = new Date().toISOString();
    const kept = db.prepare("SELECT * FROM link_imports WHERE id = ?").get(input.importId);
    const itemIds: string[] = kept ? JSON.parse(kept.item_ids as string) : [];
    const topicIds: string[] = kept ? JSON.parse(kept.topic_ids as string) : [];
    if (itemIds.length + input.entries.length > MAX_IMPORT) return { error: `One import takes at most ${MAX_IMPORT} bookmarks.` };
    const topics = new Map<string, string | null>();
    const topicFor = (entry: ImportEntry): string | null => {
      const path = (entry.path ?? []).map((name) => text(name, 60)).filter(Boolean).slice(0, MAX_TOPIC_DEPTH);
      if (!path.length) return null;
      const area = entry.area && isArea(world, entry.area) ? entry.area : null;
      const cacheKey = JSON.stringify([area, path.map((name) => name.toLowerCase())]);
      if (topics.has(cacheKey)) return topics.get(cacheKey)!;
      let parentId: string | null = null;
      for (const name of path) {
        const found = sibling(world, name, parentId, parentId ? null : area);
        if (found) { parentId = found.id as string; continue; }
        const id = newId();
        db.prepare("INSERT INTO link_topics (id, name, area, parent_id, created_at) VALUES (?, ?, ?, ?, ?)").run(id, name, area, parentId, now);
        topicIds.push(id);
        parentId = id;
      }
      topics.set(cacheKey, parentId);
      return parentId;
    };
    let added = 0, filed = 0, skipped = 0;
    for (const entry of input.entries) {
      let url: string;
      try { url = normalizeUrl(entry.url); } catch { skipped++; continue; }
      const topicId = topicFor(entry);
      const found = db.prepare("SELECT id, topic_id FROM link_items WHERE url = ? ORDER BY kind = 'place' DESC LIMIT 1").get(url);
      if (found) {
        if (topicId && !found.topic_id) { db.prepare("UPDATE link_items SET topic_id = ? WHERE id = ?").run(topicId, found.id as string); filed++; } else skipped++;
        continue;
      }
      const id = newId();
      const tidy = tidyTitle(entry.title, url);
      const title = text(tidy.title, 300);
      if (entry.kind === "place") {
        db.prepare("INSERT INTO link_items (id, kind, url, title, title_source, topic_id, pinned, position, saved_at) VALUES (?, 'place', ?, ?, 'given', ?, 0, 0, ?)")
          .run(id, url, title || siteName(url), topicId, now);
      } else {
        const { platform, type, host } = classify(url);
        db.prepare(`INSERT INTO link_items (id, kind, url, title, title_source, platform, type, site, description, topic_id, state, saved_at, fetch)
          VALUES (?, 'clip', ?, ?, ?, ?, ?, ?, ?, ?, 'seen', ?, ?)`)
          .run(id, url, title || nameFromUrl(url), title ? "page" : "url", platform, type, host, text(tidy.description, 600) || null, topicId, now, title ? "done" : "pending");
      }
      itemIds.push(id);
      added++;
    }
    db.prepare(`INSERT INTO link_imports (id, at, item_ids, topic_ids) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET item_ids = excluded.item_ids, topic_ids = excluded.topic_ids`).run(input.importId, now, JSON.stringify(itemIds), JSON.stringify(topicIds));
    // Only the last five imports can be undone.
    db.prepare("DELETE FROM link_imports WHERE id NOT IN (SELECT id FROM link_imports ORDER BY at DESC, rowid DESC LIMIT 5)").run();
    recordDomainEvent(world, { kind: "link.imported", subject: `link-import:${input.importId}`, payload: { added, filed, skipped } });
    return { added, filed, skipped };
  });
}

/** Takes an import back: what it added is removed, and the categories it made, once they are empty. What it filed
 * that was already there stays where it is now. */
export function undoImport(world: World, importId: string): LinkResult<{ removed: number }> {
  return world.tx((db) => {
    const kept = db.prepare("SELECT * FROM link_imports WHERE id = ?").get(importId);
    if (!kept) return { error: "That import can no longer be undone." };
    const drop = db.prepare("DELETE FROM link_items WHERE id = ?");
    let removed = 0;
    for (const id of JSON.parse(kept.item_ids as string) as string[]) removed += Number(drop.run(id).changes);
    const made = JSON.parse(kept.topic_ids as string) as string[];
    const empty = db.prepare(`DELETE FROM link_topics WHERE id = ? AND NOT EXISTS (SELECT 1 FROM link_items WHERE topic_id = ?)
      AND NOT EXISTS (SELECT 1 FROM link_topics WHERE parent_id = ?)`);
    for (const id of [...made].reverse()) empty.run(id, id, id);
    db.prepare("DELETE FROM link_imports WHERE id = ?").run(importId);
    recordDomainEvent(world, { kind: "link.import_undone", subject: `link-import:${importId}`, payload: { removed } });
    return { removed };
  });
}
