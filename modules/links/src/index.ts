/** The links module (docs/design/links.md): the places the user keeps going to, and what they saved from the
 * internet, filed by topic. L1: saving looks the page up for its title and what it says about itself; reading the
 * page and writing a summary come later.
 */
import { acceptLanguage, describeAreas, lastChangesOf, userLocale, type World, defineModule, defineOp, defineTool, Type, type ZirmaModule } from "@zirma/module-kit";
import {
  ensureTopic, formatClip, getIcon, groupPlaces, hostOf, iconsToFetch, listClips, listFolders, listPlaces, listTopics, MIGRATIONS, movePlace, noteIcons, orderPlaces, pendingClips, pinPlace,
  moveTopicsOutOfArea, recordIcon, recordPage, recordPageFailure, refetchClip, removeLink, removeTopic, renamePlace, saveClip, ungroupPlaces, updateClip, updateTopic,
  importLinks, mergeTopic, undoImport, updatePlace,
} from "./domain.ts";
import { IMPORT_CHUNK } from "./bookmarks.ts";
import { topicPath, topicTree, under, type TopicTree } from "./tree.ts";
import { getCover, largeCovers, pendingCovers, recordCover, replaceCover } from "./covers.ts";
import { fetchCover, fetchIcon, shrinkCover, fetchPage, PageFetchError, type IconFetcher, type PageFetcher, type PageInfo } from "./fetch.ts";
import { CLIP_STATES, type LinksSnapshot } from "./types.ts";

export * from "./domain.ts";
export * from "./types.ts";
export * from "./tree.ts";
export * from "./bookmarks.ts";
export { classify, findUrl, isShortener, LinkUrlError, nameFromUrl, normalizeUrl, parseLinkPaste, tidyTitle } from "./url.ts";
export {
  decodeEntities, fetchIcon, fetchPage, imageType, isPublicAddress, looksLikeWall, PageFetchError, readHead,
  type IconFetcher, type PageFetcher, type PageInfo, type SiteIcon,
} from "./fetch.ts";

const failed = (result: object): result is { error: string } => "error" in result;
const State = Type.Union(CLIP_STATES.map((state) => Type.Literal(state)));
const AreaField = Type.Optional(Type.String({ description: "For a NEW topic: the id of the user's area it sits in (your instructions list them)." }));
const UnderField = Type.Optional(Type.String({ maxLength: 130, description: "For a NEW topic: an existing topic to put it under (its name or path, e.g. \"Learning/Roadmaps\"); at most two levels" }));

/** A topic named by the model: a path ("Learning/Roadmaps" or "Learning › Roadmaps", from the top of the area down)
 * or a plain name. */
function findTopic(tree: TopicTree, said: string): string | undefined {
  const parts = said.split(/\s*(?:›|\/|>)\s*/).map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return undefined;
  const all = [...tree.byId.values()];
  const exact = all.find((topic) => topicPath(tree, topic.id, undefined, "/").toLowerCase() === parts.join("/"));
  if (exact) return exact.id;
  // The area may lead the path too; then only the end is a topic's.
  const tail = all.filter((topic) => topicPath(tree, topic.id, undefined, "/").toLowerCase().endsWith(parts.slice(-2).join("/")));
  if (parts.length > 1 && tail.length === 1) return tail[0].id;
  return all.find((topic) => topic.name.toLowerCase() === parts[parts.length - 1])?.id;
}
/** Where the model asked to file something: an existing topic by name or path, or a new one under `under` or in `area`.
 * A string answer is a problem to tell the model. */
function fileUnder(world: World, params: { topic?: string; area?: string; under?: string }): string | { topicId?: string; topic?: string; area?: string; parentId?: string } {
  if (params.topic === undefined) return {};
  if (!params.topic.trim()) return { topicId: "" };
  const tree = topicTree(listTopics(world));
  const found = findTopic(tree, params.topic);
  if (found) return { topicId: found };
  const name = params.topic.split(/\s*(?:›|\/|>)\s*/).filter(Boolean).pop() ?? params.topic;
  if (params.under) {
    const parentId = findTopic(tree, params.under);
    if (!parentId) return `No topic "${params.under}" to put it under.`;
    return { topic: name, parentId };
  }
  return { topic: name, ...(params.area ? { area: params.area } : {}) };
}

const ImportEntryShape = Type.Object({
  url: Type.String({ minLength: 1, maxLength: 2100 }), title: Type.String({ maxLength: 400 }), kind: Type.Union([Type.Literal("place"), Type.Literal("clip")]),
  path: Type.Optional(Type.Array(Type.String({ maxLength: 120 }), { maxItems: 4 })), area: Type.Optional(Type.String({ maxLength: 64 })),
}, { additionalProperties: false });

