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

// ── observations ──────────────────────────────────────────────────────────────
// The six verdicts and the identity split get rendered on more than one page. They
// live here for the same reason $/esc/fmt6 do: the moment a second page carried its
// own copy of these, the copies started disagreeing.

/** The six verdicts, in the order the operator reads them (free → refused → money). */
export const VERDICTS = ["served-free", "agent-reread", "denied", "blocked", "payment-failed", "paid"];

/** Short labels for the counter strip — the raw verdict is the badge's own text. */
export const VERDICT_LABEL = {
  "served-free": "free",
  "agent-reread": "re-read",
  denied: "denied",
  blocked: "blocked",
  "payment-failed": "failed",
  paid: "paid",
};

/** Verdicts that mean something went wrong, so a non-zero count can go red. */
export const VERDICT_BAD = new Set(["blocked", "payment-failed"]);

/**
 * Who made this request, as escaped HTML. Verified agents get their directory host, a
 * failed signature is called out as a spoof rather than folded into "unsigned", and a
 * human is just a human.
 */
export const agentLabel = (o) =>
  o.classifiedAs === "agent"
    ? o.verified
      ? `<span class="badge">✓ ${esc(o.verifiedAgent || "verified agent")}</span>`
      : o.sigInvalid
        ? `<span class="bad">spoofed signature</span>`
        : esc(o.agentUa || "unsigned agent")
    : "human";

/**
 * Test toll leaves REAL observations behind — it genuinely asks the gate for an article
 * and genuinely gets refused. Label them, or the operator wonders where a handful of
 * denials and some "missed" earnings came from.
 */
export const isSelfTest = (o) => (o.agentUa || "").includes("naulon-dashboard-selftest");
export const selfTestBadge = (o) => (isSelfTest(o) ? `<span class="badge selftest">self-test</span>` : "");

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
  {
    group: "Traffic",
    items: [
      { href: "/requests", label: "Requests", id: "requests" },
      { href: "/agents", label: "Agents", id: "agents" },
    ],
  },
  { group: "Money", items: [{ href: "/ledger", label: "Ledger", id: "ledger" }] },
  {
    group: "Config",
    items: [
      { href: "/content", label: "Content", id: "content" },
      { href: "/doctor", label: "Doctor", id: "doctor" },
    ],
  },
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

// ── controls ──────────────────────────────────────────────────────────────────
/**
 * Wire a `.seg` group of `[data-<key>]` buttons: paint the active one and hand the
 * chosen value back. Three pages pick a traffic window with the same control, and this
 * is the difference between one implementation and three that drift.
 *
 * Returns nothing — the caller owns what happens on change.
 */
export function wireSeg(container, key, onPick) {
  if (!container) return;
  container.addEventListener("click", (e) => {
    const btn = e.target.closest(`[data-${key}]`);
    if (!btn || !container.contains(btn)) return;
    for (const b of $$(`[data-${key}]`, container)) {
      const on = b === btn;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    }
    onPick(btn.dataset[key]);
  });
  // State the initial pressed state, so a screen reader isn't told the group is empty.
  for (const b of $$(`[data-${key}]`, container)) {
    b.setAttribute("aria-pressed", String(b.classList.contains("on")));
  }
}

/**
 * Debounce a handler — a filter that repaints on every keystroke reads as jitter, and
 * one that waits for the next poll reads as broken. 200ms is the gap between the two.
 */
export function debounced(fn, ms = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
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
