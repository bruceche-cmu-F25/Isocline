/** What devices get from the links module (StateResponse.modules.link). No imports, so browser code can use them.
 * docs/design/links.md has the words: a place is an address you keep going to; a clip is something you saved. */

/** What a saved thing is, told from its address (url.ts); never asked of a model. */
export const LINK_TYPES = ["video", "article", "post", "repo", "doc"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

/** The user's own view of a clip. `todo`: they mean to act on it. */
export const CLIP_STATES = ["unread", "seen", "todo"] as const;
export type ClipState = (typeof CLIP_STATES)[number];

/** An address the user keeps going to: a tile on top of the page. Not read, not filed. */
export interface Place {
  id: string;
  title: string;
  url: string;
  folderId?: string;
  /** Order within its folder or among the top-level places and folders. */
  position?: number;
  /** The site's own icon is kept: its name under the module's files (`/api/modules/link/files/<icon>`). */
  icon?: string;
}

export interface PlaceFolder {
  id: string;
  title: string;
  position: number;
}

/** Something the user saved: a video, an article, a post. */
export interface Clip {
  id: string;
  url: string;
  /** The page's own title; until it is fetched, a name made from the address. */
  title: string;
  /** Where the title came from: the user or Alfred gave it, the page or a platform share named it, or it is derived from the address. */
  titleSource: "given" | "page" | "share" | "url";
  /** A known platform (`youtube`, `bilibili`, `xiaohongshu`, `github`…), or `web`. */
  platform: string;
  type: LinkType;
  /** The site's name for itself, else its host. */
  site: string;
  author?: string;
  /** The page's own description of itself (its words, not a summary). */
  description?: string;
  /** Why it was saved, in the user's words. */
  note?: string;
  topicId?: string;
  state: ClipState;
  savedAt: string;
  /** Looking the page up: waiting, done, or why it could not be. */
  fetch: "pending" | "done" | "failed";
  /** Why not, as a short code: `login` (behind a sign-in), `status` (the site said no), `timeout`, `network`,
   * `not_html`, `private`, `redirects`, `unsupported`. */
  fetchError?: string;
  /** The site's own icon is kept: its name under the module's files. */
  icon?: string;
  /** Cached video thumbnail, served by the home node through the module files route. */
  cover?: string;
  /** Playback time when published by the source. */
  durationSeconds?: number;
  /** Alfred saved or last changed it (from the event log). */
  byAlfred?: boolean;
}

/** What a clip is about. A topic sits in one of the shared areas, whose colour it takes. */
export interface Topic {
  id: string;
  name: string;
  /** An area id from the core (work, life…), when it has one. */
  area?: string;
}

export interface LinksSnapshot {
  /** This home node accepts a separate sharedTitle on link.save; older nodes accept the original share caption in note. */
  sharedTitles?: true;
  places: Place[];
  folders?: PlaceFolder[];
  /** Newest first. */
  clips: Clip[];
  topics: Topic[];
}

/** The operations a device may ask of this module (POST /api/ops/<name>), as the module defines them. A test on the
 * home node checks this list against the module's own, so a device cannot name one that is not there. */
export const LINK_OPS = ["link.save", "link.update", "link.remove", "link.refetch", "link.pin", "link.rename", "link.ungroup", "link.group", "link.move", "link.order", "link.topic"] as const;
export type LinkOp = (typeof LINK_OPS)[number];
