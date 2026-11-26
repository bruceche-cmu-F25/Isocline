/** The line icons a page can take (notes-two-layers.md 4.2), stored in the page by name (`icon: cup`). One stroke,
 * on the 20 × 20 grid of the other icons; no emoji. */
import type { PageIcon } from "@zirma/module-notes/types";

const PATHS: Record<PageIcon, string> = {
  doc: "M5.5 3.5h6l3 3v10h-9zM11.5 3.5v3h3M8 10.5h4M8 13.5h4",
  book: "M4 4.5h4.5A1.5 1.5 0 0 1 10 6v10a1.5 1.5 0 0 0-1.5-1.5H4zM16 4.5h-4.5A1.5 1.5 0 0 0 10 6v10a1.5 1.5 0 0 1 1.5-1.5H16z",
  cup: "M4.5 7.5h9v4a4 4 0 0 1-4 4h-1a4 4 0 0 1-4-4zM13.5 8.5h1a2 2 0 0 1 0 4h-1M7 3.5v2M10 3.5v2",
  map: "M3.5 5.5l4-1.5 5 1.5 4-1.5v10.5l-4 1.5-5-1.5-4 1.5zM7.5 4v10.5M12.5 5.5V16",
  calendar: "M3.5 4.5h13v12h-13zM3.5 8.5h13M7 3v3M13 3v3",
  person: "M10 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4.5 16.5a5.5 5.5 0 0 1 11 0",
  star: "M10 3.5l2 4.1 4.5.6-3.3 3.1.8 4.5-4-2.2-4 2.2.8-4.5-3.3-3.1 4.5-.6z",
  flag: "M5 16.5v-13M5 4h9l-2 3 2 3H5",
  bulb: "M7.5 13.5h5M8 16h4M10 3.5a4.5 4.5 0 0 0-2.6 8.2c.4.3.6.8.6 1.3h4c0-.5.2-1 .6-1.3A4.5 4.5 0 0 0 10 3.5z",
  leaf: "M5 15c0-6 3.5-9.5 10.5-10.5C15 11 11.5 15 5 15zM5 15l5-5",
  flask: "M8 3.5h4M8.5 3.5v4.5l-4 6.5a1 1 0 0 0 .9 1.5h9.2a1 1 0 0 0 .9-1.5l-4-6.5V3.5M6.5 12h7",
  code: "M7 6l-4 4 4 4M13 6l4 4-4 4",
  home: "M3.5 9.5L10 4l6.5 5.5M5.5 8v8h9V8",
  heart: "M10 16s-6-3.6-6-8a3.5 3.5 0 0 1 6-2.4A3.5 3.5 0 0 1 16 8c0 4.4-6 8-6 8z",
  compass: "M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM12.5 7.5l-1.5 3.5-3.5 1.5 1.5-3.5z",
  palette: "M10 3.5a6.5 6.5 0 1 0 0 13c1 0 1.3-.8.9-1.6-.5-.9 0-1.9 1-1.9h1.6a3 3 0 0 0 3-3c0-3.6-2.9-6.5-6.5-6.5zM6.5 9.5h.01M8.5 6.5h.01M12 6.5h.01",
  music: "M8 14.5V5l8-1.5v9.5M6 16.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM14 15a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  chat: "M4 5.5h12v8H9l-3.5 3v-3H4z",
};

export function PageGlyph({ name, size = 16 }: { name: string | null | undefined; size?: number }) {
  const d = PATHS[(name ?? "doc") as PageIcon] ?? PATHS.doc;
  return (
    <svg className="nt-glyph" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
