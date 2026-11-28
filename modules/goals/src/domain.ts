/** The goals module's rules (docs/design/goals.md 4.1): a goal is a folder in the notes; its files are the truth.
 * `goal_goals` is an index of them that can be dropped and built again; `goal_steps` is the record of which steps
 * the user said are done, and when (a fact, kept by the step's block id so renaming a step loses nothing). */
import { readdirSync } from "node:fs";
import { localDate, newId, recordDomainEvent, type Migration, type World } from "@zirma/module-kit";
import { createPage, flipHistory, type Library, LibraryError, listHistory, movePage, safeName, savePage, trashPage } from "@zirma/module-notes";
import { setProperty } from "@zirma/module-notes/markdown";
import { freeStepId, isDate, readGoal, readOutline, withStepId, writeGoal, type Outline } from "./format.ts";
import type { GoalDetail, GoalPages, GoalStage, GoalSummary } from "./types.ts";

export const MIGRATIONS: Migration[] = [{
  id: "goal:1",
  sql: `
CREATE TABLE goal_goals (
  id TEXT PRIMARY KEY NOT NULL,
  folder TEXT NOT NULL,
  name TEXT NOT NULL,
  sentence TEXT NOT NULL,
  deadline TEXT,
  pace INTEGER,
  goal_page TEXT NOT NULL,
  picture_page TEXT,
  route_page TEXT,
  parts INTEGER NOT NULL DEFAULT 0,
  topics INTEGER NOT NULL DEFAULT 0,
  stages TEXT NOT NULL DEFAULT '[]',
  created TEXT
) STRICT;
CREATE TABLE goal_steps (
  goal TEXT NOT NULL,
  step TEXT NOT NULL,
  done_at TEXT NOT NULL,
  PRIMARY KEY (goal, step)
) STRICT;`,
}];

/** What a goal's folder and files are called when Zirma makes them, in the user's language. A folder made in the
 * other language (or by hand) is read the same. */
const NAMES = {
  zh: { root: "目标", goal: "目标", picture: "世界观", route: "路线", why: "我为什么要它" },
  en: { root: "Goals", goal: "Goal", picture: "Big picture", route: "Route", why: "Why I want it" },
} as const;
export type Lang = keyof typeof NAMES;
const LANGS = Object.keys(NAMES) as Lang[];
type Kind = "goal" | "picture" | "route";

export class GoalError extends Error {
  override name = "GoalError";
  readonly code: "not_found" | "changed" | "bad_input";
  constructor(code: GoalError["code"], message: string) { super(message); this.code = code; }
}

/** One of a goal's pages, whichever language it was named in. */
function findPage(library: Library, folder: string, kind: Kind): { id: string; text: string; fp: string } | null {
  for (const lang of LANGS) {
    const id = `${folder}/${NAMES[lang][kind]}`;
    const read = library.read(id);
    if (read) return { id, text: read.text, fp: read.fp };
  }
  return null;
}

