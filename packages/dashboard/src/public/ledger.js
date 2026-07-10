/*
 * the ledger — client. Subscribes to /api/stream (SSE) and paints the live
 * earnings view. Kept dependency-free and same-origin so a strict CSP holds.
 *
 * Security: every value that comes from the ledger (author ids, slugs, wallet
 * and payer addresses) is HTML-escaped before it touches innerHTML. Slugs and
 * author ids originate from crawled URLs and tenant config, so treat them as
 * untrusted — esc() is the boundary.
 */
const $ = (s) => document.querySelector(s);

/** The XSS boundary. Escapes the five HTML-significant characters. */
function esc(v) {
  return String(v).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/**
 * Apply dynamic styles via the DOM API rather than inline `style=` attributes,
 * so the Content-Security-Policy needs no 'unsafe-inline' for styles — CSP only
 * governs inline `style=`/`<style>`, not programmatic style writes. data-i sets
 * the stagger index; data-w sets a bar width percentage.
 */
function hydrate(root) {
  root.querySelectorAll("[data-i]").forEach((el) => el.style.setProperty("--i", el.dataset.i));
  root.querySelectorAll("[data-w]").forEach((el) => { el.style.width = el.dataset.w + "%"; });
}

const fmt6 = (n) => Number(n).toFixed(6);
const usd = (n) => { const [w, f] = fmt6(n).split("."); return { w, f }; };
const trunc = (a) => (a.length > 12 ? a.slice(0, 6) + "…" + a.slice(-4) : a);
const rel = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return Math.floor(s) + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
};

let displayedTotal = 0, seen = new Set(), firstPaint = true;

function animateTotal(to) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const paint = (v) => {
    const { w, f } = usd(v);
    $("#total").innerHTML = `<span class="cur">$</span>${w}<span class="frac">.${f}</span>`;
    $("#total").setAttribute("aria-label", `$${fmt6(v)} settled to authors`);
  };
  if (reduce) { paint(to); displayedTotal = to; return; }
  const from = displayedTotal, t0 = performance.now(), dur = 700;
  (function step(t) {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    paint(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step); else displayedTotal = to;
  })(performance.now());
}

function renderLedger(authors) {
  const maxEarned = authors.reduce((m, a) => Math.max(m, a.earned), 0) || 1;
  $("#ledgerN").textContent = authors.length ? "by earnings" : "—";
  if (!authors.length) {
    $("#ledger").innerHTML =
      `<div class="empty"><div class="big">The ledger is quiet.</div>` +
      `<p>No machine has paid yet — run <code>npm run -w @naulon/dashboard seed</code> or the wayfarer.</p></div>`;
    return;
  }
  $("#ledger").innerHTML = authors.map((a, i) => {
    const { w, f } = usd(a.earned);
    const pct = ((a.earned / maxEarned) * 100).toFixed(1);
    const cls = firstPaint ? "row rise" : "row";
    return `<div class="${cls}" data-i="${i}">
      <div class="rank">${String(i + 1).padStart(2, "0")}</div>
      <div class="who"><div class="name">${esc(a.authorId)}</div>
        <div class="addr">${esc(trunc(a.wallet))}</div>
        <div class="meta">${a.events} crossing${a.events !== 1 ? "s" : ""} · last ${esc(rel(a.lastAt))}</div></div>
      <div class="earned"><div class="amt">$${w}<span class="frac">.${f}</span></div>
        <div class="bar" data-w="${pct}"></div></div>
    </div>`;
  }).join("");
  hydrate($("#ledger"));
}

function renderFeed(recent) {
  if (!recent.length) {
    $("#feed").innerHTML = `<div class="empty"><div class="big">Still waiting for the first fare.</div></div>`;
    return;
  }
  $("#feed").innerHTML = recent.map((c, i) => {
    const fresh = !firstPaint && !seen.has(c.id);
    const cls = "cross" + (fresh ? " fresh" : "") + (firstPaint ? " rise" : "");
    const kind = c.kind === "citation" ? "citation" : "read";
    const split = c.split.map((s) => `<span>${esc(s.authorId)} <b>$${fmt6(s.amount)}</b></span>`).join("");
    return `<div class="${cls}" data-i="${i}">
      <div class="when">${esc(rel(c.at))}</div>
      <div class="line"><span class="agent">${esc(trunc(c.payer))}</span>
        <span class="verb"> paid </span><span class="amt">$${fmt6(c.amount)}</span>
        <span class="verb"> for </span><span class="slug">${esc(c.slug)}</span>
        <span class="tag ${kind}">${esc(kind)}</span></div>
      <div class="split">${split}</div>
      <div class="prov">🎫 licensed · <b>${esc(trunc(c.id))}</b> · verifiable receipt</div>
    </div>`;
  }).join("");
  hydrate($("#feed"));
  recent.forEach((c) => seen.add(c.id));
}

function render(L) {
  animateTotal(L.totalSettled);
  $("#nCross").textContent = L.eventCount;
  $("#nAuthors").textContent = L.authorCount;
  renderLedger(L.authors);
  renderFeed(L.recent);
  firstPaint = false;
}

function setConn(ok) {
  $("#dot").classList.toggle("off", !ok);
  $("#conn").textContent = ok ? "settling live" : "offline";
}

const es = new EventSource("/api/stream");
es.addEventListener("ledger", (e) => { setConn(true); render(JSON.parse(e.data)); });
es.onerror = () => setConn(false);
es.onopen = () => setConn(true);
