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

/** Coarse relative time, newest-first vocabulary: 12s / 5m / 3h / 8d. The live-feed dialect —
 *  a dense column where the unit alone is the whole label. */
export const rel = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

/**
 * The LOGGED-EVENT dialect, for a table with a "When" column rather than a live feed: the
 * portal's own `formatAgo` vocabulary, thresholds and all, so "5 min. ago" here and in the
 * portal are the same string. Past 7 days it becomes an absolute date, because "43d ago" is
 * a number nobody converts.
 */
export const relAgo = (ms) => {
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  const rtf = new Intl.RelativeTimeFormat("en", { style: "short", numeric: "auto" });
  if (s < 45) return rtf.format(0, "second");
  const m = Math.round(s / 60);
  if (m < 60) return rtf.format(-m, "minute");
  const h = Math.round(m / 60);
  if (h < 24) return rtf.format(-h, "hour");
  const d = Math.round(h / 24);
  if (d < 7) return rtf.format(-d, "day");
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(ms));
};

/** The unambiguous instant behind a relative label — date, time, zone. The hover. */
export const exactTime = (ms) =>
  !Number.isFinite(ms)
    ? "—"
    : new Intl.DateTimeFormat("en", {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short",
      }).format(new Date(ms));

/**
 * A logged instant as escaped HTML: a semantic `<time>` carrying the machine-readable ISO in
 * `dateTime` and the exact instant in `title`. Mirrors the portal's `TimeAgo` — a relative
 * label stays scannable, and the precise moment is one hover away instead of gone. A bare
 * string in a "When" column threw both away.
 */
