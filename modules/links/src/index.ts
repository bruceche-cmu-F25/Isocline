/** The links module (docs/design/links.md): the places the user keeps going to, and what they saved from the
 * internet, filed by topic. L1: saving looks the page up for its title and what it says about itself; reading the
 * page and writing a summary come later.
 */
import { acceptLanguage, describeAreas, lastChangesOf, userLocale, type World, defineModule, defineOp, defineTool, Type, type IsoclineModule } from "@isocline/module-kit";
import {
  ensureTopic, formatClip, getIcon, groupPlaces, hostOf, iconsToFetch, listClips, listFolders, listPlaces, listTopics, MIGRATIONS, movePlace, noteIcons, orderPlaces, pendingClips, pinPlace,
  moveTopicsOutOfArea, recordIcon, recordPage, recordPageFailure, refetchClip, removeLink, removeTopic, renamePlace, saveClip, ungroupPlaces, updateClip, updateTopic,
} from "./domain.ts";
import { getCover, largeCovers, pendingCovers, recordCover, replaceCover } from "./covers.ts";
import { fetchCover, fetchIcon, shrinkCover, fetchPage, PageFetchError, type IconFetcher, type PageFetcher, type PageInfo } from "./fetch.ts";
import { CLIP_STATES, type LinksSnapshot } from "./types.ts";

export * from "./domain.ts";
export * from "./types.ts";
export { classify, findUrl, isShortener, LinkUrlError, nameFromUrl, normalizeUrl, parseLinkPaste } from "./url.ts";
export {
  decodeEntities, fetchIcon, fetchPage, imageType, isPublicAddress, looksLikeWall, PageFetchError, readHead,
  type IconFetcher, type PageFetcher, type PageInfo, type SiteIcon,
} from "./fetch.ts";

