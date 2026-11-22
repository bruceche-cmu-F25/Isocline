import type { Clip } from "@alfred/module-links/types";
import { findUrl, parseLinkPaste, parseShareText } from "@alfred/module-links/url";

/** An older home stores the platform's whole share in note; an upgraded home already separates it. */
export function legacyShareClip(clip: Clip): Clip {
  if (!clip.note) return clip;
  const share = parseShareText(clip.url, clip.note);
  if (!share.title) return clip;
  return {
    ...clip,
    ...(clip.titleSource === "url" ? { title: share.title, titleSource: "share" } : {}),
    note: share.note,
  };
}

export function linkSaveFields(text: string, paste: NonNullable<ReturnType<typeof parseLinkPaste>>, sharedTitles?: true) {
  if (paste.title && !sharedTitles) {
    // Keep the recognizable wrapper for other devices and the home node's subsequent migration.
    return { url: paste.url, note: findUrl(text)!.rest };
  }
  return { url: paste.url, ...(paste.title ? { sharedTitle: paste.title } : {}), ...(paste.note ? { note: paste.note } : {}) };
}
