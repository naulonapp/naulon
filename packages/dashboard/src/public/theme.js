/**
 * Theme resolution, before the first paint.
 *
 * Loaded as a BLOCKING script in <head> — not deferred, not a module — because everything it
 * does must happen before the browser paints. Deferred, an operator on light would watch the
 * console render dark and then flip, once per navigation (this console is eight separate
 * documents, not a client-routed app, so that flash would be every single page load).
 *
 * It cannot be an inline <script>: the console's CSP is `script-src 'self'` with no nonce,
 * which is the right posture for a page that renders wallets, and a theme is not worth
 * weakening it.
 *
 * The stylesheet carries ONE light block, `:root[data-theme="light"]`. Resolving "system" to a
 * concrete value here rather than duplicating every token inside a `prefers-color-scheme`
 * media query is the whole reason this file exists: two copies of a palette drift, and the
 * half that drifts is the one nobody is looking at.
 */
(function () {
  var KEY = "naulon-console-theme";
  var root = document.documentElement;

  /** localStorage throws outright in some privacy modes — a theme must never break a page. */
  function stored() {
    try {
      var v = window.localStorage.getItem(KEY);
      return v === "light" || v === "dark" || v === "system" ? v : null;
    } catch (e) {
      return null;
    }
  }

  function systemPrefersLight() {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches;
  }

  /** Apply a preference: "system" resolves now, "light"/"dark" are taken literally. */
  function apply(pref) {
    var resolved = pref === "system" ? (systemPrefersLight() ? "light" : "dark") : pref;
    root.setAttribute("data-theme", resolved);
    // Tells the UA which scrollbars, form controls and default canvas to use. Without it a
    // light page keeps dark native widgets.
    root.style.colorScheme = resolved;
  }

  var pref = stored() || "system";
  apply(pref);

  // Follow the OS while the preference is "system" — a console left open across sunset should
  // not be the one window that stayed dark.
  if (typeof window.matchMedia === "function") {
    var mq = window.matchMedia("(prefers-color-scheme: light)");
    var onChange = function () {
      if ((stored() || "system") === "system") apply("system");
    };
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
    else if (typeof mq.addListener === "function") mq.addListener(onChange);
  }

  // The shell's toggle talks to this, so the storage key and the resolution rule live in one
  // place. `naulonTheme.cycle()` returns the preference it moved to.
  window.naulonTheme = {
    ORDER: ["system", "light", "dark"],
    get: function () {
      return stored() || "system";
    },
    set: function (pref) {
      try {
        window.localStorage.setItem(KEY, pref);
      } catch (e) {
        /* unwritable storage: the choice holds for this page only, which is better than an error */
      }
      apply(pref);
      return pref;
    },
    cycle: function () {
      var order = window.naulonTheme.ORDER;
      var next = order[(order.indexOf(window.naulonTheme.get()) + 1) % order.length];
      return window.naulonTheme.set(next);
    },
    resolved: function () {
      return root.getAttribute("data-theme") === "light" ? "light" : "dark";
    },
  };
})();