/** The folders that may be goals: the ones directly under `目标/` and `Goals/`. */
function goalFolders(library: Library): string[] {
  const out: string[] = [];
  for (const lang of LANGS) {
    const root = NAMES[lang].root;
    let names: string[];
    try {
      names = readdirSync(library.folder(root), { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name);
    } catch { continue; }
    for (const name of names.sort((a, b) => a.localeCompare(b))) out.push(`${root}/${name}`);
  }
  return out;
}

/** A route's stages as devices list them: every step with the key an operation names it by. */
function stagesOf(route: Outline | null): Array<{ title: string; steps: Array<{ key: string; title: string }> }> {
  let n = 0;
  return (route?.parts ?? []).map((part) => ({
    title: part.title,
    // Counted over every step, with or without an id: `#3` is the third step of the route.
    steps: part.items.map((item) => { n += 1; return { key: item.id ?? `#${n}`, title: item.title }; }),
  }));
}

interface Indexed {
  id: string; folder: string; name: string; sentence: string; deadline: string | null; pace: number | null;
  goal_page: string; picture_page: string | null; route_page: string | null; parts: number; topics: number; stages: string; created: string | null;
}

function readFolder(library: Library, folder: string, taken: ReadonlySet<string>): Indexed | null {
  const goal = findPage(library, folder, "goal");
  if (!goal) return null;
  const file = readGoal(goal.text);
  let id = file.id;
  // A folder made by hand, or a copy of another goal's folder: it gets an id of its own, written in its file.
  if (!id || taken.has(id)) {
    id = `g${newId().replace(/[^A-Za-z0-9]/g, "")}`;
    if (!library.save(goal.id, goal.fp, setProperty(goal.text, "zirma-goal", id)).ok) return null;
  }
  const picture = findPage(library, folder, "picture"), route = findPage(library, folder, "route");
  const parts = picture ? readOutline(picture.text).parts.filter((part) => part.items.length) : [];
  const created = /^created:\s*"?(\d{4}-\d{2}-\d{2})/m.exec(goal.text)?.[1] ?? null;
  return {
    id, folder, name: folder.slice(folder.indexOf("/") + 1), sentence: file.sentence, deadline: file.deadline, pace: file.pace,
    goal_page: goal.id, picture_page: picture?.id ?? null, route_page: route?.id ?? null,
    parts: parts.length, topics: parts.reduce((sum, part) => sum + part.items.length, 0),
    stages: JSON.stringify(stagesOf(route ? readOutline(route.text) : null)), created,
  };
}

const COLUMNS = ["id", "folder", "name", "sentence", "deadline", "pace", "goal_page", "picture_page", "route_page", "parts", "topics", "stages", "created"] as const;

/** Reads the goals' folders into the index. Says whether anything changed; when it did, devices are told. */
export function indexGoals(world: World, library: Library): boolean {
  const found = new Map<string, Indexed>();
  for (const folder of goalFolders(library)) {
    let one: Indexed | null = null;
    try { one = readFolder(library, folder, new Set(found.keys())); } catch { one = null; }
    if (one) found.set(one.id, one);
  }
  return world.tx((db) => {
    const before = new Map(db.prepare("SELECT * FROM goal_goals").all().map((row) => [row.id as string, JSON.stringify(COLUMNS.map((column) => row[column] ?? null))]));
    let changed = false;
    for (const one of found.values()) {
      if (before.get(one.id) === JSON.stringify(COLUMNS.map((column) => one[column] ?? null))) continue;
      db.prepare(`INSERT OR REPLACE INTO goal_goals (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`).run(...COLUMNS.map((column) => one[column] ?? null));
      changed = true;
    }
    for (const id of before.keys()) {
      if (found.has(id)) continue;
      // The record of its steps stays: the folder may come back from the trash.
      db.prepare("DELETE FROM goal_goals WHERE id = ?").run(id);
      changed = true;
    }
    if (changed) recordDomainEvent(world, { kind: "goal.indexed", subject: "goal", payload: { goals: found.size } });
    return changed;
  });
}

function doneOf(world: World, goal: string): Map<string, string> {
  return new Map(world.db.prepare("SELECT step, done_at FROM goal_steps WHERE goal = ?").all(goal).map((row) => [row.step as string, row.done_at as string]));
}

function summary(world: World, row: Record<string, unknown>): GoalSummary {
  const done = doneOf(world, row.id as string);
  const stages = (JSON.parse(row.stages as string) as Array<{ title: string; steps: Array<{ key: string; title: string }> }>)
    .map((stage): GoalStage => ({ title: stage.title, steps: stage.steps.map((step) => ({ ...step, done: done.has(step.key) })) }));
  return {
    id: row.id as string, name: row.name as string, sentence: row.sentence as string, deadline: row.deadline as string | null, pace: row.pace as number | null,
    parts: row.parts as number, topics: row.topics as number, stages,
  };
}

/** The goals, oldest first. */
export function listGoals(world: World): GoalSummary[] {
  return world.db.prepare("SELECT * FROM goal_goals ORDER BY created IS NULL, created, lower(name)").all().map((row) => summary(world, row));
}

function rowOf(world: World, id: string): Record<string, unknown> {
  const row = world.db.prepare("SELECT * FROM goal_goals WHERE id = ?").get(id);
  if (!row) throw new GoalError("not_found", "No such goal");
  return row;
}

const pagesOf = (row: Record<string, unknown>): GoalPages => ({
  folder: row.folder as string, goal: row.goal_page as string, picture: row.picture_page as string | null, route: row.route_page as string | null,
});

/** One goal as its files say it now (not as the index last read them): a page that was just edited shows at once. */
export function goalDetail(world: World, library: Library, id: string): GoalDetail {
  const row = rowOf(world, id);
  const pages = pagesOf(row);
  const goal = library.read(pages.goal);
  if (!goal) throw new GoalError("not_found", "The goal's file is gone");
  const file = readGoal(goal.text);
  const picture = pages.picture ? library.read(pages.picture) : null, route = pages.route ? library.read(pages.route) : null;
  const pictureOutline = readOutline(picture?.text ?? ""), routeOutline = readOutline(route?.text ?? "");
  const done = doneOf(world, id);
  const keys = stagesOf(routeOutline);
  const stages = routeOutline.parts.map((part, at) => ({
    title: part.title, note: part.text,
    steps: part.items.map((item, index) => ({ key: keys[at].steps[index].key, title: item.title, body: item.body, done: done.has(keys[at].steps[index].key) })),
  }));
  const board = pictureOutline.parts.filter((part) => part.items.length);
  return {
    id, name: row.name as string, sentence: file.sentence, why: file.why, deadline: file.deadline, pace: file.pace,
    parts: board.length, topics: board.reduce((sum, part) => sum + part.items.length, 0),
    stages: stages.map((stage) => ({ title: stage.title, steps: stage.steps.map(({ key, title, done: isDone }) => ({ key, title, done: isDone })) })),
    pages,
    picture: {
      whole: pictureOutline.intro,
      parts: board.map((part) => ({ title: part.title, line: part.text, topics: part.items.map((item) => ({ title: item.title, body: item.body })) })),
      more: pictureOutline.parts.filter((part) => !part.items.length && (part.title || part.text)).map((part) => ({ title: part.title, text: part.text })),
    },
    route: { intro: routeOutline.intro, stages },
  };
}

/** A short name for the goal's folder from its sentence: its first clause, and of a long one the first words, never
 * cut inside a word. The user can change it. */
export function nameFrom(sentence: string, most = 28): string {
  const clause = /^(.{4,}?)[，。；,;.！!]/u.exec(sentence.trim())?.[1] ?? sentence;
  const words = [...safeName(clause)];
  if (words.length <= most) return words.join("") || "Goal";
  const cut = words.slice(0, most).join("");
  // In a language written with spaces, back to the last whole word (unless the cut fell between two words anyway).
  const whole = /\s/.test(words[most]!) ? cut : /^(.{8,})\s\S*$/u.exec(cut)?.[1] ?? cut;
  return whole.trim() || "Goal";
}

/** A new goal: its folder, with the goal's own file, an empty big picture and an empty route. */
export function createGoal(world: World, library: Library, lang: Lang, input: { sentence: string; name?: string }): { id: string } {
  const sentence = input.sentence.trim().replace(/\s*\n\s*/g, " ");
  if (!sentence) throw new GoalError("bad_input", "A goal needs its sentence");
  const names = NAMES[lang];
  const folder = library.freeName(names.root, input.name?.trim() || nameFrom(sentence));
  const id = `g${newId().replace(/[^A-Za-z0-9]/g, "")}`;
  const text = `---\nzirma-goal: ${id}\ncreated: ${localDate()}\n---\n${sentence}\n\n## ${names.why}\n`;
  createPage(world, library, { parent: folder, title: names.goal, text });
  createPage(world, library, { parent: folder, title: names.picture });
  createPage(world, library, { parent: folder, title: names.route });
  world.tx(() => recordDomainEvent(world, { kind: "goal.created", subject: `goal:${id}`, payload: { id } }));
  indexGoals(world, library);
  return { id };
}

export interface GoalPatch { name?: string; sentence?: string; why?: string; deadline?: string | null; pace?: number | null }

/** The user changes their goal: its sentence, why they want it, its deadline, its pace, or its folder's name. */
export function updateGoal(world: World, library: Library, libraryId: string, lang: Lang, id: string, patch: GoalPatch, onMoved?: (from: string, to: string) => void): { ok: true } {
  const row = rowOf(world, id);
  let pages = pagesOf(row);
  if (patch.sentence !== undefined && !patch.sentence.trim()) throw new GoalError("bad_input", "A goal needs its sentence");
  if (patch.deadline != null && !isDate(patch.deadline)) throw new GoalError("bad_input", "A deadline is a date");
  if (patch.name !== undefined && safeName(patch.name) !== row.name) {
    const title = safeName(patch.name);
    if (!title) throw new GoalError("bad_input", "A goal needs a name");
    const moved = movePage(world, library, { id: pages.folder, title });
    onMoved?.(pages.folder, moved.id);
    const under = (page: string | null) => (page ? moved.id + page.slice(pages.folder.length) : null);
    pages = { folder: moved.id, goal: under(pages.goal)!, picture: under(pages.picture), route: under(pages.route) };
  }
  if (patch.sentence !== undefined || patch.why !== undefined || patch.deadline !== undefined || patch.pace !== undefined) {
    const read = library.read(pages.goal);
    if (!read) throw new GoalError("not_found", "The goal's file is gone");
    let text = read.text;
    if (patch.sentence !== undefined || patch.why !== undefined) text = writeGoal(text, { sentence: patch.sentence, why: patch.why }, NAMES[lang].why);
    if (patch.deadline !== undefined) text = setProperty(text, "deadline", patch.deadline);
    if (patch.pace !== undefined) text = setProperty(text, "pace", patch.pace === null ? null : String(patch.pace));
    if (text !== read.text) {
      const saved = savePage(world, library, libraryId, { library: libraryId, id: pages.goal, base: read.fp, text });
      if (!saved.ok) throw new GoalError("changed", "The goal's file changed elsewhere; try again");
    }
  }
  world.tx(() => recordDomainEvent(world, { kind: "goal.updated", subject: `goal:${id}`, payload: { id, fields: Object.keys(patch) } }));
  indexGoals(world, library);
  return { ok: true };
}

/** The big picture's or the route's page, made if the folder does not have it yet (a folder made by hand). */
export function ensurePage(world: World, library: Library, lang: Lang, id: string, which: "picture" | "route"): { page: string } {
  const row = rowOf(world, id);
  const folder = row.folder as string;
  const found = findPage(library, folder, which);
  if (found) return { page: found.id };
  const made = createPage(world, library, { parent: folder, title: NAMES[lang][which] });
  indexGoals(world, library);
  return { page: made.id };
}

/** The user says a step is done, or takes that back. A step with no block id yet gets one in the route's file, so
 * what is recorded stays with the step when it is renamed or moved. */
export function setStep(world: World, library: Library, libraryId: string, id: string, key: string, done: boolean): { key: string; done: boolean } {
  const row = rowOf(world, id);
  const routePage = row.route_page as string | null;
  const read = routePage ? library.read(routePage) : null;
  if (!routePage || !read) throw new GoalError("not_found", "The goal has no route yet");
  let step = key;
  if (key.startsWith("#")) {
    const made = freeStepId(read.text);
    const text = withStepId(read.text, Number(key.slice(1)), made);
    if (text === null) throw new GoalError("not_found", "No such step");
    const saved = savePage(world, library, libraryId, { library: libraryId, id: routePage, base: read.fp, text });
    if (!saved.ok) throw new GoalError("changed", "The route changed elsewhere; try again");
    step = made;
  } else if (!readOutline(read.text).parts.some((part) => part.items.some((item) => item.id === key))) {
    throw new GoalError("not_found", "No such step");
  }
  world.tx((db) => {
    if (done) db.prepare("INSERT OR IGNORE INTO goal_steps (goal, step, done_at) VALUES (?, ?, ?)").run(id, step, new Date().toISOString());
    else db.prepare("DELETE FROM goal_steps WHERE goal = ? AND step = ?").run(id, step);
    recordDomainEvent(world, { kind: done ? "goal.step_done" : "goal.step_reopened", subject: `goal:${id}`, payload: { id, step } });
  });
  indexGoals(world, library);
  return { key: step, done };
}

/** The goal's folder goes to the notes' trash. Returns the entry in the notes' history that puts it back. */
export function removeGoal(world: World, library: Library, id: string): { entry: string | null } {
  const folder = rowOf(world, id).folder as string;
  trashPage(world, library, folder);
  const entry = listHistory(world, folder).find((one) => one.kind === "delete" && !one.undone)?.id ?? null;
  world.tx(() => recordDomainEvent(world, { kind: "goal.removed", subject: `goal:${id}`, payload: { id } }));
  indexGoals(world, library);
  return { entry };
}

/** Puts a removed goal's folder back. */
export function restoreGoal(world: World, library: Library, entry: string): { ok: boolean } {
  const answer = flipHistory(world, library, entry);
  indexGoals(world, library);
  return { ok: answer.ok };
}

export { LibraryError };
