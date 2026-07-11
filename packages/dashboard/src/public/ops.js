/*
 * Operator console — polls /api/ops and paints health, traffic, config, and the
 * live request feed. Dependency-free, same-origin (strict CSP holds).
 *
 * Security: observations carry caller-controlled fields (slug, host, user-agent,
 * verified-agent). Every one is HTML-escaped before it touches innerHTML — esc()
 * is the boundary, same as the earnings view.
 */
const $ = (s) => document.querySelector(s);

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

const fmt6 = (n) => "$" + Number(n || 0).toFixed(6);
const trunc = (a) => (a && a.length > 12 ? a.slice(0, 6) + "…" + a.slice(-4) : a || "—");
const rel = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return Math.floor(s) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
};

let seen = new Set(), firstPaint = true;

function renderHealth(h) {
  const up = h && h.up;
  $("#gateDot").classList.toggle("off", !up);
  $("#gateState").textContent = up ? "gate up" : "gate down — " + esc(h?.detail || "unreachable");
}

function renderTiles(ops) {
  const v = ops.byVerdict || {};
  $("#tHumans").textContent = ops.humans ?? 0;
  $("#tDenied").textContent = v["denied"] ?? 0;
  $("#tPaid").textContent = v["paid"] ?? 0;
  const failed = v["payment-failed"] ?? 0;
  const f = $("#tFailed");
  f.textContent = failed;
  f.classList.toggle("bad", failed > 0);
  $("#tEarned").textContent = fmt6(ops.earnings);
  $("#tMissed").textContent = fmt6(ops.earningsMissed);
  const a = ops.agents || {};
  $("#agentSplit").textContent = `${a.verified || 0} verified · ${a.unverified || 0} unsigned · ${a.masquerade || 0} spoofed`;
  const hrs = Math.round((ops.windowMs || 0) / 3_600_000);
  $("#window").textContent = `last ${hrs}h`;
}

function renderConfig(cfg) {
  const src = cfg.creditsSource || {};
  const rows = [
    ["origin", esc(cfg.originUrl)],
    ["price", `${fmt6(cfg.priceUsdc)} <span class="dim">/read · ×${esc(cfg.citationMultiplier)} citation</span>`],
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
    $("#feed").innerHTML = `<div class="empty"><div class="big">No requests recorded yet.</div><p>Traffic appears here once an agent hits a tollable path (needs <code>OBSERVATIONS_BACKEND=jsonl</code>).</p></div>`;
    return;
  }
  $("#feed").innerHTML = recent.map((o) => {
    const fresh = !firstPaint && !seen.has(o.id);
    const who = o.classifiedAs === "agent"
      ? (o.verified ? `<span class="badge">✓ ${esc(o.verifiedAgent || "verified agent")}</span>` : o.sigInvalid ? `<span class="bad">spoofed signature</span>` : esc(o.agentUa || "unsigned agent"))
      : "human";
    const price = o.price != null ? `<div class="who"><span class="rprice">${fmt6(o.price)}</span></div>` : "";
    return `<div class="req ${fresh ? "fresh" : ""} rise">
      <div class="rt">${esc(rel(o.at))} ago</div>
      <div class="rmid"><div class="slug">${esc(o.slug || o.host || "—")}</div><div class="who">${who}</div>${price}</div>
      <div class="vd ${esc(o.verdict)}">${esc(o.verdict)}</div>
    </div>`;
  }).join("");
  recent.forEach((o) => seen.add(o.id));
}

async function tick() {
  try {
    const r = await fetch("/api/ops", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    renderHealth(d.health);
    renderTiles(d.ops);
    renderConfig(d.config);
    renderWarnings(d.config.warnings || []);
    renderFeed(d.ops.recent || []);
    firstPaint = false;
  } catch (e) {
    $("#gateState").textContent = "dashboard offline";
    $("#gateDot").classList.add("off");
  }
}

tick();
setInterval(tick, 4000);
