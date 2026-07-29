/**
 * The one shell every console page imports. Before this, ops.js / ledger.js /
 * content.js each carried their own copy of these helpers and the copies had
 * DIVERGED — fmt6 prepended "$" in one and not the other, trunc null-guarded in one
 * and not the other, esc was written three different ways. One implementation each,
 * here.
 *
 * Served raw to the browser as an ES module: no build step, and same-origin so the
 * strict `default-src 'self'` CSP holds.
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** HTML-escape any value. Every interpolation into innerHTML goes through this. */
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Six-decimal micro-USDC, bare. Money is always mono + tabular in the CSS. */
export const fmt6 = (n) => Number(n || 0).toFixed(6);
/** Six-decimal micro-USDC with the sign. Use this wherever a figure is shown alone. */
export const usd = (n) => "$" + fmt6(n);

/** Middle-truncate an address or hash. Null-safe. */
export const trunc = (a) => (a && a.length > 12 ? a.slice(0, 6) + "…" + a.slice(-4) : a || "—");

/** Coarse relative time, newest-first vocabulary: 12s / 5m / 3h / 8d. */
export const rel = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

/** Build an element without innerHTML when the content is untrusted. */
export const el = (tag, attrs = {}, html = "") => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) node.setAttribute(k, String(v));
  }
  if (html) node.innerHTML = html;
  return node;
};

// ── the mark ──────────────────────────────────────────────────────────────────
// Geometry mirrors src/brand.ts (public source of truth: https://naulon.app/brand).
// shell-brand-parity.test.ts asserts the two stay identical.
const MARK_ARCH = "M5.5 19.5V11a6.5 6.5 0 0 1 13 0v8.5";
const MARK_STROKE = 2.3;
const MARK_COIN = { cx: 12, cy: 13.2, r: 1.85 };

/** The bare mark in `currentColor`. Sized by its container. */
export const markSvg = () =>
  `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">` +
  `<path d="${MARK_ARCH}" stroke="currentColor" stroke-width="${MARK_STROKE}" ` +
  `stroke-linecap="round" stroke-linejoin="round"/>` +
  `<circle cx="${MARK_COIN.cx}" cy="${MARK_COIN.cy}" r="${MARK_COIN.r}" fill="currentColor"/></svg>`;

// ── the sidebar ───────────────────────────────────────────────────────────────
/** Nav groups, in order. `null` group = ungrouped, rendered above the first label. */
export const NAV = [
  { group: null, items: [{ href: "/", label: "Overview", id: "overview" }] },
  { group: "Money", items: [{ href: "/ledger", label: "Ledger", id: "ledger" }] },
  { group: "Config", items: [{ href: "/content", label: "Content", id: "content" }] },
];

/**
 * Render the sidebar into `#shell` and mark `active` current. Every page calls this
 * once, so the nav can never drift between pages again (it had: /content was missing
 * the Ledger link entirely).
 *
 * `nav: false` renders the brand and the status rail with NO links — the public
 * earnings page (DASHBOARD_PUBLIC serves the ledger at "/") has no console to link
 * to, and must not advertise routes that would 404 or leak that they exist.
 */
export function renderShell({ active, nav = true }) {
  const groups = !nav ? "" : NAV.map(({ group, items }) => {
    const label = group ? `<div class="nav-group">${esc(group)}</div>` : "";
    const links = items
      .map(
        (i) =>
          `<a class="nav-link${i.id === active ? " on" : ""}" href="${esc(i.href)}"` +
          `${i.id === active ? ' aria-current="page"' : ""}>${esc(i.label)}</a>`,
      )
      .join("");
    return label + links;
  }).join("");

  const host = $("#shell");
  if (!host) return;
  host.innerHTML =
    `<a class="brand" href="/" aria-label="naulon — self-hosted gate">` +
    `<span class="brand-tile">${markSvg()}</span>` +
    `<span class="brand-word"><b>naulon</b><span class="brand-role">self-host</span></span></a>` +
    `<nav class="nav">${groups}</nav>` +
    `<div class="rail"><span class="gate-state"><span class="dot off" id="gateDot"></span>` +
    `<span id="gateState">checking gate</span></span>` +
    `<a class="rail-link" href="https://naulon.app" target="_blank" rel="noopener">naulon cloud ↗</a></div>`;
}

/**
 * Paint the rail's gate state. Every page owns a different source for it (the ops
 * poll, the SSE connection, the content fetch) but they all render it the same way,
 * so the rail never sits on its "checking gate" placeholder forever.
 */
export function setGate(up, label) {
  const dot = $("#gateDot");
  const text = $("#gateState");
  if (!dot || !text) return;
  dot.classList.toggle("off", !up);
  dot.classList.toggle("bad", up === false);
  text.textContent = label;
}

// ── data ──────────────────────────────────────────────────────────────────────
/**
 * Run `fn` now, then every `ms`, and once more whenever the tab becomes visible.
 * Pauses while hidden so a backgrounded console stops hammering the gate.
 */
export function poll(fn, ms) {
  let timer = null;
  const run = async () => {
    try {
      await fn();
    } catch {
      /* the page's own error surface reports it; a throw must not kill the loop */
    }
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const start = () => {
    stop();
    void run();
    timer = setInterval(run, ms);
  };
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  start();
  return { stop, run };
}

/** Subscribe to a same-origin SSE endpoint. `onEvent(name, parsedData)`. */
export function sse(path, onEvent, events = ["message"]) {
  const source = new EventSource(path);
  for (const name of events) {
    source.addEventListener(name, (e) => {
      try {
        onEvent(name, JSON.parse(e.data));
      } catch {
        /* a malformed frame must not tear down the stream */
      }
    });
  }
  return source;
}
