/** Isocline's favicon, drawn from the figure's own geometry (markSegments), like the Mac app icon
 * (packages/desktop/src/icon-art.ts): the resting tesseract, far edges paler, on a paper rounded square.
 * At tab size the lines are thicker and the square fills the whole icon.
 *
 *   node packages/ui/scripts/favicon.ts            writes public/favicon.svg, favicon-32.png, apple-touch-icon.png
 *   node packages/ui/scripts/favicon.ts --preview <dir>   writes a comparison sheet of variants instead
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { markSegments, PALETTES } from "../src/entity/tesseract.js";

const PAPER = "#fffdfc";
type Rgb = number[];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (c: Rgb) => `#${c.map((x) => Math.round(x).toString(16).padStart(2, "0")).join("")}`;
const mix = (a: Rgb, b: Rgb, u: number) => a.map((x, i) => x + (b[i] - x) * u);
const clamp = (x: number) => Math.max(0, Math.min(1, x));

export interface Design {
  /** Drop the 8 edges joining the two cubes (cube in a cube), as the menu-bar icon does. */
  mono: boolean;
  /** Line width in the mark's 120-unit box. */
  width: number;
  /** How much of the tile the mark's 120 box fills. */
  fill: number;
  /** Paper rounded square behind the mark; without it the lines sit on the tab bar. */
  tile: boolean;
  /** Corner radius as a fraction of the tile size (tile only). */
  radius: number;
}

export const FAVICON: Design = { mono: false, width: 8.5, fill: 1.06, tile: true, radius: 0.22 };

/** The mark's lines in a size × size icon, back to front, coloured as on paper. */
function lines(size: number, design: Design) {
  const ink = rgb(PALETTES.light.ind), paper = rgb(PAPER);
  const unit = (size * design.fill) / 120, origin = (size - 120 * unit) / 2;
  return markSegments({ mono: design.mono }).sort((a, b) => a[2] - b[2]).map(([a, b, near]) => ({
    ax: origin + a[0] * unit, ay: origin + a[1] * unit, bx: origin + b[0] * unit, by: origin + b[1] * unit,
    colour: mix(ink, paper, (1 - near) * 0.62),
    half: (design.width * unit) / 2,
  }));
}

/** RGBA pixels, unpremultiplied. */
export function render(size: number, design: Design): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  const paper = rgb(PAPER), segments = lines(size, design);
  const r = design.radius * size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      // Coverage of the rounded square, from its signed distance (negative inside); also right for square corners.
      const qx = Math.abs(px - size / 2) - (size / 2 - r), qy = Math.abs(py - size / 2) - (size / 2 - r);
      const distance = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      const tileCover = design.tile ? clamp(0.5 - distance) : 0;
      let colour = paper, alpha = tileCover;
      for (const line of segments) {
        const dx = line.bx - line.ax, dy = line.by - line.ay;
        const t = clamp(((px - line.ax) * dx + (py - line.ay) * dy) / (dx * dx + dy * dy || 1));
        const cover = clamp(line.half + 0.5 - Math.hypot(px - (line.ax + t * dx), py - (line.ay + t * dy)));
        if (cover <= 0) continue;
        if (design.tile) colour = mix(colour, line.colour, cover);
        else { colour = alpha > 0 ? mix(colour, line.colour, cover) : line.colour; alpha = alpha + (1 - alpha) * cover; }
      }
      const i = (y * size + x) * 4;
      out[i] = colour[0]; out[i + 1] = colour[1]; out[i + 2] = colour[2]; out[i + 3] = Math.round(255 * alpha);
    }
  }
  return out;
}

export function png(pixels: Uint8ClampedArray, width: number, height = width): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(pixels.buffer, pixels.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** The same drawing as an SVG in a 32-unit box (browsers rasterise it at 16 and 32 px). */
export function svg(design: Design): string {
  const size = 32, r = design.radius * size;
  const body = lines(size, design).map((line) =>
    `<line x1="${line.ax.toFixed(2)}" y1="${line.ay.toFixed(2)}" x2="${line.bx.toFixed(2)}" y2="${line.by.toFixed(2)}" stroke="${hex(line.colour)}"/>`).join("");
  const width = ((design.width * size * design.fill) / 120).toFixed(2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">`
    + (design.tile ? `<rect width="${size}" height="${size}" rx="${r.toFixed(2)}" fill="${PAPER}"/>` : "")
    + `<g stroke-width="${width}" stroke-linecap="round">${body}</g></svg>\n`;
}

/** Variants side by side at 16, 32 and 64 px on a light and a dark tab bar, each blown up 6× without smoothing. */
function preview(dir: string): void {
  const variants: Array<[string, Design]> = [
    ["A full tesseract, tile", FAVICON],
    ["B cube in cube, tile", { ...FAVICON, mono: true, width: 10 }],
    ["C full tesseract, no tile", { ...FAVICON, tile: false, fill: 1, width: 9.5 }],
  ];
  const sizes = [16, 32, 64], zoom = 6, gap = 8, bars = [rgb("#dfe3ea"), rgb("#2b2b2e")];
  const cell = 64 * zoom + gap;
  const width = sizes.length * cell * 2 + gap, height = variants.length * cell + gap;
  const sheet = new Uint8ClampedArray(width * height * 4).fill(255);
  variants.forEach(([, design], row) => bars.forEach((bar, side) => sizes.forEach((size, col) => {
    const pixels = render(size, design);
    const left = gap + (side * sizes.length + col) * cell, top = gap + row * cell;
    for (let y = 0; y < 64 * zoom; y++) for (let x = 0; x < 64 * zoom; x++) {
      const sx = Math.floor(x / zoom), sy = Math.floor(y / zoom);
      let c = bar;
      if (sx < size && sy < size) { const i = (sy * size + sx) * 4; c = mix(bar, [pixels[i], pixels[i + 1], pixels[i + 2]], pixels[i + 3] / 255); }
      const o = ((top + y) * width + left + x) * 4;
      sheet[o] = c[0]; sheet[o + 1] = c[1]; sheet[o + 2] = c[2]; sheet[o + 3] = 255;
    }
  })));
  writeFileSync(join(dir, "favicon-variants.png"), png(sheet, width, height));
  console.log(`rows: ${variants.map(([name]) => name).join(" | ")}; columns: 16, 32, 64 px on light, then dark`);
}

const args = process.argv.slice(2);
// Only when run, not when imported (e.g. by a preview script).
if (!import.meta.main) { /* imported */ }
else if (args[0] === "--preview") preview(args[1] ?? ".");
else {
  const out = join(import.meta.dirname, "..", "public");
  writeFileSync(join(out, "favicon.svg"), svg(FAVICON));
  writeFileSync(join(out, "favicon-32.png"), png(render(32, FAVICON), 32));
  // iOS draws its own rounded corners and wants no transparency: the paper square, edge to edge.
  writeFileSync(join(out, "apple-touch-icon.png"), png(render(180, { ...FAVICON, fill: 1, radius: 0 }), 180));
  console.log("wrote public/favicon.svg, favicon-32.png, apple-touch-icon.png");
}
