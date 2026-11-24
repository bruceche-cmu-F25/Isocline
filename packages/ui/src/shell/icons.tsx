import { markSegments } from "../entity/tesseract.js";

/** Isocline's own mark as an icon: the resting tesseract, from the figure's geometry (so the two cannot drift apart),
 * fitted to the 20 × 20 grid. All 32 edges: without the eight that join its two cubes it is only a cube in a cube. */
const MARK = (() => {
  const edges = markSegments(), points = edges.flatMap(([from, to]) => [from, to]);
  const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
  const left = Math.min(...xs), top = Math.min(...ys), wide = Math.max(...xs) - left, tall = Math.max(...ys) - top;
  const scale = 17 / Math.max(wide, tall), dx = (20 - wide * scale) / 2, dy = (20 - tall * scale) / 2;
  const at = ([x, y]: [number, number]) => `${((x - left) * scale + dx).toFixed(2)} ${((y - top) * scale + dy).toFixed(2)}`;
  return edges.map(([from, to]) => `M${at(from)}L${at(to)}`).join("");
})();

/** Line icons on a 20 × 20 grid, drawn with the page's stroke style (styles.css: svg). */
const PATHS = {
  todo: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM7 10.2l2 2 4-4.4",
  inbox: "M3.5 11.5 5.5 5h9l2 6.5V15.5h-13zM3.5 11.5H8l1 2h2l1-2h4.5",
  alfred: MARK,
  chat: "M4 5.5h12v8H9l-3.5 3v-3H4z",
  copy: "M4.5 3h7a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 11.5v-7A1.5 1.5 0 0 1 4.5 3zM13 7h2.5a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 15.5V13",
  sendMail: "m3 9 13.5-5.5-4.8 13-2.9-5.4L3 9zm5.8 2.1 7.7-7.6",
  trash: "M4.5 6h11M8 6V4.2h4V6M6 6l.7 10h6.6L14 6M8.7 8.5v5M11.3 8.5v5",
  write: "M9 4.5H4.5v11h11V11M8.4 11.8l.6-2.7 6.2-6.2 2.1 2.1-6.2 6.2-2.7.6z",
  more: "M4 10h.45M9.8 10h.45M15.6 10h.45",
  plus: "M10 4.5v11M4.5 10h11",
  clock: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM10 6.5V10l2.5 1.5",
  cal: "M4 5.5h12v10.5H4zM4 9h12M7.5 3.5v3.5M12.5 3.5v3.5",
  mail: "M3.5 5.5h13v9.5h-13zM4 6l6 4.75L16 6",
  star: "m10 2.8 2.2 4.5 5 .7-3.6 3.5.9 5L10 14.1l-4.5 2.4.9-5L2.8 8l5-.7z",
  search: "M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM13.5 13.5 17 17",
  rail: "M3.5 4.5h13v11h-13zM8 4.5v11",
  wide: "M7 4H4v3M13 4h3v3M7 16H4v-3M13 16h3v-3",
  narrow: "M4 7h3V4M16 7h-3V4M4 13h3v3M16 13h-3v3",
  panel: "M3.5 4.5h13v11h-13zM12 4.5v11",
  down: "M5 8l5 5 5-5",
  archive: "M4 6h12M5 6v9h10V6M8 9h4",
  close: "M6 6l8 8M14 6l-8 8",
  menu: "M4 6h12M4 10h12M4 14h12",
  shield: "M10 3.5 15.5 5.5v4.5c0 3.5-5.5 6.5-5.5 6.5S4.5 13.5 4.5 10V5.5z",
  code: "M7 6.5 3.5 10 7 13.5M13 6.5l3.5 3.5-3.5 3.5M11.2 4.5l-2.4 11",
  home: "M3.5 9.2 10 3.8l6.5 5.4V16h-4.4v-4.2H7.9V16H3.5z",
  folder: "M3 6a1.5 1.5 0 0 1 1.5-1.5h3.2l1.6 1.6h6.2A1.5 1.5 0 0 1 17 7.6v6.9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z",
  back: "M12 5l-5 5 5 5",
  forward: "M8 5l5 5-5 5",
  check: "M5 10.5l3.2 3.2L15 7",
  terminal: "M3.5 4.5h13v11h-13zM6.5 8l2.5 2-2.5 2M10.5 12.5h3",
  globe: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM3 10h14M10 3c2.2 2 3.2 4.3 3.2 7s-1 5-3.2 7c-2.2-2-3.2-4.3-3.2-7s1-5 3.2-7",
  clip: "M14.5 9.5 9.6 14.4a3 3 0 0 1-4.2-4.2l5.6-5.6a2 2 0 0 1 2.8 2.8L8.3 12.9a1 1 0 0 1-1.4-1.4l4.6-4.6",
  link: "M8.5 11.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.7.7M11.5 8.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.7-.7",
  model: "M6 6h8v8H6zM8.5 8.5h3v3h-3zM8 3.5V6M12 3.5V6M8 14v2.5M12 14v2.5M3.5 8H6M3.5 12H6M14 8h2.5M14 12h2.5",
  sliders: "M3 6.5h3m4 0h7M3 13.5h7m4 0h3M10 6.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM14 13.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0z",
  bulb: "M8 15h4M8.5 17.5h3M10 3a5 5 0 0 0-3 9c.6.5 1 1.1 1 1.8V14h4v-.2c0-.7.4-1.3 1-1.8A5 5 0 0 0 10 3",
  sun: "M10 13.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM10 3v1.6M10 15.4V17M3 10h1.6M15.4 10H17M5.05 5.05l1.15 1.15M13.8 13.8l1.15 1.15M5.05 14.95l1.15-1.15M13.8 6.2l1.15-1.15",
  moon: "M16.3 10.55A6.3 6.3 0 1 1 9.45 3.7a4.9 4.9 0 0 0 6.85 6.85z",
  speaker: "M3.5 8h3l4-3.5v11l-4-3.5h-3zM13.5 7.5a3.5 3.5 0 0 1 0 5M15.5 5.5a6.3 6.3 0 0 1 0 9",
  muted: "M3.5 8h3l4-3.5v11l-4-3.5h-3zM13 8l4 4M17 8l-4 4",
  stop: "M6 6h8v8H6z",
  mic: "M10 12.5a2.5 2.5 0 0 0 2.5-2.5V5.5a2.5 2.5 0 0 0-5 0V10a2.5 2.5 0 0 0 2.5 2.5zM5.5 9.5a4.5 4.5 0 0 0 9 0M10 14v2.5M7.5 16.5h5",
  person: "M10 10a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM4 16.5c.6-2.8 3-4.3 6-4.3s5.4 1.5 6 4.3",
  layers: "M10 3.5 3.5 7 10 10.5 16.5 7zM3.5 10.2 10 13.7l6.5-3.5M3.5 13.2 10 16.7l6.5-3.5",
  plug: "M7.5 3.5V7M12.5 3.5V7M5.5 7h9v2.5a4.5 4.5 0 0 1-9 0zM10 14v2.5",
  phone: "M6.5 3.5h7a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1zM9 14.2h2",
  branch: "M6.5 5.5a1.5 1.5 0 1 0 0-.01zM6.5 16a1.5 1.5 0 1 0 0-.01zM13.5 7.5a1.5 1.5 0 1 0 0-.01zM6.5 6.5v8M13.5 9c0 3-7 2.5-7 5.5",
  play: "M7 5.2v9.6L14.5 10z",
  gear: "M8.21 4.8L8.59 2.74A7.4 7.4 0 0 1 11.41 2.74L11.79 4.8A5.5 5.5 0 0 1 13.61 5.85L15.58 5.15A7.4 7.4 0 0 1 17 7.59L15.4 8.95A5.5 5.5 0 0 1 15.4 11.05L17 12.41A7.4 7.4 0 0 1 15.58 14.85L13.61 14.15A5.5 5.5 0 0 1 11.79 15.2L11.41 17.26A7.4 7.4 0 0 1 8.59 17.26L8.21 15.2A5.5 5.5 0 0 1 6.39 14.15L4.42 14.85A7.4 7.4 0 0 1 3 12.41L4.6 11.05A5.5 5.5 0 0 1 4.6 8.95L3 7.59A7.4 7.4 0 0 1 4.42 5.15L6.39 5.85A5.5 5.5 0 0 1 8.21 4.8zM10 12.4a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, label }: { name: IconName; label?: string }) {
  return (
    <svg viewBox="0 0 20 20" data-icon={name} aria-hidden={label ? undefined : true} aria-label={label} role={label ? "img" : undefined}>
      <path d={PATHS[name]} />
    </svg>
  );
}
