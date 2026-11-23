/** iOS Safari does not shrink the layout for the on-screen keyboard: it slides the whole page up instead, so a
 *  composer in the middle of a full-height page ends up above the screen. Size the workspace to the visible part
 *  (--vvh) and keep the page from sliding; the page's own scroller then brings the field into view. */
export function followVisualViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const root = document.documentElement;
  const sync = () => {
    root.style.setProperty("--vvh", `${Math.round(viewport.height)}px`);
    // The keyboard is up when the visible part is much shorter than the window.
    const keyboard = window.innerHeight - viewport.height > 120;
    if (keyboard) root.dataset.keyboard = ""; else delete root.dataset.keyboard;
    if (window.scrollY !== 0 || viewport.offsetTop !== 0) window.scrollTo(0, 0);
    if (keyboard) {
      const field = document.activeElement;
      if (field instanceof HTMLElement && field.matches("textarea, input, [contenteditable]")) field.scrollIntoView({ block: "nearest" });
    }
  };
  viewport.addEventListener("resize", sync);
  viewport.addEventListener("scroll", sync);
  sync();
}
