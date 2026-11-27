/** Zirma's layer of the notes (notes-two-layers.md 4.4–4.8): the pages Zirma keeps in `zirma_notes/`, each
 * gathering what the user wrote about one subject, every line with its sources; the user's "not this line", "make it
 * mine" and "give it back"; and Zirma's suggestions on the user's own pages.
 *
 * The rules are here, in code, not in what the model is told: Zirma writes only in its own folder, a line without a
 * source in the user's pages is dropped, a line the user removed is not written again, a subject the user deleted or
 * took is not kept again, and a page changed outside Zirma is left alone until the user says what to do. */
import { newId, recordDomainEvent, type World } from "@zirma/module-kit";
import { setProperty } from "./markdown/index.ts";
import { indexLibrary, indexOne, movePage, recordEdit, recordStep } from "./domain.ts";
import { composeKept, readKept, sameKept, splitSources, type KeptSource, type Locale } from "./kept-format.ts";
import {
  addReject, addSkip, dropKept, isRejected, isSkipped, keptRow, keyOf, noteKept, plainWords, rejectsOf, alike,
} from "./layer-store.ts";
import { Library, LibraryError, safeName, ZIRMA_DIR } from "./library.ts";
import { PAGE_ICONS, type KeptDetail, type Suggestion } from "./types.ts";

const inZirma = (id: string) => id.startsWith(`${ZIRMA_DIR}/`);
const titleOf = (id: string) => id.slice(id.lastIndexOf("/") + 1);

/** The page about the user (notes-two-layers.md 4.8), in the user's language. */
export const ABOUT: Record<Locale, string> = { zh: "关于你", en: "About you" };
export const aboutId = (locale: Locale) => `${ZIRMA_DIR}/${ABOUT[locale]}`;

/* ── The user's pages, by the names a link or the model gives them ── */

interface Named { id: string; title: string }

function userPages(world: World): Named[] {
  return world.db.prepare("SELECT id, title FROM note_pages WHERE zirma = 0 AND file = 1").all().map((row) => ({ id: row.id as string, title: row.title as string }));
}

/** One of the user's pages by a name: its path, or a name only one of their pages has. Null when there is none, or
 * when the name is not enough to tell which. */
