/*
 * Operator console — polls /api/ops and paints health, traffic, config, and the
 * live request feed. Same-origin, no build (strict CSP holds).
 *
 * Security: observations carry caller-controlled fields (slug, host, user-agent,
 * verified-agent). Every one is HTML-escaped before it touches innerHTML — esc()
 * from shell.js is the boundary, same as the earnings view.
 */
import { $, esc, usd, trunc, rel, emptyState, renderShell, poll, sse, wireSeg, agentLabel, selfTestBadge, wireTestToll } from "./shell.js";

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

/**
 * Every number on this row is computed from observations, and OBSERVATIONS_BACKEND
 * defaults to `off`. With it off there is nothing to compute from, so a zero here is not
 * a measurement — it is a missing one. The money tile was the worst of it: it read
 * $0.000000 while the Ledger page showed real settled USDC from the same install, which
 * is the console contradicting itself about money on the page the operator lands on.
 * An unknown renders as an unknown.
 */
const TILE_IDS = ["#tHumans", "#tDenied", "#tBlocked", "#tPaid", "#tFailed", "#tEarned", "#tMissed"];
/** Each tile's markup-declared classes, so the unknown state can hand them back. */
const TILE_CLASS = new Map(TILE_IDS.map((id) => [id, $(id).className]));

function renderUnknownTiles(ops) {
  for (const id of TILE_IDS) {
    const el = $(id);
    el.textContent = "—";
    // Strip the valence with the value. A dash left in the "paid" green or the "denied"
    // amber still reads as a reading — measured at rgb(43,245,160) and rgb(255,176,32)
    // before this line existed.
    el.classList.remove("bad", "pos", "warn");
    el.classList.add("dim");
    el.title = "Not recorded — OBSERVATIONS_BACKEND is off";
  }
  $("#agentSplit").textContent = "not recorded";
  const hrs = Math.round((ops.windowMs || 0) / 3_600_000);
  $("#window").textContent = hrs > 24 ? `last ${Math.round(hrs / 24)}d` : `last ${hrs}h`;
}

/**
 * Recording is ON, this window recorded nothing, and the SETTLEMENT ledger has crossings
 * in the same hours. The counters are then honestly zero and the money tiles are not: the
 * gate did earn, the observation log just wasn't keeping the receipt yet.
 *
 * This is the state you enter by taking the console's own advice. With OBSERVATIONS_BACKEND
 * off the empty state says "set it to jsonl and restart" — do that, and every crossing
 * settled before the restart lives in the ledger and in no observation. Measured: the
 * tiles read PAID 0 / EARNED $0.000000 / "$0.000000 left on the table" while /ledger read
 * $0.039000 across 11 crossings stamped 2m, 6m and 13m ago. Turning the telemetry on made
 * the headline LESS true than leaving it off, which is the opposite of the trade an
 * operator thinks they are making.
 */
const settlementUnrecorded = (ops) => ops.total === 0 && (ops.settled?.crossings ?? 0) > 0;

/**
 * The counters stay as measured — no traffic WAS recorded, and saying so is true. The two
 * money tiles do not, because the ledger contradicts them: they dim to a dash and the
 * notice below says where the money actually is.
 */
function renderUnrecordedSettlement(ops) {
  const v = ops.byVerdict || {};
  countUp($("#tHumans"), ops.humans ?? 0, false);
  countUp($("#tDenied"), v["denied"] ?? 0, false);
  countUp($("#tBlocked"), v["blocked"] ?? 0, false);
  countUp($("#tPaid"), v["paid"] ?? 0, false);
  countUp($("#tFailed"), v["payment-failed"] ?? 0, false);
  for (const id of ["#tEarned", "#tMissed"]) {
    const el = $(id);
    el.textContent = "—";
    el.classList.remove("bad", "pos", "warn");
    el.classList.add("dim");
    el.title = "Settled money in this window predates the traffic log — see the Ledger";
  }
  const a = ops.agents || {};
  $("#agentSplit").textContent = `${a.verified || 0} verified · ${a.unverified || 0} unsigned · ${a.masquerade || 0} spoofed`;
  const hrs = Math.round((ops.windowMs || 0) / 3_600_000);
  $("#window").textContent = hrs > 24 ? `last ${Math.round(hrs / 24)}d` : `last ${hrs}h`;
}

function renderTiles(ops, observations) {
  if (observations === "off") return renderUnknownTiles(ops);
  for (const id of TILE_IDS) {
    const el = $(id);
    el.removeAttribute("title");
    el.className = TILE_CLASS.get(id);
  }
  if (settlementUnrecorded(ops)) return renderUnrecordedSettlement(ops);
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
    ? warnings.map((w) => `<div class="warn-row">${esc(w.message)}</div>`).join("")
    : `<div class="warn-none">Nothing to flag — the gate is configured to toll.</div>`;
}

