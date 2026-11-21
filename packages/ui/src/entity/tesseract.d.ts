export type FigureState = "rest" | "hello" | "listen" | "think" | "speak" | "work" | "notice" | "done" | "error" | "sleep" | "ponder" | "flow";
/** One-shot moves of the body: hop (happy), poke (touched), grow (an entrance from a point), unfold (introducing itself). */
export type FigureMove = "hop" | "poke" | "grow" | "unfold";

export const STATES: FigureState[];
export const MOVES: FigureMove[];
export const LOUD: FigureState[];
export const PALETTES: Record<"light" | "dark", Record<"ind" | "light" | "amber" | "ok" | "now", string>>;

export interface FigureOptions {
  state?: FigureState;
  /** Stroke width in the 120 × 120 box: about 4 at 100 px and up, 5.5 at 36 px, 7 at 18 px. */
  width?: number;
  /** Menu-bar style: currentColor except notice / done / error, no depth shading. */
  mono?: boolean;
  /** Drop the tesseract's W edges, for small sizes. */
  small?: boolean;
  /** Keep each complete pose centred in the viewBox as it animates inside a button. */
  centered?: boolean;
  dark?: boolean;
  /** "auto" reads the nearest ancestor's background; a CSS colour; or null for no depth shading. */
  background?: "auto" | string | null;
  /** A move to come in with, when the figure starts as the body ("grow": from a point). */
  enter?: FigureMove | null;
}

export interface Figure {
  readonly state: FigureState;
  setState(state: FigureState): void;
  /** Plays a move over the body (rest or hello). False when it cannot: another figure is showing, motion is reduced,
   * or (unfold) the figure is too small. */
  play(move: FigureMove): boolean;
  setDark(dark: boolean): void;
  refresh(): void;
  destroy(): void;
}

/** Animates Alfred's figure in an <svg viewBox="0 0 120 120">. */
export function createFigure(svg: SVGSVGElement, options?: FigureOptions): Figure;

/** Draws the static mark into an <svg viewBox="0 0 120 120">. */
export function drawMark(svg: SVGSVGElement, options?: { width?: number; dark?: boolean; background?: "auto" | string | null; mono?: boolean }): void;

/** The resting mark as segments in a 120 × 120 box: [start, end, nearness 0..1]. Pure; safe in Node. */
export function markSegments(options?: { mono?: boolean }): [[number, number], [number, number], number][];