const failed = (result: object): result is { error: string } => "error" in result;
const State = Type.Union(CLIP_STATES.map((state) => Type.Literal(state)));
const AreaField = Type.Optional(Type.String({ description: "For a NEW topic: the id of the user's area it sits in (your instructions list them)." }));

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
    clips: clips.map((clip) => (changes.get(`link:${clip.id}`)?.actor === "alfred" ? { ...clip, byIsocline: true } : clip)),
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
export function createLinksModule(options: { fetcher?: PageFetcher; icons?: IconFetcher; covers?: typeof fetchCover } = {}): IsoclineModule {
  return defineModule({
    id: "link",
    title: "Links",
    migrations: MIGRATIONS,
    snapshot,
    views: [{ id: "list", title: "Links" }],
    guidance: (world) => [
      "Links: the user's places (addresses they keep going to, shown as tiles) and clips (things they saved from the internet: a video, an article, a post), filed by topic.",
      "When the user gives you an address to keep, or says to save something they are looking at, use link_save, with their reason as the note in their own words. File it under one of their topics when one fits (link_list shows them); name a new topic, with its area, only when none does. Leave the topic out when unsure.",
      "Use link_pin only for a site they want at hand every day (\"pin Canvas\"), not for something to read or watch.",
      "You have not read a saved page: its title and description are the page's own words. Do not describe what a clip says beyond them.",
      `A topic's area is one of the user's areas (id and name): ${describeAreas(world)}.`,
    ].join("\n"),
    areaRemoved: (world, id, moveTo) => { moveTopicsOutOfArea(world, id, moveTo); },
    sync: { everyMs: 5 * 60_000, onEvents: ["link.saved", "link.refetch", "link.pinned"], run: lookUp(options.fetcher ?? ((url, signal, language) => fetchPage(url, signal, undefined, language)), options.icons ?? fetchIcon, options.covers ?? fetchCover) },
    // Both covers and site icons are served locally through module files.
    file: (world, name) => /^cover_[\w-]+$/.test(name) ? getCover(world, name.slice(6)) : getIcon(world, name),

    ops: [
      defineOp({
        name: "link.save",
        input: Type.Object({
          url: Type.String({ minLength: 1, maxLength: 2100 }), title: Type.Optional(Type.String({ maxLength: 300 })), sharedTitle: Type.Optional(Type.String({ maxLength: 300 })), note: Type.Optional(Type.String({ maxLength: 500 })),
          topicId: Type.Optional(Type.String()), topic: Type.Optional(Type.String({ maxLength: 60 })), area: Type.Optional(Type.String()),
        }),
        run: (world, input) => saveClip(world, input),
      }),
      defineOp({
        name: "link.update",
        input: Type.Object({
          id: Type.String(),
          patch: Type.Object({
            title: Type.Optional(Type.String({ maxLength: 300 })), note: Type.Optional(Type.String({ maxLength: 500 })), topicId: Type.Optional(Type.String()),
            topic: Type.Optional(Type.String({ maxLength: 60 })), area: Type.Optional(Type.String()), state: Type.Optional(State),
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
        name: "link.topic", input: Type.Object({ id: Type.Optional(Type.String()), name: Type.Optional(Type.String({ maxLength: 60 })), area: Type.Optional(Type.String()), remove: Type.Optional(Type.Boolean()) }),
        // One op for a topic: with no id it is made (or found by name); with one it is renamed, moved to an area, or removed.
        run: (world, input) => {
          if (!input.id) return ensureTopic(world, { name: input.name ?? "", area: input.area });
          return input.remove ? removeTopic(world, input.id) : updateTopic(world, input.id, { name: input.name, area: input.area });
        },
      }),
    ],

    tools: [
      defineTool({
        name: "link_list", label: "Links", level: "read",
        description: "The user's links: their places (pinned sites), their topics, and the clips they saved, newest first, with ids. Narrow the clips with words from a title or note, a topic's name, or a state.",
        parameters: Type.Object({
          search: Type.Optional(Type.String({ maxLength: 120, description: "Words in a folder, site name or address, or a clip's title, note, description or site" })),
          topic: Type.Optional(Type.String({ maxLength: 60, description: "A topic's name" })),
          state: Type.Optional(State),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "How many clips, 30 if left out" })),
        }),
        describe: (_world, params) => [params.search, params.topic, params.state].filter(Boolean).join(" · "),
        execute(world, params) {
          const topics = listTopics(world);
          const wanted = params.topic ? topics.find((topic) => topic.name.toLowerCase() === params.topic!.trim().toLowerCase()) : undefined;
          if (params.topic && !wanted) return `No topic named "${params.topic}". Topics: ${topics.map((topic) => topic.name).join(", ") || "none yet"}.`;
          const words = (params.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
          const folders = new Map(listFolders(world).map((folder) => [folder.id, folder.title]));
          const matches = (value: string) => words.every((word) => value.toLowerCase().includes(word));
          const places = listPlaces(world).filter((place) => matches([place.title, place.url, folders.get(place.folderId ?? "")].join(" ")));
          const clips = listClips(world).filter((clip) => {
            if (wanted && clip.topicId !== wanted.id) return false;
            if (params.state && clip.state !== params.state) return false;
            const hay = [clip.title, clip.note, clip.description, clip.site, clip.author].filter(Boolean).join(" ").toLowerCase();
            return words.every((word) => hay.includes(word));
          });
          const shown = clips.slice(0, params.limit ?? 30);
          return [
            `Places: ${places.map((place) => `${place.title} (${place.id})${place.folderId ? ` in ${folders.get(place.folderId)}` : ""}`).join(", ") || "none"}.`,
            ...[...folders].filter(([, title]) => matches(title)).map(([id, title]) => `Folder: ${title} (${id}).`),
            `Topics: ${topics.map((topic) => `${topic.name}${topic.area ? ` [${topic.area}]` : ""}`).join(", ") || "none yet"}.`,
            clips.length ? `Clips (${shown.length}${clips.length > shown.length ? ` of ${clips.length}` : ""}):` : "No clips match.",
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
          topic: Type.Optional(Type.String({ maxLength: 60, description: "The topic to file it under: one of the user's topics by name, or a new short name" })),
          area: AreaField,
          title: Type.Optional(Type.String({ maxLength: 300, description: "Only when the user told you what to call it" })),
        }),
        describe: (_world, params) => params.url,
        execute(world, params) {
          const result = saveClip(world, params);
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
        description: "Change a saved clip: file it under a topic (an empty string unfiles it), change its note or title, or mark it unread, seen or todo. Get its id from link_list.",
        parameters: Type.Object({
          id: Type.String({ description: "The clip's id from link_list" }),
          topic: Type.Optional(Type.String({ maxLength: 60, description: "Topic name, existing or new; an empty string unfiles it" })),
          area: AreaField,
          note: Type.Optional(Type.String({ maxLength: 500, description: "Replacement note; an empty string removes it" })),
          newTitle: Type.Optional(Type.String({ maxLength: 300 })),
          state: Type.Optional(State),
        }),
        describe: (world, params) => listClips(world).find((clip) => clip.id === params.id)?.title ?? params.id,
        execute(world, params) {
          const { id, newTitle, ...rest } = params;
          const result = updateClip(world, id, { ...rest, ...(newTitle !== undefined ? { title: newTitle } : {}) });
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