function renderFeed(recent, observations) {
  if (observations === "off") {
    // Not the fresh-gate state: with recording off, no crawler will ever put a row here,
    // so promising one is a dead end. Name the switch instead, and say where the money
    // that DID settle can still be read.
    $("#feed").innerHTML = emptyState({
      icon: "requests",
      lead: "Traffic is not being recorded.",
      body: [
        `<span class="mono">OBSERVATIONS_BACKEND</span> is <span class="mono">off</span>, which is the default. The gate is still tolling and settling — it just isn't keeping the log this panel and the counters above are built from, so no request will appear here however many crawlers arrive.`,
        `Set <span class="mono">OBSERVATIONS_BACKEND=jsonl</span> and restart the gate to start recording who was served, denied, and paid.`,
      ],
      foot: `Money that already settled is on the <a href="/ledger">Ledger</a> — that reads the event log, not this one.`,
    });
    return;
  }
  if (!recent.length) {
    // The state every new install is in. Rather than an empty column, give them the
    // next action: prove the toll works, then check the config that decides it.
    $("#feed").innerHTML = emptyState({
      icon: "requests",
      lead: "No requests recorded yet.",
      body: [
        "That is normal on a fresh gate — a row appears here the first time a crawler hits a tollable path.",
        `To check it works without waiting for one, hit <b>Test toll</b> above: the console asks your own gate for an article while pretending to be a crawler and expects a <span class="mono">402</span>.`,
      ],
      foot: `<a href="/doctor">Doctor</a> checks everything else that decides whether this gate can earn.`,
    });
    return;
  }
  $("#feed").innerHTML = recent.map((o) => {
    const fresh = !firstPaint && !seen.has(o.id);
    const price = o.price != null ? `<div class="who"><span class="rprice">${usd(o.price)}</span></div>` : "";
    return `<div class="req ${fresh ? "fresh" : ""} rise">
      <div class="rt">${esc(rel(o.at))} ago</div>
      <div class="rmid"><div class="slug">${esc(o.slug || o.host || "—")}${selfTestBadge(o)}</div><div class="who">${agentLabel(o)}</div>${price}</div>
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
    renderTiles(d.ops, d.config.observations);
    renderConfig(d.config);
    renderWarnings(d.config.warnings || []);
    renderFeed(d.ops.recent || [], d.config.observations);
    firstPaint = false;
    lastUpdate = Date.now();
    paintFreshness();
    // Pulse the freshness cue so a live refresh is visible even when no number moved.
    const fr = $("#freshness");
    fr.classList.remove("beat"); void fr.offsetWidth; fr.classList.add("beat");
    $("#notice").innerHTML = settlementUnrecorded(d.ops)
      ? `<div class="banner pending"><b>This window settled money the traffic log never saw.</b>` +
        `<div class="toll-fix">${d.ops.settled.crossings} crossing(s) worth ` +
        `<span class="mono">$${(d.ops.settled.usdc || 0).toFixed(6)}</span> are in the settlement ledger and in no ` +
        `observation — recording was switched on after they happened. The counters above are ` +
        `right; the money is on the <a href="/ledger">Ledger</a>. New crossings appear in both.</div></div>`
      : "";
  } catch {
    // Every figure on this page is now stale and nothing on it says so. The rail used to
    // carry this ("dashboard offline"), which was the wrong place — it reports the GATE —
    // and left this page as the only one with no error surface of its own.
    $("#notice").innerHTML =
      `<div class="banner pending"><b>These figures have stopped updating.</b>` +
      `<div class="toll-fix">The console could not read <span class="mono">/api/ops</span>. ` +
      `Everything below is the last answer it got.</div></div>`;
  }
}

// The server does the probing and writes every sentence (test-toll.ts); the control and
// its rendering are shell.js's, shared with the Doctor page. This page only mounts it.
wireTestToll();

const loop = poll(tick, 4000);

/**
 * Traffic over SSE. The ledger already streamed while traffic polled, so the two halves
 * of this screen moved on different clocks and the request feed could sit up to a poll
 * interval behind the money. The poll stays — it owns health, config and warnings, which
 * change on a human timescale — but the counters and the feed now repaint the moment the
 * gate records anything.
 *
 * The stream is re-opened on a window change because the cutoff is applied server-side.
 */
let opsStream = null;
function streamOps() {
  opsStream?.close();
  opsStream = sse(`/api/stream/ops?window=${encodeURIComponent(currentWindow)}`, (_name, ops) => {
    renderTiles(ops);
    renderFeed(ops.recent || []);
    firstPaint = false;
    lastUpdate = Date.now();
    paintFreshness();
  }, ["ops"]);
}
streamOps();

// Traffic-window selector — refetch and re-subscribe immediately on change.
wireSeg($("#winSeg"), "win", (v) => {
  currentWindow = v;
  void loop.run();
  streamOps();
});

setInterval(paintFreshness, 1000); // keep the "updated Ns ago" cue climbing between polls
