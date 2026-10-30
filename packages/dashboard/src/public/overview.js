/*
 * Operator console — polls /api/ops and paints health, traffic, config, and the
 * live request feed. Same-origin, no build (strict CSP holds).
 *
 * Security: observations carry caller-controlled fields (slug, host, user-agent,
 * verified-agent). Every one is HTML-escaped before it touches innerHTML — esc()
 * from shell.js is the boundary, same as the earnings view.
 */
import { $, esc, usd, rel, emptyState, renderShell, poll, sse, wireSeg, selfTestBadge, wireTestToll, VERDICT_TITLE } from "./shell.js";

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
  // Every frame is painted at the final figure's precision, so a count-up never changes width.
  const d = money ? usd(to).split(".")[1].length : 0;
  const paint = (v) => {
    el.textContent = money
      ? "$" + v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })
      : Math.round(v).toLocaleString("en-US");
  };
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
  // Seconds, then minutes, then hours: the text never outgrows "updated 59m ago", which the
  // label's fixed box holds, so a tick cannot move the controls beside it.
  $("#freshness").textContent =
    s < 1 ? "updated now" : s < 60 ? `updated ${s}s ago` : s < 3600 ? `updated ${Math.floor(s / 60)}m ago` : `updated ${Math.floor(s / 3600)}h ago`;
}

