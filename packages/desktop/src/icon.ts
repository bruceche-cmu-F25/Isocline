/** The menu bar icon: Isocline's mark, the tesseract seen as a cube in a cube (the 8 edges joining the two cubes are
 * dropped at this size). Drawn at 2x as a template image so macOS tints it for light and dark menu bars.
 */
import { nativeImage, type NativeImage } from "electron";
import { markSegments } from "@isocline/ui/figure";
import { appIconPixels } from "./icon-art.ts";

export function trayIcon(): NativeImage {
  const size = 36; // 18 pt at 2x, the usual menu-bar icon size
  const half = 1; // 1 pt stroke at 2x
  const cropInset = 8; // Trim padding from the 120-unit artboard for a 17 pt tall mark.
  const scale = size / (120 - 2 * cropInset);
  const at = ([x, y]: [number, number]): [number, number] => [(x - cropInset) * scale, (y - cropInset) * scale];
  const lines = markSegments({ mono: true }).map(([a, b]) => [at(a), at(b)] as const);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      let distance = Infinity;
      for (const [[ax, ay], [bx, by]] of lines) {
        const dx = bx - ax, dy = by - ay;
        const u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
        distance = Math.min(distance, Math.hypot(px - (ax + u * dx), py - (ay + u * dy)));
      }
      const coverage = Math.max(0, Math.min(1, half + 0.5 - distance));
      // BGRA; template images use only alpha.
      pixels[(y * size + x) * 4 + 3] = Math.round(255 * coverage);
    }
  }
  const image = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 2 });
  image.setTemplateImage(true);
  return image;
}

/** The Dock icon: the tesseract on a paper rounded square (icon-art.ts). Set at launch; a packaged
 * Isocline.app would carry the same picture in its bundle, so it shows before launch too. */
export function appIcon(size = 512): NativeImage {
  const rgba = appIconPixels(size);
  const bgra = Buffer.alloc(rgba.length);
  // BGRA with premultiplied alpha, as Skia stores it; only the anti-aliased rim has alpha below 255.
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3] / 255;
    bgra[i] = Math.round(rgba[i + 2] * alpha); bgra[i + 1] = Math.round(rgba[i + 1] * alpha); bgra[i + 2] = Math.round(rgba[i] * alpha); bgra[i + 3] = rgba[i + 3];
  }
  return nativeImage.createFromBitmap(bgra, { width: size, height: size });
}
