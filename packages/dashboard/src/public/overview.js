/*
 * Operator console — polls /api/ops and paints health, traffic, config, and the
 * live request feed. Same-origin, no build (strict CSP holds).
 *
 * Security: observations carry caller-controlled fields (slug, host, user-agent,
 * verified-agent). Every one is HTML-escaped before it touches innerHTML — esc()
 * from shell.js is the boundary, same as the earnings view.
 */
import { $, $$, esc, usd, trunc, rel, renderShell, setGate, poll } from "./shell.js";

renderShell({ active: "overview" });

let seen = new Set(), firstPaint = true;
let currentWindow = "24h";      // traffic window (#winSeg) — sent to /api/ops
let lastUpdate = 0;             // epoch ms of the last good poll (liveness cue)
const prevNum = {};             // last displayed value per stat → count-up from it

// Count a stat from its previous value to the new one (matches the ledger total's
// count-up, so the console reads as one system). Snaps under reduced-motion / no change.
function countUp(el, to, money) {
  const from = prevNum[el.id] ?? 0;
  prevNum[el.id] = to;
  const paint = (v) => { el.textContent = money ? usd(v) : String(Math.round(v)); };
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || from === to) { paint(to); return; }
  const t0 = performance.now(), dur = 500;
  (function step(t) {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    paint(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  })(performance.now());
}

// Liveness cue — the poll is silent otherwise; show how stale the view is, ticking
// every second so a stalled dashboard is visible (the number keeps climbing).
function paintFreshness() {
  if (!lastUpdate) return;
  const s = Math.floor((Date.now() - lastUpdate) / 1000);
  $("#freshness").textContent = s < 1 ? "updated now" : `updated ${s}s ago`;
}

function renderHealth(h) {
  const up = !!(h && h.up);
  setGate(up, up ? "gate up" : "gate down — " + (h?.detail || "unreachable"));
}

function renderTiles(ops) {
  const v = ops.byVerdict || {};
  countUp($("#tHumans"), ops.humans ?? 0, false);
  countUp($("#tDenied"), v["denied"] ?? 0, false);
  const blocked = v["blocked"] ?? 0;
  const b = $("#tBlocked");
  countUp(b, blocked, false);
  b.classList.toggle("bad", blocked > 0);
  countUp($("#tPaid"), v["paid"] ?? 0, false);
  const failed = v["payment-failed"] ?? 0;
  const f = $("#tFailed");
  countUp(f, failed, false);
  f.classList.toggle("bad", failed > 0);
  countUp($("#tEarned"), ops.earnings || 0, true);
  countUp($("#tMissed"), ops.earningsMissed || 0, true);
  const a = ops.agents || {};
  $("#agentSplit").textContent = `${a.verified || 0} verified · ${a.unverified || 0} unsigned · ${a.masquerade || 0} spoofed`;
  const hrs = Math.round((ops.windowMs || 0) / 3_600_000);
  $("#window").textContent = hrs > 24 ? `last ${Math.round(hrs / 24)}d` : `last ${hrs}h`;
}

function renderConfig(cfg) {
  const src = cfg.creditsSource || {};
  const rows = [
    ["origin", esc(cfg.originUrl)],
    ["price", `${usd(cfg.priceUsdc)} <span class="dim">/read · ×${esc(cfg.citationMultiplier)} citation</span>`],
    ["credits", `<span class="dim">${esc(src.mode)}</span> ${esc(src.location)}`],
    ["tollable", cfg.slugCount == null ? `<span class="dim">dynamic (API)</span>` : `${cfg.slugCount} article${cfg.slugCount === 1 ? "" : "s"}`],
    ["observations", cfg.observations === "off" ? `<span class="dim">off — no traffic recorded</span>` : `<span class="ok">${esc(cfg.observations)}</span>`],
    ["events", esc(cfg.events)],
  ];
  let html = rows.map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("");
  if (Array.isArray(cfg.articles) && cfg.articles.length) {
    html += cfg.articles.map((a) =>
      `<div class="article"><span class="slug">${esc(a.title || a.slug)}</span><span class="w">${esc(trunc(a.wallets[0]))}${a.wallets.length > 1 ? ` +${a.wallets.length - 1}` : ""}</span></div>`,
    ).join("");
  }
  $("#config").innerHTML = html;
}

function renderWarnings(warnings) {
  $("#warnCount").textContent = warnings.length;
  $("#warnings").innerHTML = warnings.length
    ? warnings.map((w) => `<div class="warn-row">${esc(w)}</div>`).join("")
    : `<div class="warn-none">Nothing to flag — the gate is configured to toll.</div>`;
}