export const timeTag = (ms) => {
  if (!Number.isFinite(ms)) return `<time>—</time>`;
  return `<time datetime="${esc(new Date(ms).toISOString())}" title="${esc(exactTime(ms))}">${esc(relAgo(ms))}</time>`;
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

/**
 * The verdicts, in the order the operator reads them (free → refused → money).
 *
 * This file is served to the browser, so it cannot import `OBSERVATION_VERDICTS` from
 * `@naulon/shared` the way `traffic.ts` and `ops.ts` now do — it is the one copy that has to stay
 * a copy. `verdict-parity.test.ts` reads this file and fails if it drifts from shared, which is
 * how `unservable` was caught missing from all three of these maps.
 */
export const VERDICTS = [
  "served-free",
  "agent-reread",
  "denied",
  "blocked",
  "payment-failed",
  "unservable",
  "paid",
];

/** Short labels for the counter strip — the raw verdict is the badge's own text. */
export const VERDICT_LABEL = {
  "served-free": "free",
  "agent-reread": "re-read",
  denied: "denied",
  blocked: "blocked",
  "payment-failed": "failed",
  unservable: "unservable",
  paid: "paid",
};

/** Verdicts that mean something went wrong, so a non-zero count can go red.
 *  `unservable` belongs here: it means the catalog prices a read the origin cannot serve, which
 *  is the publisher's own misconfiguration and the only place it is visible. */
export const VERDICT_BAD = new Set(["blocked", "payment-failed", "unservable"]);

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

// ── nav icons ─────────────────────────────────────────────────────────────────
/**
 * The same lucide glyphs the hosted portal uses, inlined as path data because this
 * console has no build step and a strict `default-src 'self'` CSP — it cannot import a
 * package or pull a CDN sprite. Concept-matched to the portal's own assignments so the
 * two products read as one system: Overview is its LayoutGrid, Requests its Radar (the
 * observation plane), Agents its Bot, Ledger its Coins, Content its FileText, Webhooks its
 * Webhook — the same glyph the portal puts on Settings → Webhooks.
 *
 * 24×24 viewBox, stroke-width 2, round caps — lucide's own contract — rendered at 16px,
 * which is what the portal's sidebar measures.
 */
const NAV_ICON = {
  overview:
    "<rect width=\"7\" height=\"7\" x=\"3\" y=\"3\" rx=\"1\"/><rect width=\"7\" height=\"7\" x=\"14\" y=\"3\" rx=\"1\"/><rect width=\"7\" height=\"7\" x=\"14\" y=\"14\" rx=\"1\"/><rect width=\"7\" height=\"7\" x=\"3\" y=\"14\" rx=\"1\"/>",
  requests:
    "<path d=\"M19.07 4.93A10 10 0 0 0 6.99 3.34\"/><path d=\"M4 6h.01\"/><path d=\"M2.29 9.62A10 10 0 1 0 21.31 8.35\"/><path d=\"M16.24 7.76A6 6 0 1 0 8.23 16.67\"/><path d=\"M12 18h.01\"/><path d=\"M17.99 11.66A6 6 0 0 1 15.77 16.67\"/><circle cx=\"12\" cy=\"12\" r=\"2\"/><path d=\"m13.41 10.59 5.66-5.66\"/>",
  agents:
    "<path d=\"M12 8V4H8\"/><rect width=\"16\" height=\"12\" x=\"4\" y=\"8\" rx=\"2\"/><path d=\"M2 14h2\"/><path d=\"M20 14h2\"/><path d=\"M15 13v2\"/><path d=\"M9 13v2\"/>",
  ledger:
    "<path d=\"M13.744 17.736a6 6 0 1 1-7.48-7.48\"/><path d=\"M15 6h1v4\"/><path d=\"m6.134 14.768.866-.5 2 3.464\"/><circle cx=\"16\" cy=\"8\" r=\"6\"/>",
  content:
    "<path d=\"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z\"/><path d=\"M14 2v5a1 1 0 0 0 1 1h5\"/><path d=\"M10 9H8\"/><path d=\"M16 13H8\"/><path d=\"M16 17H8\"/>",
  crawlers:
    "<path d=\"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z\"/><path d=\"m9 12 2 2 4-4\"/>",
  webhooks:
    "<path d=\"M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2\"/><path d=\"m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06\"/><path d=\"m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8\"/>",
  doctor:
    "<rect width=\"8\" height=\"4\" x=\"8\" y=\"2\" rx=\"1\" ry=\"1\"/><path d=\"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2\"/><path d=\"m9 14 2 2 4-4\"/>",
};

/** One nav glyph at the portal's 16px, inheriting colour from the link. */
export const navIcon = (id) =>
  NAV_ICON[id]
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
      `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" ` +
      `class="nav-ico">${NAV_ICON[id]}</svg>`
    : "";

/**
 * An empty state, in the portal's shape: a dashed, tinted box with an icon tile above the line
 * that says what is absent. Every page had been hand-rolling the same `<div class="empty">`
 * markup — seven files, ten copies — which is the drift `$`/`esc`/`fmt6` were consolidated here
 * to stop, and the copies had already diverged on whether they carried a `<p>` at all.
 *
 * `icon` is a NAV_ICON id. `lead`/`body`/`foot` are TRUSTED HTML: callers escape their own
 * interpolations, the same contract as every other render helper here. `body` takes a string or
 * an array of paragraphs.
 */
export function emptyState({ icon, lead, body = "", foot = "" }) {
  // A block-level item is emitted as-is. Wrapping one in `<p>` is invalid — the parser closes the
  // paragraph before it and opens another after, so `<p><pre>…</pre></p>` silently became two empty
  // paragraphs around the block. It rendered, which is exactly why it would have gone unnoticed.
  const paras = (Array.isArray(body) ? body : [body])
    .filter(Boolean)
    .map((p) => (/^\s*<(pre|div|ul|ol|table|figure)\b/i.test(p) ? p : `<p>${p}</p>`))
    .join("");
  return (
    `<div class="empty">` +
    (icon ? `<span class="empty-ico">${navIcon(icon)}</span>` : "") +
    `<div class="lead">${lead}</div>` +
    paras +
    (foot ? `<p class="empty-foot">${foot}</p>` : "") +
    `</div>`
  );
}

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
      { href: "/crawlers", label: "Crawlers", id: "crawlers" },
      { href: "/webhooks", label: "Webhooks", id: "webhooks" },
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
          `${i.id === active ? ' aria-current="page"' : ""}>${navIcon(i.id)}<span>${esc(i.label)}</span></a>`,
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
    // The gate pill is operator posture, so the PUBLIC earnings page does not get one: a
    // visitor has no business reading whether this operator's gate is reachable, and there
    // is no /api/gate mounted in that mode to answer it honestly anyway.
    (nav
      ? `<div class="rail"><span class="gate-state"><span class="dot off" id="gateDot"></span>` +
        `<span id="gateState">checking gate</span></span>` +
        `<a class="rail-link" href="https://naulon.app" target="_blank" rel="noopener">naulon cloud ↗</a></div>`
      : `<div class="rail"><a class="rail-link" href="https://naulon.app" target="_blank" rel="noopener">naulon cloud ↗</a></div>`);

  if (nav) startGateRail();
}

