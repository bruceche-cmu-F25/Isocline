import { useEffect, useRef } from "react";
import { createFigure, type Figure as Live, type FigureState } from "../entity/tesseract.js";

const isDark = () => document.documentElement.dataset.scheme === "dark";

/** The first figure on the page comes in growing from a point; the rest just appear. A figure taken down at once
 * (React's development double mount) hands the entrance back. */
let entered: object | null = null;

/** Zirma's figure at a given size. Its far lines fade toward whatever it sits on, and it follows light and dark.
 * Touching it makes it flinch and wobble (a poke). `anchor`: Zirma speaks from this one (shell/Says.tsx); it is
 * wrapped so the drawing can hop while the wrapper stays still to measure. `enter`: it comes in growing whether or
 * not it is the first. */
export function Figure({ state, size, className, anchor, centered, enter }: { state: FigureState; size: number; className?: string; anchor?: boolean; centered?: boolean; enter?: boolean }) {
  const svg = useRef<SVGSVGElement>(null);
  const live = useRef<Live | null>(null);

  useEffect(() => {
    if (!svg.current) return;
    const first = !entered;
    // Thicker lines at small sizes; below 48 px the tesseract drops the edges joining its two cubes.
    const figure = createFigure(svg.current, {
      width: size >= 100 ? 4 : size >= 48 ? 4.6 : 5.6, small: size < 48, centered,
      dark: isDark(), enter: first || enter ? "grow" : null, ambient: true,
    });
    const born = performance.now();
    if (first) entered = figure;
    live.current = figure;
    const scheme = new MutationObserver(() => figure.setDark(isDark()));
    scheme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-scheme"] });
    return () => {
      scheme.disconnect(); figure.destroy(); live.current = null;
      if (entered === figure && performance.now() - born < 300) entered = null;
    };
  }, [size, centered, enter]);

  useEffect(() => { live.current?.setState(state); }, [state]);
  // Moving between places (panel, floating button) changes what it sits on.
  useEffect(() => { live.current?.refresh(); });

  const drawing = (
    <svg
      ref={svg} className={className ? `figure ${className}` : "figure"} viewBox="0 0 120 120" style={{ width: size, height: size }} aria-hidden="true"
      onPointerDown={() => live.current?.play("poke")}
    />
  );
  return anchor ? <span className="figure-anchor" data-alfred-anchor="">{drawing}</span> : drawing;
}