const SAY = {
  zh: { remove: (title: string) => `永久删除链接「${title}」？删除后不能恢复。` },
  en: { remove: (title: string) => `Delete the link “${title}” for good? This can't be undone.` },
};

function snapshot(world: World): LinksSnapshot {
  const clips = listClips(world);
  const changes = lastChangesOf(world, clips.map((clip) => `link:${clip.id}`));
  return {
    sharedTitles: true,
    places: listPlaces(world),
    folders: listFolders(world),
    clips: clips.map((clip) => (changes.get(`link:${clip.id}`)?.actor === "alfred" ? { ...clip, byZirma: true } : clip)),
    topics: listTopics(world),
  };
}

/** Looks up the pages of clips that have not been looked up yet. One at a time: this is a handful of pages a day,
 * and being gentle with other people's sites costs nothing. */
function lookUp(fetcher: PageFetcher, icons: IconFetcher, covers: typeof fetchCover) {
  const shrunk = new Set<string>();
  return async (world: World, _services: unknown, signal: AbortSignal): Promise<void> => {
    /** The icons each page named, by host, for the icon step below. */
    const named = new Map<string, string[]>();
    const pages = new Map<string, PageInfo>();
    // A site is asked for its title in the user's language, as their own browser would.
    const language = acceptLanguage(userLocale(world));
    for (const clip of pendingClips(world)) {
      if (signal.aborted) return;
      try {
        const page = await fetcher(clip.url, signal, language);
        if (page.icons?.length) named.set(hostOf(page.url), page.icons);
        pages.set(clip.id, page);
        recordPage(world, clip.id, page);
      } catch (error) {
        if (signal.aborted) return;
        // What is kept is why, as a short code a device words in the user's language; the site's own words are not.
        const code = error instanceof PageFetchError ? error.code : "network";
        recordPageFailure(world, clip.id, code, code === "timeout" || code === "network");
      }
    }
    for (const clip of pendingCovers(world)) {
      if (signal.aborted) return;
      let page = pages.get(clip.id);
      // Existing videos predate the cache. Backfill just their covers, keeping saved metadata and reading state.
      if (!page) {
        try { page = await fetcher(clip.url, signal, language); } catch { /* try again after the cache interval */ }
      }
      const cover = page?.cover && !signal.aborted ? await covers(page.cover, signal).catch(() => null) : null;
      if (signal.aborted) return;
      recordCover(world, clip.id, cover, page?.durationSeconds);
    }
    // Covers kept before they were shrunk: shrunk where they are, a few each time, nothing fetched again.
    for (const { id, cover } of largeCovers(world, shrunk)) {
      if (signal.aborted) return;
      shrunk.add(id);
      replaceCover(world, id, await shrinkCover(cover));
    }
    // Then each site's own icon, once per host: the ones its page named, else a look at the page, else /favicon.ico.
    let found = 0;
    for (const { host, url } of iconsToFetch(world)) {
      if (signal.aborted) return;
      let candidates = named.get(host);
      if (!candidates) {
        try { candidates = (await fetcher(url, signal)).icons ?? []; } catch { candidates = []; }
      }
      if (signal.aborted) return;
      const icon = await icons(url, candidates, signal).catch(() => null);
      recordIcon(world, host, icon);
      if (icon) found++;
    }
    if (found) noteIcons(world, found);
  };
}

