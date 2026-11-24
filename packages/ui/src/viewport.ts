import "./keyboard.css";

/** The on-screen keyboard. iOS Safari (and Chrome on Android by default) does not shrink the layout for it: only the
 *  visual viewport gets shorter, and the browser slides the whole page up to show the field instead. So a composer
 *  in the middle of a full-height page ends up above the screen, and anything fixed to the foot of the screen (the
 *  dock and the ask bar in it, a card's sheet) stays behind the keyboard.
 *
 *  What this keeps on <html> for the style sheets (keyboard.css):
 *  - `--vvh`: the height of the visible part. The workspace is that tall, and the page's own scroller brings a field
 *    into view.
 *  - `--kb`: how much of the screen's foot the keyboard covers. What is fixed to the foot sits that much higher.
 *  - `data-keyboard`: set while the keyboard is up.
 *  The page itself is kept from sliding (scrolled back to the top), and the field with focus is scrolled into view
 *  in its own scroller once the keyboard has settled. */
export function followVisualViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const root = document.documentElement;
  noZoomOnFocus();
  // The tallest the visible part has been at this width: with the keyboard down. A browser that does shrink the
  // layout (Android with `interactive-widget=resizes-content`) shrinks innerHeight too, so innerHeight alone would
  // not tell the keyboard is there.
  let tallest = { width: 0, height: 0 };
  const sync = () => {
    const width = Math.round(window.innerWidth);
    if (width !== tallest.width) tallest = { width, height: 0 };
    tallest.height = Math.max(tallest.height, window.innerHeight, viewport.height);
    const height = Math.round(viewport.height);
    const covered = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
    // Pinched in, the visible part is small too, but that is not the keyboard, and the page is the user's to pan.
    const zoomed = Math.abs(viewport.scale - 1) > .05;
    const keyboard = !zoomed && tallest.height - viewport.height > 120 && editing();
    root.style.setProperty("--vvh", `${height}px`);
    root.style.setProperty("--kb", `${keyboard ? covered : 0}px`);
    if (keyboard) root.dataset.keyboard = ""; else delete root.dataset.keyboard;
    if (!zoomed && (window.scrollY !== 0 || viewport.offsetTop !== 0)) window.scrollTo(0, 0);
    if (keyboard) reveal();
  };
  // The keyboard slides in over a few hundred milliseconds; the field is brought into view when it has stopped.
  let settle = 0;
  const reveal = () => {
    window.clearTimeout(settle);
    settle = window.setTimeout(() => {
      const field = document.activeElement;
      if (!(field instanceof HTMLElement) || !isField(field)) return;
      const box = field.getBoundingClientRect();
      const bottom = viewport.height - 8;
      if (box.top < 8 || box.bottom > bottom) field.scrollIntoView({ block: box.height > bottom / 2 ? "start" : "nearest" });
    }, 60);
  };
  viewport.addEventListener("resize", sync);
  viewport.addEventListener("scroll", sync);
  window.addEventListener("resize", sync);
  // Focus moving between fields while the keyboard stays up fires no resize: bring the new one into view.
  document.addEventListener("focusin", () => { if (root.dataset.keyboard !== undefined) reveal(); else window.setTimeout(sync, 350); });
  document.addEventListener("focusout", () => window.setTimeout(sync, 50));
  sync();
}

const isField = (element: Element) => element.matches("textarea, input:not([type=checkbox], [type=radio], [type=button], [type=submit], [type=range], [type=color], [type=file]), select, [contenteditable]:not([contenteditable=false])");
const editing = () => { const field = document.activeElement; return !!field && isField(field); };

/** iOS zooms the page in on a field whose text is under 16px, and leaves it zoomed: the page no longer fits and the
 *  field can end up off to the side. `maximum-scale=1` stops only that zoom there (since iOS 10 people can still pinch
 *  to zoom); elsewhere it would stop pinching, so it is only added on iOS, which is the only one that zooms. */
function noZoomOnFocus() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const meta = document.querySelector<HTMLMetaElement>("meta[name=viewport]");
  if (ios && meta && !/maximum-scale/.test(meta.content)) meta.content += ", maximum-scale=1";
}
