/** Isocline's app icon as pixels: the resting tesseract, its far edges paler (as everywhere else), on a paper
 * rounded square drawn to the macOS icon grid (the square fills 824 of 1024, corners as a superellipse, so
 * macOS does not put it in a grey frame). No Electron here, so it can be rendered and checked in plain Node.
 */
import { markSegments, PALETTES } from "@isocline/ui/figure";

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (a: number[], b: number[], u: number) => a.map((x, i) => x + (b[i] - x) * u);
const clamp = (x: number) => Math.max(0, Math.min(1, x));

/** RGBA, `size` × `size`, unpremultiplied. */
export function appIconPixels(size = 512): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  const paper = rgb("#fffdfc"), ink = rgb(PALETTES.light.ind);
  const half = (size * 824) / 1024 / 2, centre = size / 2;
  const n = 5; // superellipse exponent: close to Apple's continuous corners

  // The mark's 120-unit box fills 80% of the square (the tesseract itself about 61%).
  const unit = (half * 2 * 0.8) / 120, origin = centre - 60 * unit;
  const halfWidth = (4.6 * unit) / 2;
  const lines = markSegments().sort((a, b) => a[2] - b[2]).map(([a, b, near]) => ({
    ax: origin + a[0] * unit, ay: origin + a[1] * unit, bx: origin + b[0] * unit, by: origin + b[1] * unit,
    colour: mix(ink, paper, (1 - near) * 0.62),
  }));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      const u = Math.abs(px - centre) / half, v = Math.abs(py - centre) / half;
      const edge = clamp((1 - Math.pow(Math.pow(u, n) + Math.pow(v, n), 1 / n)) * half + 0.5);
      if (edge <= 0) continue;
      let colour = paper;
      for (const line of lines) {
        const dx = line.bx - line.ax, dy = line.by - line.ay;
        const t = clamp(((px - line.ax) * dx + (py - line.ay) * dy) / (dx * dx + dy * dy || 1));
        const cover = clamp(halfWidth + 0.5 - Math.hypot(px - (line.ax + t * dx), py - (line.ay + t * dy)));
        if (cover > 0) colour = mix(colour, line.colour, cover);
      }
      const i = (y * size + x) * 4;
      out[i] = colour[0]; out[i + 1] = colour[1]; out[i + 2] = colour[2]; out[i + 3] = Math.round(255 * edge);
    }
  }
  return out;
}
