/*
 * Requests — the real tail, and the rollups that turn it into an answer. Reads
 * /api/traffic; the server owns every figure (traffic.ts), this only paints them.
 *
 * Security: observations carry caller-controlled fields (slug, host, user-agent).
 * Every one goes through esc() from shell.js before it touches innerHTML — the same
 * boundary the Overview uses. `agentLabel`/`selfTestBadge` return already-escaped HTML.
 */
import {
  $, esc, usd, rel, renderShell, setGate, poll, wireSeg, debounced,
  VERDICTS, VERDICT_LABEL, VERDICT_BAD, agentLabel, selfTestBadge,
} from "./shell.js";

renderShell({ active: "requests" });

let win = "24h";
let verdict = "";        // "" = all six
let q = "";
let refresh = null;

const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);

function renderVerdicts(byVerdict, matched) {
  $("#verdicts").innerHTML = VERDICTS.map((v) => {
    const n = byVerdict[v] ?? 0;
    return `<div class="stat">
      <div class="stat-k">${esc(VERDICT_LABEL[v])}</div>
      <div class="stat-v ${n > 0 && VERDICT_BAD.has(v) ? "bad" : ""}">${n}</div>
      <div class="stat-sub">${pct(n, matched)}%</div>
    </div>`;
  }).join("");
}

// `.roll`, not `.rank` — `.rank` is already the ledger's right-aligned position number.
function rollRow(name, meta, earned, missed) {
  return `<div class="roll">
    <div class="roll-name mono">${name}</div>
    <div class="roll-meta">${meta}</div>
    <div class="roll-money">
      <span class="pos">${usd(earned)}</span>
      ${missed > 0 ? `<span class="dim">${usd(missed)} missed</span>` : ""}
    </div>
  </div>`;
}

function renderPaths(rows) {
  $("#topPaths").innerHTML = rows.length
    ? rows.map((r) => rollRow(esc(r.slug), `${r.requests} req · ${r.paid} paid · ${r.servedFree} free`, r.earned, r.missed)).join("")
    : `<div class="panel-empty">No paths in this window.</div>`;
}

function renderAgents(rows) {
  $("#topAgents").innerHTML = rows.length
    ? rows.map((r) =>
        rollRow(
          esc(r.agent),
          `<span class="badge ${esc(r.identity)}">${esc(r.identity)}</span> ${r.requests} req · ${r.free} free · ${r.paid} paid`,
          r.earned,
          r.missed,
        ),
      ).join("")
    : `<div class="panel-empty">No agent traffic in this window.</div>`;
}

function renderMissed(m) {
  const total = m.denied.usdc + m.paymentFailed.usdc;
  if (total === 0 && m.denied.requests === 0 && m.paymentFailed.requests === 0) {
    $("#missed").innerHTML = `<div class="panel-empty">Nothing was left on the table in this window.</div>`;
    return;
  }
  // The two causes are different problems. `denied` is the toll working as designed —
  // an agent saw the price and chose not to pay. `payment-failed` is money that was
  // OFFERED and did not land, which is a fault worth chasing. One combined figure hides
  // the second inside the first, so they never share a row here.
  const head = `
    <div class="cause-row">
      <div class="cause">
        <div class="stat-k">refused to pay</div>
        <div class="mono-figure">${usd(m.denied.usdc)}</div>
        <div class="stat-sub">${m.denied.requests} request${m.denied.requests === 1 ? "" : "s"} — the toll working</div>
      </div>
      <div class="cause">
        <div class="stat-k">payment failed</div>
        <div class="mono-figure ${m.paymentFailed.requests > 0 ? "bad" : ""}">${usd(m.paymentFailed.usdc)}</div>
        <div class="stat-sub">${m.paymentFailed.requests} request${m.paymentFailed.requests === 1 ? "" : "s"} — they tried and could not</div>
      </div>
    </div>`;
  const rows = m.byPath.map((p) => `
    <div class="kv">
      <span class="k mono">${esc(p.slug)}</span>
      <span class="v">${usd(p.deniedUsdc)} refused${p.paymentFailed > 0 ? ` · <span class="bad">${usd(p.paymentFailedUsdc)} failed</span>` : ""}</span>
    </div>`).join("");
  $("#missed").innerHTML = head + rows;
}