function renderFeed(recent) {
  if (!recent.length) {
    // The state every new install is in. Rather than an empty column, give them the
    // next action: prove the toll works, then check the config that decides it.
    $("#feed").innerHTML =
      `<div class="empty">
        <div class="lead">No requests recorded yet.</div>
        <p>That is normal on a fresh gate — a row appears here the first time a crawler
        hits a tollable path.</p>
        <p>To check it works without waiting for one, hit <b>Test toll</b> above: the
        console asks your own gate for an article while pretending to be a crawler and
        expects a <span class="mono">402</span>.</p>
        <p class="empty-foot"><a href="/doctor">Doctor</a> checks everything else that
        decides whether this gate can earn.</p>
      </div>`;
    return;
  }
  $("#feed").innerHTML = recent.map((o) => {
    const fresh = !firstPaint && !seen.has(o.id);
    const who = o.classifiedAs === "agent"
      ? (o.verified
          ? `<span class="badge">✓ ${esc(o.verifiedAgent || "verified agent")}</span>`
          : o.sigInvalid
            ? `<span class="bad">spoofed signature</span>`
            : esc(o.agentUa || "unsigned agent"))
      : "human";
    const price = o.price != null ? `<div class="who"><span class="rprice">${usd(o.price)}</span></div>` : "";
    // Test toll leaves real observations behind — it genuinely asks the gate for an
    // article and genuinely gets refused. Label them, or the operator wonders where
    // a handful of denials and some "missed" earnings came from.
    const selftest = (o.agentUa || "").includes("naulon-dashboard-selftest")
      ? `<span class="badge selftest">self-test</span>`
      : "";
    return `<div class="req ${fresh ? "fresh" : ""} rise">
      <div class="rt">${esc(rel(o.at))} ago</div>
      <div class="rmid"><div class="slug">${esc(o.slug || o.host || "—")}${selftest}</div><div class="who">${who}</div>${price}</div>
      <div class="badge ${esc(o.verdict)}">${esc(o.verdict)}</div>
    </div>`;
  }).join("");
  recent.forEach((o) => seen.add(o.id));
}

async function tick() {
  try {
    const r = await fetch(`/api/ops?window=${currentWindow}`, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    renderHealth(d.health);
    renderTiles(d.ops);
    renderConfig(d.config);
    renderWarnings(d.config.warnings || []);
    renderFeed(d.ops.recent || []);
    firstPaint = false;
    lastUpdate = Date.now();
    paintFreshness();
    // Pulse the freshness cue so a live refresh is visible even when no number moved.
    const fr = $("#freshness");
    fr.classList.remove("beat"); void fr.offsetWidth; fr.classList.add("beat");
  } catch {
    setGate(false, "dashboard offline");
  }
}

/**
 * Test toll — the server does the probing and writes every sentence (test-toll.ts);
 * this only renders the answer. Shared shape with the Doctor page on purpose.
 */
async function testToll() {
  const btn = $("#tollBtn");
  btn.disabled = true;
  btn.textContent = "probing…";
  $("#tollOut").innerHTML = "";
  try {
    const r = await fetch("/api/test-toll", { method: "POST", headers: { "content-type": "application/json" } });
    const p = await r.json();
    const tone = p.status === "pass" ? "synced" : p.status === "skipped" ? "" : "pending";
    $("#tollOut").innerHTML =
      `<div class="banner ${tone}"><b>${esc(p.summary)}</b>` +
      (p.fix ? `<div class="toll-fix">${esc(p.fix)}</div>` : "") +
      (p.url
        ? `<div class="toll-meta"><span class="mono">GET ${esc(p.url)}</span>` +
          (p.httpStatus ? ` → <span class="mono">${esc(p.httpStatus)}</span>` : "") +
          (p.verdict ? ` · <span class="mono">${esc(p.verdict)}</span>` : "") +
          ` · ${esc(p.elapsedMs)}ms</div>`
        : "") +
      `</div>`;
  } catch (e) {
    $("#tollOut").innerHTML = `<div class="banner pending"><b>${esc(e.message)}</b></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Test toll";
  }
}

$("#tollBtn").addEventListener("click", testToll);

const loop = poll(tick, 4000);

// Traffic-window selector — refetch immediately on change.
$$(".seg-btn", $("#winSeg")).forEach((b) =>
  b.addEventListener("click", () => {
    currentWindow = b.dataset.win;
    $$(".seg-btn", $("#winSeg")).forEach((x) => x.classList.toggle("on", x === b));
    void loop.run();
  }),
);

setInterval(paintFreshness, 1000); // keep the "updated Ns ago" cue climbing between polls