/** `fetcher`, `icons`: how a page and a site's icon are looked up; the real ones unless a test passes its own. */
export function createLinksModule(options: { fetcher?: PageFetcher; icons?: IconFetcher; covers?: typeof fetchCover } = {}): ZirmaModule {
  return defineModule({
    id: "link",
    title: "Links",
    migrations: MIGRATIONS,
    snapshot,
    views: [{ id: "list", title: "Links" }],
    guidance: (world) => [
      "Links: the user's places (sites they visit; pinned ones are tiles on top) and clips (things they saved from the internet: a video, an article, a post), filed in a tree of categories (topics): each area holds topics, and a topic may hold topics of its own, two levels at most.",
      "When the user gives you an address to keep, or says to save something they are looking at, use link_save, with their reason as the note in their own words. File it under the most specific of their topics that fits (link_list with tree: true shows the tree); name a new topic, with its area or the topic to put it under, only when none fits. Leave the topic out when unsure.",
      "Use link_pin only for a site they want at hand every day (\"pin Canvas\"), not for something to read or watch.",
      "You have not read a saved page: its title and description are the page's own words. Do not describe what a clip says beyond them.",
      `A topic's area is one of the user's areas (id and name): ${describeAreas(world)}.`,
    ].join("\n"),
    areaRemoved: (world, id, moveTo) => { moveTopicsOutOfArea(world, id, moveTo); },
    sync: { everyMs: 5 * 60_000, onEvents: ["link.saved", "link.refetch", "link.pinned", "link.imported"], run: lookUp(options.fetcher ?? ((url, signal, language) => fetchPage(url, signal, undefined, language)), options.icons ?? fetchIcon, options.covers ?? fetchCover) },
    // Both covers and site icons are served locally through module files.
    file: (world, name) => /^cover_[\w-]+$/.test(name) ? getCover(world, name.slice(6)) : getIcon(world, name),

    ops: [
      defineOp({
        name: "link.save",
        input: Type.Object({
          url: Type.String({ minLength: 1, maxLength: 2100 }), title: Type.Optional(Type.String({ maxLength: 300 })), sharedTitle: Type.Optional(Type.String({ maxLength: 300 })), note: Type.Optional(Type.String({ maxLength: 500 })),
          topicId: Type.Optional(Type.String()), topic: Type.Optional(Type.String({ maxLength: 60 })), area: Type.Optional(Type.String()), parentId: Type.Optional(Type.String()),
        }),
        run: (world, input) => saveClip(world, input),
      }),
      defineOp({
        name: "link.update",
        input: Type.Object({
          id: Type.String(),
          patch: Type.Object({
            title: Type.Optional(Type.String({ maxLength: 300 })), note: Type.Optional(Type.String({ maxLength: 500 })), topicId: Type.Optional(Type.String()),
            topic: Type.Optional(Type.String({ maxLength: 60 })), area: Type.Optional(Type.String()), parentId: Type.Optional(Type.String()), state: Type.Optional(State),
          }, { additionalProperties: false }),
        }),
        run: (world, input) => updateClip(world, input.id, input.patch),
      }),
      defineOp({ name: "link.remove", input: Type.Object({ id: Type.String() }), run: (world, input) => removeLink(world, input.id) }),
      defineOp({ name: "link.refetch", input: Type.Object({ id: Type.String() }), run: (world, input) => refetchClip(world, input.id) }),
      defineOp({
        name: "link.pin", input: Type.Object({ url: Type.String({ minLength: 1, maxLength: 2100 }), title: Type.Optional(Type.String({ maxLength: 60 })) }),
        run: (world, input) => pinPlace(world, input),
      }),
      defineOp({ name: "link.rename", input: Type.Object({ id: Type.String(), title: Type.String({ maxLength: 60 }) }), run: (world, input) => renamePlace(world, input.id, input.title) }),
      defineOp({ name: "link.ungroup", input: Type.Object({ id: Type.String() }), run: (world, input) => ungroupPlaces(world, input.id) }),
      defineOp({
        name: "link.group", input: Type.Object({ id: Type.String(), targetId: Type.String(), title: Type.String({ minLength: 1, maxLength: 60 }) }),
        run: (world, input) => groupPlaces(world, input),
      }),
      defineOp({
        name: "link.move", input: Type.Object({ id: Type.String(), folderId: Type.Optional(Type.String()), beforeId: Type.Optional(Type.String()) }),
        run: (world, input) => movePlace(world, input),
      }),
      defineOp({ name: "link.order", input: Type.Object({ ids: Type.Array(Type.String(), { maxItems: 200 }) }), run: (world, input) => orderPlaces(world, input.ids) }),
      defineOp({
        name: "link.topic", input: Type.Object({
          id: Type.Optional(Type.String()), name: Type.Optional(Type.String({ maxLength: 60 })), area: Type.Optional(Type.String()),
          parentId: Type.Optional(Type.String()), remove: Type.Optional(Type.Boolean()),
        }),
        // One op for a topic: with no id it is made (or found by name) at the top of an area or under `parentId`; with
        // one it is renamed, moved to an area or under another topic (`parentId`, empty for the top), or removed.
        run: (world, input) => {
          if (!input.id) return ensureTopic(world, { name: input.name ?? "", area: input.area, parentId: input.parentId });
          return input.remove ? removeTopic(world, input.id) : updateTopic(world, input.id, { name: input.name, area: input.area, parentId: input.parentId });
        },
      }),
      defineOp({ name: "link.merge", input: Type.Object({ id: Type.String(), into: Type.String() }), run: (world, input) => mergeTopic(world, input.id, input.into) }),
      defineOp({
        name: "link.place", input: Type.Object({ id: Type.String(), topicId: Type.Optional(Type.String()), pinned: Type.Optional(Type.Boolean()) }),
        run: (world, input) => updatePlace(world, input.id, input),
      }),
      defineOp({
        name: "link.import", input: Type.Object({ importId: Type.String({ maxLength: 64 }), entries: Type.Array(ImportEntryShape, { maxItems: IMPORT_CHUNK * 2 }) }),
        run: (world, input) => importLinks(world, input),
      }),
      defineOp({ name: "link.import_undo", input: Type.Object({ importId: Type.String({ maxLength: 64 }) }), run: (world, input) => undoImport(world, input.importId) }),
    ],

    tools: [
      defineTool({
        name: "link_list", label: "Links", level: "read",
        description: "The user's links: their pinned places, their category tree, and what they saved, newest first, with ids. Narrow with words (titles, notes, sites, addresses), a topic (its name or path; everything under it counts), or a state. With tree: true, only the categories and how much is in each.",
        parameters: Type.Object({
          search: Type.Optional(Type.String({ maxLength: 120, description: "Words in a title, note, description, site, address or category" })),
          topic: Type.Optional(Type.String({ maxLength: 130, description: "A topic's name or path, e.g. \"Learning/Roadmaps\"" })),
          state: Type.Optional(State),
          tree: Type.Optional(Type.Boolean({ description: "Only the category tree with counts" })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "How many links, 30 if left out" })),
        }),
        describe: (_world, params) => [params.search, params.topic, params.state, params.tree ? "tree" : ""].filter(Boolean).join(" · "),
        execute(world, params) {
          const topics = listTopics(world);
          const tree = topicTree(topics);
          const places = listPlaces(world);
          const clips = listClips(world);
          const filed = [...places, ...clips];
          const pathOf = (id: string | undefined) => topicPath(tree, id, undefined, "/");
          const count = (node: string) => { const set = under(tree, node); return filed.filter((item) => item.topicId && set.has(item.topicId)).length; };
          const lines = (node: string, depth: number): string[] => (tree.children.get(node) ?? [])
            .flatMap((topic) => [`${"  ".repeat(depth)}- ${topic.name} (${topic.id}) ${count(topic.id)}`, ...lines(topic.id, depth + 1)]);
          const areaIds = [...new Set(topics.map((topic) => topic.area ?? ""))];
          const treeText = areaIds.map((area) => [`${area ? `[${area}]` : "[no area]"}`, ...lines(`area:${area}`, 1)].join("\n")).join("\n");
          if (params.tree) return `Categories (topic (id) count):\n${treeText || "none yet"}\nUnfiled: ${filed.filter((item) => !item.topicId).length}.`;
          let scope: Set<string> | undefined;
          if (params.topic) {
            const id = findTopic(tree, params.topic);
            if (!id) return `No topic "${params.topic}". Categories:\n${treeText || "none yet"}`;
            scope = under(tree, id);
          }
          const words = (params.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
          const folders = new Map(listFolders(world).map((folder) => [folder.id, folder.title]));
          const hit = (hay: string) => words.every((word) => hay.toLowerCase().includes(word));
          const inScope = (topicId: string | undefined) => !scope || (!!topicId && scope.has(topicId));
          const shownPlaces = places.filter((place) => inScope(place.topicId) && !params.state && hit([place.title, place.url, folders.get(place.folderId ?? ""), pathOf(place.topicId)].join(" ")));
          const matched = clips.filter((clip) => inScope(clip.topicId) && (!params.state || clip.state === params.state)
            && hit([clip.title, clip.note, clip.description, clip.site, clip.author, clip.url, pathOf(clip.topicId)].filter(Boolean).join(" ")));
          const limit = params.limit ?? 30;
          const shown = matched.slice(0, limit);
          const place = (item: (typeof places)[number]) => `${item.id}  ${item.title} | site${item.unpinned ? "" : ", pinned"}${item.folderId ? ` in ${folders.get(item.folderId)}` : ""} | ${item.topicId ? `topic: ${pathOf(item.topicId)}` : "no topic"} | ${item.url}`;
          return [
            ...(scope || words.length ? [] : [`Categories:\n${treeText || "none yet"}`]),
            shownPlaces.length ? `Places (${Math.min(shownPlaces.length, limit)}${shownPlaces.length > limit ? ` of ${shownPlaces.length}` : ""}):` : "No places match.",
            ...shownPlaces.slice(0, limit).map(place),
            matched.length ? `Clips (${shown.length}${matched.length > shown.length ? ` of ${matched.length}` : ""}):` : "No clips match.",
            ...shown.map((clip) => formatClip(clip, topics)),
          ].join("\n");
        },
      }),
      defineTool({
        name: "link_save", label: "Save link", level: "local",
        description: "Save a web address as a clip on the user's Links page: a video, an article, a post they want to keep. Its page is looked up for a title afterwards. Saving the same address again adds nothing.",
        parameters: Type.Object({
          url: Type.String({ maxLength: 2100, description: "The address. A bare host like example.com/x is fine." }),
          note: Type.Optional(Type.String({ maxLength: 500, description: "Why the user saved it, in their own words" })),
          topic: Type.Optional(Type.String({ maxLength: 130, description: "The topic to file it under: one of the user's topics by name or path, or a new short name" })),
          area: AreaField,
          under: UnderField,
          title: Type.Optional(Type.String({ maxLength: 300, description: "Only when the user told you what to call it" })),
        }),
        describe: (_world, params) => params.url,
        execute(world, params) {
          const where = fileUnder(world, params);
          if (typeof where === "string") return where;
          const { under: _under, topic: _topic, ...rest } = params;
          const result = saveClip(world, { ...rest, ...where });
          if (failed(result)) return result.error;
          return `${result.existing ? "Already saved" : "Saved"}: ${formatClip(result.clip, listTopics(world))}`;
        },
      }),
      defineTool({
        name: "link_pin", label: "Pin place", level: "local",
        description: "Pin a site to the user's places: the row of tiles on top of the Links page, for addresses they go to every day.",
        parameters: Type.Object({
          url: Type.String({ maxLength: 2100, description: "The address" }),
          title: Type.Optional(Type.String({ maxLength: 60, description: "A short name for the tile, e.g. Canvas" })),
        }),
        describe: (_world, params) => params.title ?? params.url,
        execute(world, params) {
          const result = pinPlace(world, params);
          if (failed(result)) return result.error;
          return `${result.existing ? "Already pinned" : "Pinned"}: ${result.place.title} (${result.place.id}) ${result.place.url}`;
        },
      }),
      defineTool({
        name: "link_update", label: "Update link", level: "local",
        description: "Change a saved clip or a place: file it under a topic (an empty string unfiles it); for a clip, also its note, title or state (unread, seen or todo). Get its id from link_list.",
        parameters: Type.Object({
          id: Type.String({ description: "The clip's or place's id from link_list" }),
          topic: Type.Optional(Type.String({ maxLength: 130, description: "Topic name or path, existing or new; an empty string unfiles it" })),
          area: AreaField,
          under: UnderField,
          note: Type.Optional(Type.String({ maxLength: 500, description: "Replacement note; an empty string removes it" })),
          newTitle: Type.Optional(Type.String({ maxLength: 300 })),
          state: Type.Optional(State),
        }),
        describe: (world, params) => [...listClips(world), ...listPlaces(world)].find((item) => item.id === params.id)?.title ?? params.id,
        execute(world, params) {
          const { id, newTitle, under: _under, topic: _topic, ...rest } = params;
          const where = params.topic === undefined ? {} : fileUnder(world, params);
          if (typeof where === "string") return where;
          const place = listPlaces(world).find((item) => item.id === id);
          if (place) {
            if (where.topic !== undefined) {
              const made = ensureTopic(world, { name: where.topic, area: where.area, parentId: where.parentId });
              if (failed(made)) return made.error;
              where.topicId = made.id;
            }
            const result = updatePlace(world, id, { ...(where.topicId !== undefined ? { topicId: where.topicId } : {}) });
            return failed(result) ? result.error : `Updated: ${result.title} | ${result.topicId ? `topic: ${topicPath(topicTree(listTopics(world)), result.topicId, undefined, "/")}` : "no topic"}`;
          }
          const result = updateClip(world, id, { ...rest, ...where, ...(newTitle !== undefined ? { title: newTitle } : {}) });
          return failed(result) ? result.error : `Updated: ${formatClip(result, listTopics(world))}`;
        },
      }),
      defineTool({
        name: "link_remove", label: "Delete link", level: "irreversible",
        description: "Permanently delete a clip or a place. The user is asked to allow each deletion; use it only when they asked to delete or remove it.",
        parameters: Type.Object({ id: Type.String({ description: "The clip's or place's id from link_list" }) }),
        describe: (world, params) => [...listClips(world), ...listPlaces(world)].find((item) => item.id === params.id)?.title ?? params.id,
        confirm: (world, params) => SAY[userLocale(world)].remove([...listClips(world), ...listPlaces(world)].find((item) => item.id === params.id)?.title ?? params.id),
        execute(world, params) {
          const result = removeLink(world, params.id);
          return failed(result) ? result.error : `Deleted "${result.title}".`;
        },
      }),
    ],
  });
}

export const linksModule = createLinksModule();