/**
 * The rail's ONE source of truth, owned here rather than by each page.
 *
 * It used to take a label from whatever the page happened to be fetching, and three pages
 * had nothing to report but their own health: /ledger painted "settling live" off its SSE
 * socket, /requests and /agents painted "recording traffic" off their own fetch. Measured
 * with the gate down, those three showed a GREEN pill while the other five showed red —
 * and "settling live" beside a dead gate is not a soft truth, it is the opposite of one.
 * The four honest pages still spelled the same state four ways ("gate down — unreachable",
 * "gate down", "gate unreachable").
 *
 * So: one poller, one endpoint, one vocabulary. A page that cannot reach the console's own
 * API says so in its own #notice banner — that is a different fact from the gate's health
 * and it already has a better home than four words in the sidebar.
 */
const GATE_POLL_MS = 15_000;
let gateStarted = false;

async function readGate() {
  try {
    const r = await fetch("/api/gate", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const h = await r.json();
    // `detail` is gateHealth()'s own word for why — "unreachable", "timed out", "HTTP 502".
    setGate(h.up === true, h.up === true ? "gate up" : `gate down — ${h.detail || "unreachable"}`);
  } catch {
    // The console could not answer for the gate, so the honest report is that we do not
    // know — never "up", and never a red that blames the gate for the console's fault.
    setGate(null, "gate state unknown");
  }
}

function startGateRail() {
  // `poll` already owns the interval + the pause-while-hidden behaviour every other
  // repeating fetch here uses. Guarded because renderShell runs once per page, and a
  // second poller would double the gate's /healthz load for nothing.
  if (gateStarted) return;
  gateStarted = true;
  poll(readGate, GATE_POLL_MS);
}

/**
 * Paint the rail. NOT exported — `startGateRail` is the only caller, which is the whole
 * point: a page that can paint this can lie with it, and eight pages did.
 *
 * `up === null` means "we could not find out", which is a third state and must not read as
 * either a healthy gate or a broken one.
 */
function setGate(up, label) {
  const dot = $("#gateDot");
  const text = $("#gateState");
  if (!dot || !text) return;
  dot.classList.toggle("off", up !== true);
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
 * Warn before a full-page unload while `isDirty()` says there are unsaved edits.
 *
 * Both write pages hold their pending change in memory until Save, so leaving the page
 * discards it — the sidebar nav links and a closed tab are both full unloads. `/content`
 * had this guard from the start; `/crawlers` did not, and had exactly the same shape
 * (unsaved intent in a Map, an explicit Save, a restart-to-apply banner). Setting a
 * crawler to `block`, clicking Agents, and coming back silently put it on `default`
 * again, with no dialog — on the page you are likeliest to abandon mid-edit, because its
 * last row sits 2,283px below its only Save.
 *
 * So it lives here rather than in either page: a third write surface gets it by calling
 * one function, which is the only version of this that stays true.
 */
export function guardUnsaved(isDirty) {
  window.addEventListener("beforeunload", (e) => {
    if (!isDirty()) return;
    e.preventDefault();
    // Chrome/Safari still require the legacy assignment; the browser picks its own words.
    e.returnValue = "";
  });
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
