/** The Code page's backdrop: a slow field of characters, so the place where code is written does not look like the
 * everyday pages. Two canvases, one over the other: a new frame is drawn four times a second into the one that is out
 * of sight, and the browser fades from the old one to it. The fading is the browser's own, at the screen's rate, so the
 * field flows and no character pops; the page's script only runs for the four frames. Still when the user asks for
 * less motion; stopped while the window is hidden or not the one in use. Decoration only: it takes no input and is
 * hidden from assistive tech. Its colours come from CSS (`color`, and `outline-color` for Isocline's).
 */
import { useEffect, useRef } from "react";

const CELL_W = 11, CELL_H = 20;
/** A new frame this often, and how long the fade from one frame to the next takes. */
const STEP_MS = 250;
/** The canvases are made a little larger than the page and only ever grow, so a panel sliding open, or the window being
 * dragged wider, does not make them anew at every step of the way. */
const SLACK = 128;
/** From almost nothing to dense. Light marks only: it is a texture, not a picture. */
const RAMP = "..::-=+*";
/** Now and then, where the field is densest, something that looks like code. */
const CODE = "{}<>/;()=[]";
/** Below this the cell is empty: most of the field is. */
const FLOOR = .5;

/** A number in [0, 1) that is always the same for the same cell and moment. */
const chance = (x: number, y: number, n: number) => { const v = Math.sin(x * 127.1 + y * 311.7 + n * 74.7) * 43758.5453; return v - Math.floor(v); };

/** How dense the field is at a cell, 0 to 1: a few slow waves crossing at a slant (none along the rows, which would
 * read as ruled lines), and rings around a point off to one side. */
function density(x: number, y: number, t: number, cols: number, rows: number): number {
  const rings = Math.hypot((x - cols * .72) * .55, y - rows * .38);
  const v = Math.sin(x * .07 + y * .06 + t * .4) + Math.sin(y * .15 - x * .035 - t * .3) + Math.sin((x * .5 - y) * .09 + t * .22) + Math.sin(rings * .18 - t * .5);
  return (v + 4) / 8;
}

export function AsciiField() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = ref.current;
    const layers = box ? [...box.querySelectorAll("canvas")] : [];
    const contexts = layers.map((layer) => layer.getContext("2d"));
    if (!box || layers.length !== 2 || !contexts[0] || !contexts[1]) return;
    /** The page's size, the canvases' size (in CSS pixels), and the pixel ratio they were made for. */
    let width = 0, height = 0, madeW = 0, madeH = 0, madeRatio = 0;
    /** The field's own clock, in seconds: it only moves while the field does, so nothing jumps after a pause. */
    let clock = 0;
    let front = 0, timer = 0;
    /** The moment each canvas shows. */
    const at = [0, 0];
    const still = matchMedia("(prefers-reduced-motion: reduce)");

    const draw = (which: number) => {
      const context = contexts[which]!;
      const style = getComputedStyle(box);
      const ink = style.color, alfred = style.outlineColor;
      const t = at[which];
      const cols = Math.ceil(width / CELL_W), rows = Math.ceil(height / CELL_H);
      context.clearRect(0, 0, madeW, madeH);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const level = (density(x, y, t, cols, rows) - FLOOR) / (1 - FLOOR);
          if (level <= 0) continue;
          // Each cell changes its bit of code at its own moment, not all of them on one beat.
          const beat = level > .45 ? Math.floor(t / 2.5 + chance(x, y, 0)) : 0;
          const code = level > .45 && chance(x, y, beat) > .93;
          context.fillStyle = code ? alfred : ink;
          context.globalAlpha = code ? .85 : .3 + level * .5;
          context.fillText(code ? CODE[Math.floor(chance(y, x, beat) * CODE.length)] : RAMP[Math.min(RAMP.length - 1, Math.floor(level * RAMP.length))],
            x * CELL_W + CELL_W / 2, y * CELL_H + CELL_H / 2);
        }
      }
    };
    const show = (which: number) => { front = which; layers[which].style.opacity = "1"; layers[1 - which].style.opacity = "0"; };
    /** The next frame goes on the canvas that has just faded out, and the fade turns round. */
    const step = () => { const next = 1 - front; clock += STEP_MS / 1000; at[next] = clock; draw(next); show(next); };
    const start = () => {
      clearInterval(timer); timer = 0;
      if (!still.matches && !document.hidden && document.hasFocus()) timer = window.setInterval(step, STEP_MS);
    };
    const size = () => {
      width = box.clientWidth; height = box.clientHeight;
      const ratio = Math.min(2, devicePixelRatio || 1);
      if (width <= madeW && height <= madeH && ratio === madeRatio) {
        // Room enough already. A moving field fills a part that came into view with its next frame; a still one has no next frame.
        if (!timer) draw(front);
        return;
      }
      madeW = Math.max(madeW, Math.ceil(width / SLACK) * SLACK); madeH = Math.max(madeH, Math.ceil(height / SLACK) * SLACK); madeRatio = ratio;
      layers.forEach((layer, which) => {
        const context = contexts[which]!;
        layer.width = Math.round(madeW * ratio); layer.height = Math.round(madeH * ratio);
        layer.style.width = `${madeW}px`; layer.style.height = `${madeH}px`;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
        context.textAlign = "center"; context.textBaseline = "middle";
        draw(which);
      });
    };
    for (const layer of layers) layer.style.transitionDuration = `${STEP_MS}ms`;
    const sizes = new ResizeObserver(size);
    sizes.observe(box);
    show(0);
    still.addEventListener("change", start);
    document.addEventListener("visibilitychange", start);
    window.addEventListener("focus", start);
    window.addEventListener("blur", start);
    start();
    return () => {
      clearInterval(timer); sizes.disconnect(); still.removeEventListener("change", start); document.removeEventListener("visibilitychange", start);
      window.removeEventListener("focus", start); window.removeEventListener("blur", start);
    };
  }, []);
  return <div ref={ref} className="ascii" aria-hidden="true"><canvas /><canvas /></div>;
}
