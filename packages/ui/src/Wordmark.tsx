/** The wordmark: "isocline" in Geist Serif, lowercase so it has two i's, and each i's dot drawn by us in a voice's
 * colour: Ana's warm on the first, Kata's blue on the second (docs/design/rename-isocline.md §2; the options are in
 * prototype/isocline.html). Each i is a dotless ı with the dot placed where Geist Serif's own sits: its tittle spans
 * x 91–203 and y 607–717 of a 288-wide glyph (1000 to the em, ascent 1005, descent 295), which with line-height 1 is
 * 0.147em from the glyph's left and 0.193em from the top. */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <p className={`wordmark ${className}`} aria-label="Isocline">
      <span aria-hidden="true"><Dotted voice="ana" />socl<Dotted voice="kata" />ne</span>
    </p>
  );
}

function Dotted({ voice }: { voice: "ana" | "kata" }) {
  return <span className="wm-i">ı<span className="wm-dot" data-voice={voice} /></span>;
}
