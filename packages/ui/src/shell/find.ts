/** What typing can go to, in the ask bar and in ⌘K's palette: a page, a command, a conversation. One list for both,
 * so searching is the same wherever it is done. */
import type { Conversation } from "@alfred/protocol";
import type { LinksSnapshot } from "@alfred/module-links/types";
import { t } from "../i18n/dict.ts";
import type { IconName } from "./icons.tsx";

export interface FindCommand { id: string; label: string; icon: IconName; hint?: string; run(): void }
export interface FindItem extends FindCommand { unread?: boolean; kind: "page" | "command" | "conversation" | "place" | "folder" }
export interface FindSources {
  pages: ReadonlyArray<{ key: string; title: string; icon: IconName }>;
  /** Extra commands, e.g. "new conversation", "close Alfred". */
  commands: readonly FindCommand[];
  conversations: ReadonlyArray<Pick<Conversation, "id" | "title" | "unreadReplyId" | "briefOnly">>;
  links?: Pick<LinksSnapshot, "places" | "folders">;
  onFolder?(id: string): void;
  onPlace?(url: string): void;
  onPage(key: string): void;
  onSelect(id: string): void;
}

/** Everything whose name contains the words, pages first, then commands, then conversations (the newest few). With
 * no words: all pages and commands, and the last conversations. */
export function findItems(query: string, { pages, commands, conversations, links, onFolder, onPlace, onPage, onSelect }: FindSources): FindItem[] {
  const q = query.trim().toLowerCase();
  const match = (text: string) => !q || text.toLowerCase().includes(q);
  return [
    ...pages.filter((page) => match(page.title)).map((page, n) => ({
      kind: "page" as const, id: `page:${page.key}`, label: t("pal.go", { title: page.title }), icon: page.icon, hint: n < 9 ? `⌥${n + 1}` : undefined, run: () => onPage(page.key),
    })),
    ...commands.filter((command) => match(command.label)).map((command) => ({ ...command, kind: "command" as const })),
    ...findPlaces(q, links, onFolder, onPlace),
    ...conversations.filter((conversation) => !conversation.briefOnly && match(conversation.title)).slice(0, q ? 8 : 5).map((conversation) => ({
      kind: "conversation" as const, id: `conv:${conversation.id}`, label: conversation.title, unread: !!conversation.unreadReplyId, icon: "chat" as const, hint: t("pal.conversation"), run: () => onSelect(conversation.id),
    })),
  ];
}

/** The same site stays reachable under its name or address after moving into a folder. */
function findPlaces(query: string, links: FindSources["links"], onFolder: FindSources["onFolder"], onPlace: FindSources["onPlace"]): FindItem[] {
  if (!query || !links || !onFolder || !onPlace) return [];
  const folders = new Map(links.folders?.map((folder) => [folder.id, folder.title]));
  const section = t("links.places");
  const words = query.split(/\s+/);
  const results: Array<{ rank: number; item: FindItem }> = [];
  for (const [id, title] of folders) {
    const lower = title.toLowerCase();
    if (words.every((word) => lower.includes(word))) {
      results.push({ rank: lower === query ? 0 : 2, item: { kind: "folder", id: `folder:${id}`, label: `${title} · ${section}`, icon: "folder", run: () => onFolder(id) } });
    }
  }
  for (const place of links.places) {
    const folder = place.folderId && folders.get(place.folderId);
    const name = place.title.toLowerCase();
    const address = place.url.toLowerCase();
    const text = [name, address, folder?.toLowerCase()].join(" ");
    if (!words.every((word) => text.includes(word))) continue;
    const rank = name === query ? 0 : name.includes(query) ? 1 : address.includes(query) ? 3 : 4;
    const path = folder ? `${section} › ${folder}` : section;
    results.push({ rank, item: { kind: "place", id: `place:${place.id}`, label: `${place.title} · ${path}`, icon: "globe", run: () => onPlace(place.url) } });
  }
  return results.sort((a, b) => a.rank - b.rank).map(({ item }) => item);
}

/** In the ask bar, what Enter does with the words when nothing was picked by hand: it goes to the first page or
 * command whose name contains all of them, and otherwise says them to Alfred (-1). A conversation is never the
 * default: its title is usually a question once asked, and asking that again must not open the old one instead. */
export function defaultPick(items: readonly FindItem[]): number {
  return items.findIndex((item) => item.kind !== "conversation");
}
