/** The wordmark: "zirma" in Geist Serif, lowercase, its one i dotted by us with a small square in the app's blue,
 * turned 25° as if mid-turn (docs/design/rename-zirma.md §1; the options are in prototype/zirma.html). The i is a
 * dotless ı with the square placed where Geist Serif's own dot sits: its tittle spans x 91–203 and y 607–717 of a
 * 288-wide glyph (1000 to the em, ascent 1005, descent 295), which with line-height 1 is 0.147em from the glyph's
 * left and 0.193em from the top. */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <p className={`wordmark ${className}`} aria-label="Zirma">
      <span aria-hidden="true">z<span className="wm-i">ı<span className="wm-dot" /></span>rma</span>
    </p>
  );
}