export function findUserPage(pages: readonly Named[], name: string): string | null {
  const said = name.trim().replace(/^\[\[|\]\]$/g, "").split("|")[0].split(/[#^]/)[0].replace(/\.md$/i, "").replace(/^\/+/, "").trim();
  if (!said) return null;
  const lower = said.toLowerCase();
  const exact = pages.find((page) => page.id.toLowerCase() === lower);
  if (exact) return exact.id;
  const named = pages.filter((page) => page.title.toLowerCase() === lower);
  if (named.length === 1) return named[0].id;
  const ending = pages.filter((page) => page.id.toLowerCase().endsWith(`/${lower}`));
  return ending.length === 1 ? ending[0].id : null;
}

/** How a link names a page: its name when no other page in the library has it, else its path. */
function linkName(world: World, id: string): string {
  const others = world.db.prepare("SELECT count(*) AS n FROM note_pages WHERE lower(title) = lower(?) AND id != ?").get(titleOf(id), id)!.n as number;
  return others ? id : titleOf(id);
}

/** What a line's sources are compared by when checking the lines the user removed. */
const sourceKeys = (world: World, ids: readonly string[]) => [...new Set(ids.flatMap((id) => [id.toLowerCase(), titleOf(id).toLowerCase(), linkName(world, id).toLowerCase()]))];

/** Words from the model, as one line. */
const oneLine = (text: unknown) => String(text ?? "").replace(/\s+/g, " ").replace(/^[-*+]\s+/, "").trim();

/* ── Writing one of Zirma's pages ── */

export interface KeepInput {
  title: string;
  icon?: string | null;
  sections: ReadonlyArray<{ heading?: string | null; lines: ReadonlyArray<{ text: string; sources: readonly string[] }> }>;
  /** One short line for the page's history: why it changed ("因为《周末想试的》，加了一行"). */
  why: string;
}

export type KeepAnswer =
  | { ok: true; id: string; created: boolean; unchanged: boolean; lines: number; unsourced: number; removed: number; entry: string | null }
  | { ok: false; reason: "bad_name" | "name_taken" | "skipped" | "edited" | "empty" | "reserved"; message: string };

/** Whether a title names the page about the user, in either language: only note_remember (and the user) write it. */
export function isAboutTitle(title: string): boolean {
  const key = safeName(title).replace(/^[.\s]+/, "").toLowerCase();
  return Object.values(ABOUT).some((name) => name.toLowerCase() === key);
}

/**
 * Writes one of Zirma's pages, whole. Each line keeps only sources that are pages of the user's; a line left with
 * none is dropped, and so is one the user removed before. Lines that came from outside the notes (a fact the user
 * said to remember) stay unless the new text has them. The page is refused when its name is one of the user's pages,
 * when the user deleted or took a page of that name, and when the file was changed outside Zirma.
 */
export function keepPage(world: World, library: Library, input: KeepInput, locale: Locale): KeepAnswer {
  // The page about the user goes into every run's instructions (index.ts guidance), so a pass may only add a fact to
  // it, one at a time, through note_remember: never write it whole, which could drop or rewrite what is there.
  if (isAboutTitle(input.title)) {
    return { ok: false, reason: "reserved", message: `“${ABOUT[locale]}” is written only with note_remember, one fact at a time.` };
  }
  return writePage(world, library, input, locale);
}

function writePage(world: World, library: Library, input: KeepInput, locale: Locale): KeepAnswer {
  // A name is a file in Zirma's folder and nothing else: no dots or spaces in front ("../x" is "x").
  const title = safeName(input.title).replace(/^[.\s]+/, "");
  if (!title) return { ok: false, reason: "bad_name", message: "Give the page a name." };
  const id = `${ZIRMA_DIR}/${title}`;
  const pages = userPages(world);
  if (pages.some((page) => page.title.toLowerCase() === title.toLowerCase())) {
    return { ok: false, reason: "name_taken", message: `The user has a page called “${title}”. Your pages never share a name with theirs: call this one something else.` };
  }
  if (isSkipped(world, title)) return { ok: false, reason: "skipped", message: `The user deleted or took the page “${title}”: do not keep that subject.` };
  const read = library.read(id);
  if (read && keptRow(world, id)?.fp !== read.fp) {
    return { ok: false, reason: "edited", message: `“${title}” was changed outside Zirma; it stays as it is until the user decides. Leave it.` };
  }
  const rejects = rejectsOf(world, id);
  let unsourced = 0, removed = 0;
  const seen = new Set<string>();
  const sections: Array<{ heading: string | null; lines: Array<{ text: string; sources: KeptSource[] }> }> = [];
  for (const section of input.sections) {
    const lines: Array<{ text: string; sources: KeptSource[] }> = [];
    for (const line of section.lines) {
      const split = splitSources(oneLine(line.text));
      const names = [...line.sources, ...split.sources.filter((source) => source.target).map((source) => source.target!)];
      const ids = [...new Set(names.map((name) => findUserPage(pages, name)).filter((found): found is string => !!found))];
      if (!split.text) continue;
      if (!ids.length) { unsourced++; continue; }
      if (isRejected(rejects, split.text, sourceKeys(world, ids))) { removed++; continue; }
      const key = plainWords(split.text);
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push({ text: split.text, sources: ids.map((one) => ({ target: linkName(world, one), label: titleOf(one) })) });
    }
    if (lines.length) sections.push({ heading: oneLine(section.heading) || null, lines });
  }
  // What the user said to remember from outside the notes is theirs to remove, not the model's to drop.
  if (read) {
    for (const line of readKept(read.text).lines) {
      if (!line.sources.length || line.sources.some((source) => source.target) || seen.has(plainWords(line.text))) continue;
      seen.add(plainWords(line.text));
      const home = sections.find((section) => section.heading === line.section) ?? sections[sections.length - 1];
      if (home) home.lines.push({ text: line.text, sources: line.sources });
      else sections.push({ heading: line.section, lines: [{ text: line.text, sources: line.sources }] });
    }
  }
  const count = sections.reduce((n, section) => n + section.lines.length, 0);
  if (!count) {
    return { ok: false, reason: "empty", message: `Nothing left to write: every line needs one of the user's pages as a source${removed ? `, and ${removed} line(s) were ones the user removed` : ""}.` };
  }
  const was = read ? readKept(read.text).props.icon : undefined;
  const icon = input.icon === undefined ? (was || null) : input.icon && (PAGE_ICONS as readonly string[]).includes(input.icon) ? input.icon : null;
  const text = composeKept({ icon, sections }, locale);
  if (read && sameKept(read.text, text)) return { ok: true, id, created: false, unchanged: true, lines: count, unsourced, removed, entry: null };
  return writeKept(world, library, id, read, text, { actor: "alfred", why: oneLine(input.why).slice(0, 200) }, { lines: count, unsourced, removed });
}

function writeKept(
  world: World, library: Library, id: string, read: { text: string; fp: string } | null, text: string,
  by: { actor: "user" | "alfred"; why: string; extra?: Record<string, unknown> }, counts: { lines: number; unsourced: number; removed: number },
): KeepAnswer {
  const saved = library.save(id, read?.fp ?? null, text);
  if (!saved.ok) return { ok: false, reason: "edited", message: `“${titleOf(id)}” was changed outside Zirma just now; left as it is.` };
  let entry: string | null = null;
  world.tx(() => {
    noteKept(world, id, text, saved.fp);
    indexOne(world, library, id);
    entry = read
      ? recordEdit(world, id, read.text, text, by.actor, by.why, by.extra)
      : recordStep(world, id, "create", { id, why: by.why, ...by.extra }, { after: text }, by.actor);
    recordDomainEvent(world, { kind: "note.kept", subject: `note:${id}`, actor: by.actor, payload: { page: id, entry, created: !read } });
  });
  return { ok: true, id, created: !read, unchanged: false, entry, ...counts };
}

/** Zirma's pages whose sources are gone (a page of the user's deleted or renamed past finding): the links that no
 * longer find a page are taken out, and a line that has no source left goes. No model needed. Returns the pages
 * changed. */
export function pruneSources(world: World, library: Library, locale: Locale): string[] {
  const pages = userPages(world);
  const changed: string[] = [];
  for (const row of world.db.prepare("SELECT id FROM note_pages WHERE zirma = 1 AND file = 1").all()) {
    const id = row.id as string;
    const read = library.read(id);
    if (!read || keptRow(world, id)?.fp !== read.fp) continue;
    const page = readKept(read.text);
    const gone = new Set<string>();
    let dropped = 0;
    const sections = page.sections.map((section) => ({
      heading: section.heading,
      lines: section.lines.flatMap((line) => {
        const sources = line.sources.filter((source) => {
          if (!source.target) return true;
          if (findUserPage(pages, source.target)) return true;
          gone.add(source.label);
          return false;
        });
        if (line.sources.length && !sources.length) { dropped++; return []; }
        return [{ text: line.text, sources }];
      }),
    }));
    if (!gone.size) continue;
    const names = [...gone].map((name) => (locale === "zh" ? `《${name}》` : `“${name}”`)).join(locale === "zh" ? "、" : ", ");
    const why = locale === "zh" ? `${names}不在了${dropped ? `，去掉了只靠它的 ${dropped} 行` : "，去掉了出处"}` : `${names} is gone${dropped ? `; removed ${dropped} line(s) that relied on it` : "; removed it as a source"}`;
    const left = sections.reduce((n, section) => n + section.lines.length, 0);
    if (!left) continue; // A page with nothing left is the user's to delete, not Zirma's.
    const text = composeKept({ icon: page.props.icon || null, sections }, locale);
    const answer = writeKept(world, library, id, read, text, { actor: "alfred", why }, { lines: left, unsourced: 0, removed: 0 });
    if (answer.ok) changed.push(id);
  }
  return changed;
}

/* ── What the user does with Zirma's pages ── */

export type LayerAnswer = { ok: true; id?: string; entry?: string | null } | { ok: false; reason: "changed" | "edited" | "gone" | "not_zirma" };

/** "Not this; remove this line": the line goes, and Zirma does not write it again from the same place. */
export function rejectLine(world: World, library: Library, id: string, index: number, words: string): LayerAnswer {
  if (!inZirma(id)) return { ok: false, reason: "not_zirma" };
  const read = library.read(id);
  if (!read) return { ok: false, reason: "gone" };
  if (keptRow(world, id)?.fp !== read.fp) return { ok: false, reason: "edited" };
  const line = readKept(read.text).lines[index];
  if (!line || line.text !== words) return { ok: false, reason: "changed" };
  const lines = read.text.split("\n");
  lines.splice(line.at, 1);
  const text = lines.join("\n");
  const saved = library.save(id, read.fp, text);
  if (!saved.ok) return { ok: false, reason: "changed" };
  let entry: string | null = null;
  world.tx(() => {
    noteKept(world, id, text, saved.fp);
    indexOne(world, library, id);
    const sources = line.sources.filter((source) => source.target).map((source) => source.target!.toLowerCase());
    const reject = addReject(world, id, line.text, sources);
    entry = recordEdit(world, id, read.text, text, "user", "line.removed", { reject, words: line.text, sources });
  });
  return { ok: true, entry };
}

/** "Make it mine": the page moves to the top of the user's pages, without Zirma's properties; its sources stay at the
 * end of each line. Zirma does not keep that subject again. */
export function adoptPage(world: World, library: Library, id: string): LayerAnswer {
  if (!inZirma(id)) return { ok: false, reason: "not_zirma" };
  const read = library.read(id);
  if (!read) return { ok: false, reason: "gone" };
  let text = read.text;
  for (const key of ["zirma", "updated", "from"]) text = setProperty(text, key, null);
  text = text.replace(/^---\r?\n---\r?\n\r?\n?/, "");
  const to = library.freeName(null, titleOf(id));
  library.create(to, text);
  library.removeUntouched(id);
  let entry: string | null = null;
  world.tx(() => {
    world.db.prepare("UPDATE note_history SET page = ? WHERE page = ?").run(to, id);
    world.db.prepare("UPDATE note_suggestions SET state = 'stale', decided_at = ? WHERE page = ? AND state = 'open'").run(new Date().toISOString(), id);
    addSkip(world, titleOf(id), "adopted");
    dropKept(world, id);
    indexLibrary(world, library);
    entry = recordStep(world, to, "adopt", { from: id, to }, { before: read.text, after: text });
  });
  return { ok: true, id: to, entry };
}

/** A page of Zirma's changed outside Zirma, given back: the changed file is kept aside (`.trash/.versions/`) and the
 * page is again what Zirma last wrote. */
export function returnPage(world: World, library: Library, id: string): LayerAnswer {
  if (!inZirma(id)) return { ok: false, reason: "not_zirma" };
  const read = library.read(id);
  if (!read) return { ok: false, reason: "gone" };
  const kept = keptRow(world, id);
  if (kept?.fp === read.fp) return { ok: true, id };
  const aside = library.setAside(id);
  if (!kept) {
    world.tx(() => indexLibrary(world, library));
    return { ok: true };
  }
  const saved = library.save(id, null, kept.text);
  if (!saved.ok) return { ok: false, reason: "changed" };
  let entry: string | null = null;
  world.tx(() => {
    noteKept(world, id, kept.text, saved.fp);
    indexOne(world, library, id);
    entry = recordEdit(world, id, read.text, kept.text, "user", "returned", { aside });
  });
  return { ok: true, id, entry };
}

export function keptDetail(world: World, id: string, text: string, fp: string | null): KeptDetail {
  const page = readKept(text);
  const pages = userPages(world);
  const sources: KeptDetail["sources"] = [];
  const number = (source: KeptSource) => {
    const found = source.target ? findUserPage(pages, source.target) : null;
    const key = found ?? source.label;
    let at = sources.findIndex((one) => (one.page ?? one.label) === key);
    if (at === -1) { sources.push({ page: found, label: found ? titleOf(found) : source.label }); at = sources.length - 1; }
    return at + 1;
  };
  return {
    state: keptRow(world, id)?.fp === fp ? "ok" : "edited",
    updated: page.props.updated || null,
    sections: page.sections.map((section) => ({ heading: section.heading, lines: section.lines.map((line) => ({ index: line.index, text: line.text, refs: line.sources.map(number) })) })),
    sources,
  };
}

/* ── Facts about the user (notes-two-layers.md 4.8) ── */

/** Puts the page about the user in Zirma's layer, empty, when the library is made, so it is in the tree before the
 * first fact. Not put back once the user deleted or took it, and not made a second time under the other language's
 * name. Returns whether it was made. */
export function ensureAbout(world: World, library: Library, locale: Locale): boolean {
  if (Object.values(ABOUT).some((name) => library.read(`${ZIRMA_DIR}/${name}`) || isSkipped(world, name))) return false;
  const text = composeKept({ icon: "person", sections: [] }, locale);
  const why = locale === "zh" ? "放了一张空页，记下关于你的事" : "An empty page for what Zirma learns about you";
  return writeKept(world, library, aboutId(locale), null, text, { actor: "alfred", why }, { lines: 0, unsourced: 0, removed: 0 }).ok;
}

/** A fact about the user found in their notes goes on the page about them, with the page it came from. */
export function rememberFromNotes(world: World, library: Library, input: { fact: string; page: string }, locale: Locale): KeepAnswer | { ok: false; reason: "known"; message: string } {
  const id = aboutId(locale);
  const read = library.read(id);
  const page = read ? readKept(read.text) : null;
  if (page?.lines.some((line) => alike(line.text, input.fact) >= 0.8)) return { ok: false, reason: "known", message: "That is already on the page." };
  const sections = (page?.sections ?? []).map((section) => ({
    heading: section.heading,
    lines: section.lines.filter((line) => line.sources.some((source) => source.target)).map((line) => ({ text: line.text, sources: line.sources.map((source) => source.target!).filter(Boolean) })),
  }));
  if (!sections.length) sections.push({ heading: null, lines: [] });
  sections[sections.length - 1].lines.push({ text: input.fact, sources: [input.page] });
  return writePage(world, library, { title: ABOUT[locale], icon: page?.props.icon || "person", sections, why: locale === "zh" ? "记下了一条关于你的事" : "Noted a fact about you" }, locale);
}

/* ── Suggestions on the user's pages ── */

const toSuggestion = (row: Record<string, unknown>): Suggestion => ({
  id: row.id as string, page: row.page as string, kind: row.kind as Suggestion["kind"], find: (row.find as string | null) ?? null,
  replace: (row.replace as string | null) ?? null, under: (row.under as string | null) ?? null, reason: row.reason as string,
  sources: JSON.parse(row.sources as string) as Suggestion["sources"], at: row.at as string,
});

function sameAsBefore(world: World, key: string): string | null {
  const row = world.db.prepare("SELECT state FROM note_suggestions WHERE key = ? AND state IN ('open', 'declined', 'accepted') ORDER BY at DESC LIMIT 1").get(key);
  if (!row) return null;
  return row.state === "declined" ? "The user already said no to this suggestion; do not make it again." : row.state === "open" ? "This suggestion is already waiting for the user." : "The user already took this suggestion.";
}

function insertSuggestion(world: World, input: Omit<Suggestion, "id" | "at"> & { key: string }): string {
  const id = newId();
  world.tx(() => {
    world.db.prepare("INSERT INTO note_suggestions (id, page, kind, find, replace, under, reason, sources, key, state, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)")
      .run(id, input.page, input.kind, input.find, input.replace, input.under, input.reason, JSON.stringify(input.sources), input.key, new Date().toISOString());
    recordDomainEvent(world, { kind: "note.suggested", subject: `note:${input.page}`, actor: "alfred", payload: { page: input.page, kind: input.kind, id } });
  });
  return id;
}

/** Changing words in one of the user's pages, suggested: waits on that page for the user's yes or no. Answers what
 * the model reads back. */
export function suggestEdit(world: World, library: Library, input: { page: string; find: string; replace: string; reason: string; sources: readonly string[] }): string {
  const pages = userPages(world);
  const id = findUserPage(pages, input.page);
  if (!id) return inZirma(input.page) ? "Suggestions are for the user's pages; rewrite your own with note_keep." : `The user has no page “${input.page}”.`;
  const read = library.read(id);
  if (!read) return `The user has no page “${input.page}”.`;
  const at = input.find ? read.text.indexOf(input.find) : -1;
  if (at === -1) return "Those words are not in the page; read it again and copy them exactly.";
  if (read.text.indexOf(input.find, at + 1) !== -1) return "Those words appear more than once in the page; include more of the sentence.";
  if (input.find === input.replace) return "That changes nothing.";
  const reason = oneLine(input.reason);
  if (!reason) return "Say in one line why, for the user.";
  const sources = [...new Set(input.sources.map((name) => findUserPage(pages, name)).filter((found): found is string => !!found))];
  const key = keyOf("edit", id, plainWords(input.find), plainWords(input.replace));
  const before = sameAsBefore(world, key);
  if (before) return before;
  insertSuggestion(world, { page: id, kind: "edit", find: input.find, replace: input.replace, under: null, reason: reason.slice(0, 300), sources: sources.map((one) => ({ page: one, label: titleOf(one) })), key });
  return `Suggested on [[${id}]]; it waits there for the user.`;
}

/** Moving one of the user's pages under another (or to the top), suggested. */
export function suggestMove(world: World, input: { page: string; under: string; reason: string }): string {
  const pages = userPages(world);
  const id = findUserPage(pages, input.page);
  if (!id) return `The user has no page “${input.page}”.`;
  const under = input.under.trim() ? findUserPage(pages, input.under) : "";
  if (under === null) return `The user has no page “${input.under}”.`;
  const parent = id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "";
  if (under === parent) return "The page is already there.";
  if (under === id || under.startsWith(`${id}/`)) return "A page cannot go under itself.";
  const reason = oneLine(input.reason);
  if (!reason) return "Say in one line why, for the user.";
  const key = keyOf("move", id, under);
  const before = sameAsBefore(world, key);
  if (before) return before;
  insertSuggestion(world, { page: id, kind: "move", find: null, replace: null, under, reason: reason.slice(0, 300), sources: under ? [{ page: under, label: titleOf(under) }] : [], key });
  return `Suggested moving [[${id}]]; it waits there for the user.`;
}

/** A fact about the user from outside the notes (a conversation, a mail, the calendar): asked first, on the page
 * about them, never written straight in. */
export function suggestRemember(world: World, library: Library, input: { fact: string; from: string }, locale: Locale): string {
  const fact = oneLine(input.fact);
  const from = oneLine(input.from).slice(0, 120);
  if (!fact || !from) return "Give the fact and where it came from.";
  const id = aboutId(locale);
  const read = library.read(id);
  if (read && readKept(read.text).lines.some((line) => alike(line.text, fact) >= 0.8)) return "That is already on the page.";
  if (isRejected(rejectsOf(world, id), fact, [])) return "The user removed that before; leave it.";
  const key = keyOf("remember", plainWords(fact));
  const before = sameAsBefore(world, key);
  if (before) return before;
  const label = locale === "zh" ? `来自${from}` : `from ${from}`;
  insertSuggestion(world, { page: id, kind: "remember", find: null, replace: fact.slice(0, 300), under: null, reason: label, sources: [{ page: null, label }], key });
  return `Asked the user whether to remember it; it waits on the page “${ABOUT[locale]}”.`;
}

/** The suggestions waiting for the user, on one page or on all. An edit whose words are no longer in its page is not
 * shown: it no longer fits. */
export function openSuggestions(world: World, library: Library, page?: string): Suggestion[] {
  const rows = page
    ? world.db.prepare("SELECT * FROM note_suggestions WHERE state = 'open' AND page = ? ORDER BY at").all(page)
    : world.db.prepare("SELECT * FROM note_suggestions WHERE state = 'open' ORDER BY at").all();
  const texts = new Map<string, string | null>();
  const text = (id: string) => {
    if (!texts.has(id)) { try { texts.set(id, library.read(id)?.text ?? null); } catch { texts.set(id, null); } }
    return texts.get(id)!;
  };
  return rows.map(toSuggestion).filter((one) => one.kind === "remember" || (text(one.page) !== null && (one.kind !== "edit" || text(one.page)!.includes(one.find!))));
}

export type DecideAnswer = { ok: true; id: string; entry: string | null } | { ok: false; reason: "gone" | "stale" | "edited" | "changed"; message?: string };

/** The user's yes or no to a suggestion. A yes does exactly what was shown, and the page's history says so. */
export function decideSuggestion(world: World, library: Library, id: string, accept: boolean, locale: Locale): DecideAnswer {
  const row = world.db.prepare("SELECT * FROM note_suggestions WHERE id = ? AND state = 'open'").get(id);
  if (!row) return { ok: false, reason: "gone" };
  const suggestion = toSuggestion(row);
  const close = (state: "accepted" | "declined" | "stale") => world.tx(() => {
    world.db.prepare("UPDATE note_suggestions SET state = ?, decided_at = ? WHERE id = ?").run(state, new Date().toISOString(), id);
    recordDomainEvent(world, { kind: `note.suggestion_${state}`, subject: `note:${suggestion.page}`, payload: { page: suggestion.page, id } });
  });
  if (!accept) { close("declined"); return { ok: true, id: suggestion.page, entry: null }; }
  switch (suggestion.kind) {
    case "edit": {
      const read = library.read(suggestion.page);
      if (!read) { close("stale"); return { ok: false, reason: "stale" }; }
      const at = read.text.indexOf(suggestion.find!);
      if (at === -1 || read.text.indexOf(suggestion.find!, at + 1) !== -1) { close("stale"); return { ok: false, reason: "stale" }; }
      const text = read.text.slice(0, at) + suggestion.replace! + read.text.slice(at + suggestion.find!.length);
      const saved = library.save(suggestion.page, read.fp, text);
      if (!saved.ok) return { ok: false, reason: "changed" };
      let entry: string | null = null;
      world.tx(() => {
        indexOne(world, library, suggestion.page);
        entry = recordEdit(world, suggestion.page, read.text, text, "user", "suggestion.accepted", { suggestion: id });
      });
      close("accepted");
      return { ok: true, id: suggestion.page, entry };
    }
    case "move": {
      let moved: { id: string };
      try { moved = movePage(world, library, { id: suggestion.page, parent: suggestion.under || null }); } catch (error) {
        if (error instanceof LibraryError) { close("stale"); return { ok: false, reason: "stale", message: error.message }; }
        throw error;
      }
      const entry = world.db.prepare("SELECT id FROM note_history WHERE page = ? AND kind = 'rename' ORDER BY at DESC, rowid DESC LIMIT 1").get(moved.id)?.id as string | undefined;
      close("accepted");
      return { ok: true, id: moved.id, entry: entry ?? null };
    }
    case "remember": {
      const about = aboutId(locale);
      const read = library.read(about);
      if (read && keptRow(world, about)?.fp !== read.fp) return { ok: false, reason: "edited" };
      const page = read ? readKept(read.text) : null;
      const sections = (page?.sections ?? []).map((section) => ({ heading: section.heading, lines: section.lines.map((line) => ({ text: line.text, sources: line.sources })) }));
      if (!sections.length) sections.push({ heading: null, lines: [] });
      sections[sections.length - 1].lines.push({ text: suggestion.replace!, sources: suggestion.sources.map((source) => ({ target: null, label: source.label })) });
      const text = composeKept({ icon: page?.props.icon || "person", sections }, locale);
      const answer = writeKept(world, library, about, read, text, { actor: "user", why: "suggestion.accepted", extra: { suggestion: id } }, { lines: 0, unsourced: 0, removed: 0 });
      if (!answer.ok) return { ok: false, reason: "edited" };
      close("accepted");
      return { ok: true, id: about, entry: answer.entry };
    }
  }
}
