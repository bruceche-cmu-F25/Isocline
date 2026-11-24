/* Sets light or dark on <html> (tokens.css reads data-scheme) before the first paint.
 * It follows the system unless this device chose one (src/scheme.ts keeps the choice in localStorage);
 * a choice made in another window of the same origin (the Mac app's presence window) arrives as a storage event.
 * A plain file, not inline: the home node's Content-Security-Policy allows only same-origin scripts. */
(function () {
  // Before the rename (Alfred → Isocline) this device kept its choices under "alfred.": they move to "isocline."
  // once, here, because this runs before anything else on the page reads them.
  [window.localStorage, window.sessionStorage].forEach(function (store) {
    try {
      for (var i = store.length - 1; i >= 0; i--) {
        var old = store.key(i);
        if (!old || old.indexOf("alfred.") !== 0) continue;
        var renamed = "isocline." + old.slice("alfred.".length);
        if (store.getItem(renamed) === null) store.setItem(renamed, store.getItem(old));
        store.removeItem(old);
      }
    } catch (error) { /* storage off: nothing to carry over */ }
  });
  var KEY = "isocline.scheme";
  var dark = matchMedia("(prefers-color-scheme: dark)");
  var chosen = function () {
    try { var value = localStorage.getItem(KEY); return value === "light" || value === "dark" ? value : null; } catch (error) { return null; }
  };
  var apply = function () { document.documentElement.dataset.scheme = chosen() || (dark.matches ? "dark" : "light"); };
  apply();
  // The text size this device chose (src/prefs.ts), so the page does not jump after it loads.
  try { var size = localStorage.getItem("isocline.textSize"); if (size === "small" || size === "large") document.documentElement.dataset.text = size; } catch (error) { /* the usual size */ }
  dark.addEventListener("change", apply);
  addEventListener("storage", function (event) { if (event.key === KEY || event.key === null) apply(); });
})();
