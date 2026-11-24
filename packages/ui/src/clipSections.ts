import type { Clip, ClipState, LinkType } from "@isocline/module-links/types";

/** Each matching clip appears once. Two or more unwatched videos become a shelf; one stays with other clips. */
export function clipSections(clips: Clip[], type: LinkType | "all", state: ClipState | "all", now: number) {
  const visible = clips.filter((clip) => (type === "all" || clip.type === type) && (state === "all" || clip.state === state));
  const unwatched = visible.filter((clip) => clip.type === "video" && clip.state === "unread");
  const shelf = unwatched.length >= 2 ? unwatched : [];
  const onShelf = new Set(shelf.map((clip) => clip.id));
  const others = visible.filter((clip) => !onShelf.has(clip.id));
  const recent = others.filter((clip) => clip.fetch === "pending" || (clip.state === "unread" && now - Date.parse(clip.savedAt) < 2 * 86_400_000)).slice(0, 5);
  return { shelf, recent, filed: others.filter((clip) => !recent.includes(clip)) };
}

export function playbackTime(seconds: number): string {
  const two = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? hours + ":" + two(minutes) : minutes}:${two(seconds % 60)}`;
}