/** The four outcomes, in the order the Requests page draws them. */
const OUTCOMES = ["paid", "left", "free", "refused"];
const plural = (n, one, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * Every figure here is computed from observations. With OBSERVATIONS_BACKEND off there is
 * nothing to compute from, so a zero would not be a measurement but a missing one; the money
 * figure was the worst of it, reading $0 while the Ledger showed real settled USDC from the
 * same install. An unknown renders as an unknown.
 */
const FIGURE_IDS = ["#tEarned", "#tMissed", "#tAgents", "#tPaid", "#tDenied", "#tFree", "#tBlocked", "#tHumans"];
const FIGURE_CLASS = new Map(FIGURE_IDS.map((id) => [id, $(id).className]));

function windowLabel(ops) {
  const hrs = Math.round((ops.windowMs || 0) / 3_600_000);
  return hrs > 24 ? `last ${Math.round(hrs / 24)} days` : hrs === 1 ? "last hour" : `last ${hrs} hours`;
}

function blank(id, title) {
  const el = $(id);
  el.textContent = "—";
  // Strip the valence with the value: a dash left in the paid green still reads as a reading.
  el.classList.remove("bad", "pos", "warn");
  el.classList.add("dim");
  el.title = title;
}

function renderUnknownTiles(ops) {
  for (const id of FIGURE_IDS) blank(id, "Not recorded: OBSERVATIONS_BACKEND is off");
  $("#tPaidN").textContent = "Traffic is not recorded";
  $(".hero-foot").hidden = true;
  $("#tLeftN").textContent = "";
  $("#agentSplit").textContent = "";
  $("#chart").innerHTML = "";
  $("#chartAxis").innerHTML = "";
  $("#window").textContent = windowLabel(ops);
}

/**
 * Recording is on, this window recorded nothing, and the settlement ledger has crossings in
 * the same hours. That is the state you enter by turning recording on: every crossing settled
 * before the restart lives in the ledger and in no observation. The counters stay as measured;
 * the money figures dim, because the ledger contradicts them, and the notice says where the
 * money is.
 */
const settlementUnrecorded = (ops) => ops.total === 0 && (ops.settled?.crossings ?? 0) > 0;

/** Stacked columns, one per bucket. SVG attributes only: the CSP refuses inline style. */
function renderChart(series) {
  const buckets = series?.buckets || [];
  if (!buckets.length) { $("#chart").innerHTML = ""; $("#chartAxis").innerHTML = ""; return; }
  const totals = buckets.map((b) => OUTCOMES.reduce((n, k) => n + (b[k] || 0), 0));
  const peak = Math.max(1, ...totals);
  const W = 100 / buckets.length, H = 100, gap = Math.min(0.9, W * 0.18);
  let bars = "";
  buckets.forEach((b, i) => {
    let y = H;
    for (const k of OUTCOMES) {
      const h = ((b[k] || 0) / peak) * (H - 4);
      if (h <= 0) continue;
      y -= h;
      bars += `<rect class="o-${k}" x="${(i * W + gap / 2).toFixed(3)}" y="${y.toFixed(3)}" width="${(W - gap).toFixed(3)}" height="${h.toFixed(3)}" rx="0.4"><title>${esc(bucketLabel(series, i))}: ${b[k]} ${k}</title></rect>`;
    }
    if (totals[i] === 0) bars += `<rect class="o-none" x="${(i * W + gap / 2).toFixed(3)}" y="${H - 1}" width="${(W - gap).toFixed(3)}" height="1" />`;
  });
  $("#chart").innerHTML = `<svg viewBox="0 0 100 ${H}" preserveAspectRatio="none">${bars}</svg>`;
  $("#chart").classList.toggle("is-empty", totals.every((t) => t === 0));
  const ticks = [0, Math.floor(buckets.length / 2), buckets.length - 1];
  $("#chartAxis").innerHTML = ticks.map((i) => `<span>${esc(bucketLabel(series, i))}</span>`).join("");
}

function bucketLabel(series, i) {
  const t = new Date(series.start + i * series.stepMs);
  if (series.stepMs >= 6 * 3_600_000) return t.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
  return t.toLocaleTimeString(undefined, series.stepMs < 3_600_000 ? { hour: "numeric", minute: "2-digit" } : { hour: "numeric" });
}

/**
 * The sign's sentence: what this window says about the gate, in one line, then the line under it.
 * Money in the sentence is underlined in the sign's bronze, as the portal does.
 */
function renderVerdict(ops, observations) {
  const say = $("#vSay"), rest = $("#vRest");
  const win = windowLabel(ops);
  const agents = ops.agents?.total ?? 0;
  const paid = ops.byVerdict?.paid ?? 0;
  if (observations === "off") {
    say.textContent = "Traffic is not being recorded.";
    rest.innerHTML = "The gate still tolls and settles. Set <code>OBSERVATIONS_BACKEND=jsonl</code> and restart it to see every agent here.";
  } else if ((ops.earnings || 0) > 0) {
    say.innerHTML = `Agents paid <span class="term">${esc(usd(ops.earnings))}</span> in the ${esc(win)}.`;
    rest.textContent = `${plural(paid, "paid request")} of ${plural(agents, "agent request")}. People always read free.`;
  } else if (agents > 0) {
    say.textContent = "Agents came by, and none has paid yet.";
    rest.textContent = `${plural(agents, "agent request")} in the ${win}. People always read free.`;
  } else {
    say.textContent = "No agent has come by yet.";
    rest.textContent = "People always read free. Press Test toll to check the gate answers 402.";
  }
}

function renderTiles(ops, observations) {
  renderVerdict(ops, observations);
  // With recording off every figure is a dash under a sign that already says why; the figures
  // appear once there are some, as on the portal.
  $("#tiles").hidden = observations === "off" || ((ops.agents?.total ?? 0) === 0 && !((ops.earnings || 0) > 0));
  if (observations === "off") return renderUnknownTiles(ops);
  $(".hero-foot").hidden = false;
  for (const id of FIGURE_IDS) {
    const el = $(id);
    el.removeAttribute("title");
    el.className = FIGURE_CLASS.get(id);
  }
  const v = ops.byVerdict || {};
  const d = ops.demand || { reads: 0, atPrice: 0, signalledPayers: 0 };
  // An observed read is a `denied` row that was served anyway, so it is shown apart from the 402s.
  const left = Math.max(0, (v["denied"] ?? 0) - d.reads);
  const refused = (v["blocked"] ?? 0) + (v["payment-failed"] ?? 0) + (v["unservable"] ?? 0);
  const free = (ops.agents?.total ?? 0) - (v["paid"] ?? 0) - left - refused;
  countUp($("#tPaid"), v["paid"] ?? 0, false);
  countUp($("#tDenied"), left, false);
  countUp($("#tFree"), Math.max(0, free), false);
  countUp($("#tBlocked"), refused, false);
  $("#tBlocked").classList.toggle("bad", refused > 0);
  countUp($("#tHumans"), ops.humans ?? 0, false);
  countUp($("#tAgents"), ops.agents?.total ?? 0, false);
  $("#observedStat").hidden = d.reads === 0;
  $("#tObserved").textContent = String(d.reads);
  $("#tDemand").textContent = usd(d.atPrice);
  $("#tSignalled").textContent = String(d.signalledPayers);
  $("#tPaidN").textContent = `from ${plural(v["paid"] ?? 0, "paid request")}`;
  $("#tLeftN").textContent = left === 1 ? "1 agent saw the price and left" : `${left.toLocaleString("en-US")} agents saw the price and left`;
  const a = ops.agents || {};
  $("#agentSplit").textContent = `${a.verified || 0} verified · ${a.unverified || 0} unsigned` + (a.masquerade ? ` · ${a.masquerade} spoofed` : "");
  $("#window").textContent = windowLabel(ops);
  renderChart(ops.series);
  if (settlementUnrecorded(ops)) {
    for (const id of ["#tEarned", "#tMissed"]) blank(id, "Money settled in this window before the traffic log started. See the Ledger.");
    return;
  }
  countUp($("#tEarned"), ops.earnings || 0, true);
  countUp($("#tMissed"), ops.earningsMissed || 0, true);
}

const basename = (p) => String(p || "").split("/").pop();
const STORE_NAME = { jsonl: "local file", supabase: "Supabase", off: "off" };
const storeName = (k) => STORE_NAME[k] || k;

function renderConfig(cfg) {
  const src = cfg.creditsSource || {};
  const credits = src.mode === "fixture"
    ? `<span class="v-main mono" title="${esc(src.location)}">${esc(basename(src.location))}</span><span class="v-sub">local file</span>`
    : `<span class="v-main mono" title="${esc(src.location)}">${esc(src.location || "—")}</span><span class="v-sub">${esc(src.mode || "")}</span>`;
  const articles = Array.isArray(cfg.articles) && cfg.articles.length
    ? `<span class="v-sub">${cfg.articles.slice(0, 3).map((x) => esc(x.title || x.slug)).join(", ")}${cfg.articles.length > 3 ? ` and ${cfg.articles.length - 3} more` : ""}</span>`
    : "";
  const rows = [
    ["Origin", `<span class="v-main mono">${esc(cfg.originUrl)}</span>`],
    // Both prices as amounts, as the portal's site rows show them, so nobody multiplies "5×".
    ["Price", `<span class="v-main"><span class="money">${usd(cfg.priceUsdc)}</span> a read</span><span class="v-sub"><span class="money">${usd(cfg.priceUsdc * cfg.citationMultiplier)}</span> a citation</span>`],
    ["Credits", credits],
    ["Tollable", cfg.slugCount == null ? `<span class="v-main">decided by your credits API</span>` : `<span class="v-main">${plural(cfg.slugCount, "article")}</span>${articles}`],
    ["Recording", cfg.observations === "off"
      ? `<span class="v-main"><span class="state-dot off"></span>Off</span><span class="v-sub">set OBSERVATIONS_BACKEND=jsonl</span>`
      : `<span class="v-main"><span class="state-dot"></span>On</span><span class="v-sub">${esc(storeName(cfg.observations))}</span>`],
    ["Ledger", `<span class="v-main">${esc(storeName(cfg.events))}</span>`],
  ];
  $("#config").innerHTML = rows.map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("");
}

function renderWarnings(warnings) {
  $("#warnCount").innerHTML = warnings.length
    ? `<span class="badge denied">${plural(warnings.length, "issue")}</span>`
    : `<span class="badge paid">Ready to toll</span>`;
  $("#warnings").innerHTML = warnings.map((w) => `<div class="warn-row">${esc(w.message)}</div>`).join("");
}

function renderFeed(recent, observations) {
  if (observations === "off") {
    // The sign above already names the switch; this column says only what it will hold and
    // where settled money can be read meanwhile, rather than repeating the sentence.
    $("#feed").innerHTML = emptyState({
      icon: "requests",
      lead: "Agents appear here once recording is on.",
      foot: `Settled money is on the <a href="/ledger">Ledger</a>.`,
    });
    return;
  }
  if (!recent.length) {
    // The state every new install is in. Give the next action instead of an empty column.
    $("#feed").innerHTML = emptyState({
      icon: "requests",
      lead: "Agents appear here as they arrive.",
      body: [
        `A row appears the first time a crawler asks for a tollable page. To check the toll now, press <b>Test toll</b>: the console asks your gate for an article as a crawler and expects a <code>402</code>.`,
      ],
      foot: `<a href="/doctor">Doctor</a> checks everything else that decides whether this gate can earn.`,
    });
    return;
  }
  $("#feed").innerHTML = recent.slice(0, 8).map((o) => {
    const fresh = !firstPaint && !seen.has(o.id);
    const verdict = o.verdict;
    return `<a class="act ${fresh ? "fresh" : ""}" href="/requests?agent=${encodeURIComponent(o.agent || "")}&window=${currentWindow}">
      <span class="act-when">${esc(rel(o.at))}</span>
      <span class="act-who"><span class="act-name">${esc(o.agent || o.agentUa || "unsigned agent")}${o.verified ? ` <span class="badge paid">verified</span>` : o.sigInvalid ? ` <span class="badge blocked">spoofed</span>` : ""}${selfTestBadge(o)}</span><span class="act-path">${esc(o.path || (o.slug ? "/" + o.slug : "/"))}</span></span>
      <span class="act-out"><span class="badge ${esc(verdict)}">${esc(VERDICT_TITLE[verdict] || verdict)}</span>${o.price != null && verdict !== "agent-reread" ? `<span class="act-amt">${usd(o.price)}</span>` : ""}</span>
    </a>`;
  }).join("") + `<a class="feed-more" href="/requests">All requests</a>`;
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
    renderFeed(d.ops.recentAgents || [], d.config.observations);
    firstPaint = false;
    lastUpdate = Date.now();
    paintFreshness();
    // Pulse the freshness cue so a live refresh is visible even when no number moved.
    const fr = $("#freshness");
    fr.classList.remove("beat"); void fr.offsetWidth; fr.classList.add("beat");
    $("#notice").innerHTML = settlementUnrecorded(d.ops)
      ? `<div class="banner pending"><b>Some of this window's money settled before recording started.</b>` +
        `<div class="toll-fix">${plural(d.ops.settled.crossings, "payment")} worth ` +
        `<span class="mono">${usd(d.ops.settled.usdc || 0)}</span> are on the <a href="/ledger">Ledger</a> ` +
        `but not in the traffic log, so the figures here leave them out. New payments appear in both.</div></div>`
      : "";
  } catch {
    // Every figure on this page is now stale and nothing on it says so. The rail used to
    // carry this ("dashboard offline"), which was the wrong place — it reports the GATE —
    // and left this page as the only one with no error surface of its own.
    $("#notice").innerHTML =
      `<div class="banner pending"><b>These figures have stopped updating.</b>` +
      `<div class="toll-fix">The console could not reach <span class="mono">/api/ops</span>. ` +
      `Everything below is from the last answer it got.</div></div>`;
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
    renderFeed(ops.recentAgents || []);
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