function renderRows(rows, matched) {
  $("#tailCount").textContent =
    // Never let a capped list read as the whole truth.
    rows.length < matched ? `newest ${rows.length} of ${matched}` : `${matched} request${matched === 1 ? "" : "s"}`;
  if (!rows.length) {
    $("#rows").innerHTML = `<div class="empty">
      <div class="lead">Nothing matches.</div>
      <p>${q || verdict ? "Widen the filter, or try a longer window." : "No gated request has been recorded in this window yet."}</p>
      ${q || verdict ? "" : `<p class="empty-foot">If you expected traffic, <a href="/doctor">Doctor</a> checks whether recording is even switched on.</p>`}
    </div>`;
    return;
  }
  $("#rows").innerHTML = rows.map((o) => `
    <div class="req">
      <div class="rt">${esc(rel(o.at))} ago</div>
      <div class="rmid">
        <div class="slug">${esc(o.slug || o.host || "—")}${selfTestBadge(o)}</div>
        <div class="who">${agentLabel(o)}</div>
        ${o.classifyReason ? `<div class="reason mono">${esc(o.classifyReason)}</div>` : ""}
        ${o.price != null ? `<div class="who"><span class="rprice">${usd(o.price)}</span></div>` : ""}
      </div>
      <div class="badge ${esc(o.verdict)}">${esc(o.verdict)}</div>
    </div>`).join("");
}

function query() {
  const p = new URLSearchParams({ window: win });
  if (verdict) p.set("verdict", verdict);
  if (q) p.set("q", q);
  return p.toString();
}

async function tick() {
  try {
    const r = await fetch(`/api/traffic?${query()}`, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    renderVerdicts(d.byVerdict || {}, d.matched || 0);
    renderPaths(d.topPaths || []);
    renderAgents(d.topAgents || []);
    renderMissed(d.missed);
    renderRows(d.rows || [], d.matched || 0);
    setGate(true, "recording traffic");
    $("#notice").innerHTML = "";
  } catch {
    setGate(false, "dashboard offline");
    $("#notice").innerHTML = `<div class="banner pending">Could not read the traffic log. The console is up; the request that failed was <span class="mono">/api/traffic</span>.</div>`;
  }
}

// A filter change repaints immediately — waiting up to a poll interval for a keystroke
// to take effect reads as a broken input, not a slow one.
const reload = () => refresh?.run();

// The verdict filter is the same "pick one of N" act as the window, so it takes the same
// control. `all` first, then the six in the order the operator reads them.
$("#verdictSeg").innerHTML = [["", "all"], ...VERDICTS.map((v) => [v, VERDICT_LABEL[v]])]
  .map(([value, label], i) => `<button type="button" class="seg-btn${i === 0 ? " on" : ""}" data-verdict="${esc(value)}">${esc(label)}</button>`)
  .join("");

wireSeg($("#winSeg"), "win", (v) => {
  win = v;
  reload();
});
wireSeg($("#verdictSeg"), "verdict", (v) => {
  verdict = v;
  reload();
});

$("#q").addEventListener(
  "input",
  debounced((e) => {
    q = e.target.value.trim();
    reload();
  }),
);

$("#exportBtn").addEventListener("click", () => {
  // A plain navigation, so the browser's own download UI handles it — Content-Disposition
  // on the response does the rest. No blob, no object URL to leak.
  window.location.href = `/api/export?kind=observations&format=csv&window=${encodeURIComponent(win)}`;
});

refresh = poll(tick, 5000);
