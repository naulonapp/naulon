/*
 * Requests: what happened to every gated request, who asked, and what it was worth. Reads
 * /api/traffic; the server owns every figure (traffic.ts), this only paints them. The layout is
 * the hosted audit page's: a sentence, an outcome ribbon that is also the filter, the rollups,
 * and a paged table whose rows open in full.
 *
 * Security: observations carry caller-controlled fields (slug, host, user-agent). Every one goes
 * through esc() from shell.js before it touches innerHTML. The CSP forbids inline style
 * attributes, so widths and colours are set through the CSSOM after the markup lands.
 */
import { $, esc, usd, usdLead, rel, exactTime, emptyState, renderShell, poll, wireSeg, debounced, VERDICT_TITLE, live } from "./shell.js";

renderShell({ active: "requests" });

const OUTCOMES = ["paid", "left", "free", "refused"];
const OUTCOME_LABEL = { paid: "Paid", left: "Left at the price", free: "Read free", refused: "Refused or failed" };
const OUTCOME_OF = {
  paid: "paid",
  denied: "left",
  "served-free": "free",
  "agent-reread": "free",
  blocked: "refused",
  "payment-failed": "refused",
  unservable: "refused",
};
/** One sentence per verdict, for the drawer: what the gate did and why it matters. */
const VERDICT_MEANS = {
  paid: "The agent paid the price and got the page.",
  denied: "The agent was quoted a price and did not pay.",
  "served-free": "Read free: a person, or a crawler your rules let through.",
  "agent-reread": "A repeat read on a licence the agent already bought.",
  blocked: "Refused outright by your terms or crawler rules.",
  "payment-failed": "The agent offered payment and it did not settle.",
  unservable: "The agent paid, but the origin could not serve the page, so the sale was declined.",
};
const EXTRACTION = { gate: "Markdown made by naulon", passthrough: "Markdown from your origin", raw: "The page as served" };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ROW_DAYS = [1, 2, 3, 4, 5, 6, 0];

// A link can open the page already narrowed (`/requests?agent=GPTBot&window=7d`, from Agents).
const start = new URLSearchParams(location.search);
const state = {
  win: ["1h", "24h", "7d"].includes(start.get("window")) ? start.get("window") : "24h",
  q: "",
  outcome: ["paid", "left", "free", "refused"].includes(start.get("outcome")) ? start.get("outcome") : "",
  agent: start.get("agent") || "",
  slug: start.has("slug") ? start.get("slug") : undefined,
  identity: "",
  who: false,
  size: 50,
};
// The cursor each visited page started at; the last entry is the page on screen.
let trail = [null];
let next = null;
let rowsById = new Map();

const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);
const outcomeColor = (k) => `var(--o-${k})`;

function query() {
  const p = new URLSearchParams({ window: state.win, limit: String(state.size) });
  if (state.q) p.set("q", state.q);
  if (state.outcome) p.set("outcome", state.outcome);
  if (state.agent) p.set("agent", state.agent);
  if (state.slug !== undefined) p.set("slug", state.slug);
  if (state.identity) p.set("identity", state.identity);
  if (state.who) p.set("who", "all");
  const cur = trail[trail.length - 1];
  if (cur) {
    p.set("afterAt", String(cur.at));
    p.set("afterId", cur.id);
  }
  return p.toString();
}

/** Money first, each figure with the one line that makes it readable; the hosted audit page's lead. */
function renderLead(o, money) {
  $("#mEarned").textContent = usdLead(money.earned);
  $("#mMissed").textContent = usdLead(money.missed);
  $("#mEarnedNote").textContent = `from ${o.paid || 0} paid request${o.paid === 1 ? "" : "s"}`;
  $("#mMissedNote").textContent = `${o.left || 0} request${o.left === 1 ? "" : "s"} saw the price and walked away`;
}

function renderRibbon(o) {
  const total = OUTCOMES.reduce((n, k) => n + (o[k] || 0), 0);
  const ribbon = $("#ribbon");
  ribbon.classList.toggle("has-active", Boolean(state.outcome));
  live(ribbon).html = total
    ? OUTCOMES.filter((k) => o[k] > 0)
        .map((k) => `<a href="#" data-outcome="${k}" class="${state.outcome === k ? "on" : ""}" aria-label="${esc(OUTCOME_LABEL[k])}: ${o[k]}"></a>`)
        .join("")
    : "";
  for (const a of ribbon.querySelectorAll("a")) {
    a.style.flexGrow = String(o[a.dataset.outcome]);
    a.style.background = outcomeColor(a.dataset.outcome);
  }
  live($("#legend")).html = OUTCOMES.map(
    (k) => `<a href="#" data-outcome="${k}" class="${state.outcome === k ? "on" : ""}">
      <span class="k"><span class="sw" data-sw="${k}"></span>${esc(OUTCOME_LABEL[k])}</span>
      <span class="v">${o[k] || 0}<small>${pct(o[k] || 0, total)}%</small></span>
    </a>`,
  ).join("");
  for (const sw of $("#legend").querySelectorAll("[data-sw]")) sw.style.background = outcomeColor(sw.dataset.sw);
}

// `.roll`, not `.rank`: `.rank` is already the ledger's right-aligned position number.
function rollRow(name, meta, earned, missed, attrs) {
  return `<button type="button" class="roll roll-pick" ${attrs}>
    <div class="roll-name mono">${name}</div>
    <div class="roll-meta">${meta}</div>
    <div class="roll-money">
      <span class="pos">${usd(earned)}</span>
      ${missed > 0 ? `<span class="dim">${usd(missed)} missed</span>` : ""}
    </div>
  </button>`;
}

function renderPaths(rows) {
  live($("#topPaths")).html = rows.length
    ? rows.map((r) => rollRow(esc(r.slug), `${r.requests} req · ${r.paid} paid · ${r.servedFree} free`, r.earned, r.missed, `data-slug="${esc(r.slug === "(non-article)" ? "" : r.slug)}"`)).join("")
    : `<div class="panel-empty">No paths in this window.</div>`;
}

function renderAgents(rows) {
  live($("#topAgents")).html = rows.length
    ? rows
        .map((r) =>
          rollRow(
            esc(r.agent),
            `<span class="badge ${esc(r.identity)}">${esc(r.identity)}</span> ${r.operator ? esc(r.operator) + " · " : ""}${r.requests} req · ${r.free} free · ${r.paid} paid`,
            r.earned,
            r.missed,
            `data-agent="${esc(r.agent)}"`,
          ),
        )
        .join("")
    : `<div class="panel-empty">No agent traffic in this window.</div>`;
}

function renderMissed(m) {
  if (m.denied.requests === 0 && m.paymentFailed.requests === 0) {
    live($("#missed")).html = `<div class="panel-empty">Nothing was left on the table in this window.</div>`;
    return;
  }
  // The two causes are different problems. `denied` is the toll working as designed; a failed
  // payment is money that was OFFERED and did not land, a fault worth chasing. One combined figure
  // hides the second inside the first, so they never share a row.
  live($("#missed")).html = `
    <div class="cause-row">
      <div class="cause">
        <div class="stat-k">left at the price</div>
        <div class="mono-figure">${usd(m.denied.usdc)}</div>
        <div class="stat-sub">${m.denied.requests} request${m.denied.requests === 1 ? "" : "s"}, the toll working</div>
      </div>
      <div class="cause">
        <div class="stat-k">payment failed</div>
        <div class="mono-figure ${m.paymentFailed.requests > 0 ? "bad" : ""}">${usd(m.paymentFailed.usdc)}</div>
        <div class="stat-sub">${m.paymentFailed.requests} request${m.paymentFailed.requests === 1 ? "" : "s"}, they tried and could not</div>
      </div>
    </div>`;
}

function renderHeat(cells) {
  const max = Math.max(0, ...cells.flat());
  let peak = null;
  cells.forEach((row, d) => row.forEach((n, h) => { if (n > 0 && (!peak || n > peak.n)) peak = { d, h, n }; }));
  $("#heat").innerHTML =
    ROW_DAYS.map((d) => `<span class="l">${DAYS[d]}</span>` + cells[d].map((n, h) => `<span class="c" data-n="${n}" title="${DAYS[d]} ${String(h).padStart(2, "0")}:00, ${n} requests"></span>`).join("")).join("") +
    `<span></span>` + Array.from({ length: 24 }, (_, h) => `<span class="l">${h % 6 === 0 ? String(h).padStart(2, "0") : ""}</span>`).join("");
  for (const c of $("#heat").querySelectorAll(".c")) {
    const n = Number(c.dataset.n);
    if (n > 0) c.style.background = `color-mix(in oklab, var(--primary) ${Math.round(18 + (n / max) * 82)}%, var(--elev-2))`;
  }
  $("#peak").textContent = peak ? `busiest: ${DAYS[peak.d]} ${String(peak.h).padStart(2, "0")}:00 UTC, ${peak.n} requests` : "no agent requests in this window";
}

function renderRows(rows, matched) {
  rowsById = new Map(rows.map((o) => [o.id, o]));
  const first = rows.length ? (trail.length - 1) * state.size + 1 : 0;
  const last = (trail.length - 1) * state.size + rows.length;
  $("#range").textContent = `${first}–${last} of ${matched}`;
  $("#tailCount").textContent = `${matched} request${matched === 1 ? "" : "s"}`;
  $("#newer").disabled = trail.length === 1;
  $("#newest").disabled = trail.length === 1;
  $("#older").disabled = !next;
  if (!rows.length) {
    live($("#rows")).html = `<tbody><tr><td>${emptyState({
      icon: "requests",
      lead: "Nothing matches.",
      body: state.q || state.outcome || state.agent || state.slug !== undefined || state.identity ? "Widen the filter, or try a longer window." : "No gated request has been recorded in this window yet.",
      foot: `If you expected traffic, <a href="/doctor">Doctor</a> checks whether recording is even switched on.`,
    })}</td></tr></tbody>`;
    return;
  }
  live($("#rows")).html = `
    <thead><tr><th>When</th><th>Outcome</th><th>Agent</th><th>Path</th><th class="num">Amount</th></tr></thead>
    <tbody>${rows
      .map((o) => {
        const out = OUTCOME_OF[o.verdict] || "free";
        // An impostor on an unarmed site read free as a person; it is still a crawler claim.
        const who = o.classifiedAs === "agent"
          ? esc(o.agent || o.verifiedAgent || o.agentUa || "unsigned agent")
          : o.claimedOperator ? `${esc(o.agent || o.agentUa || o.claimedOperator)} (claimed)` : "a person";
        return `<tr data-id="${esc(o.id)}">
          <td><span class="mono">${esc(rel(o.at))} ago</span></td>
          <td><button type="button" class="linkish" data-open="${esc(o.id)}"><span class="dot-o" data-o="${out}"></span>${esc(VERDICT_TITLE[o.verdict] || o.verdict)}</button></td>
          <td>${who}${o.verified ? ` <span class="badge">✓</span>` : o.sigInvalid ? ` <span class="bad">spoofed</span>` : ""}${o.identityCheck === "forged" ? ` <span class="bad">impostor</span>` : ""}</td>
          <td><span class="path">${esc(o.path || (o.slug ? "/" + o.slug : "/"))}</span><span class="sub">${esc(o.host)}</span></td>
          <td class="num mono">${o.price != null ? usd(o.price) : "—"}</td>
        </tr>`;
      })
      .join("")}</tbody>`;
  for (const d of $("#rows").querySelectorAll("[data-o]")) d.style.background = outcomeColor(d.dataset.o);
}

function renderChips() {
  const chips = [];
  if (state.agent) chips.push(["agent", `agent: ${state.agent}`]);
  if (state.slug !== undefined) chips.push(["slug", `path: ${state.slug || "(non-article)"}`]);
  if (state.outcome) chips.push(["outcome", `outcome: ${OUTCOME_LABEL[state.outcome]}`]);
  live($("#chips")).html = chips.map(([k, label]) => `<button type="button" class="badge linkish" data-clear="${k}" aria-label="Clear ${esc(label)}">${esc(label)} ×</button>`).join(" ");
}

function openDrawer(o) {
  const out = OUTCOME_OF[o.verdict] || "free";
  const fact = (k, v, mono) => (v == null || v === "" ? "" : `<div class="fact"><dt>${esc(k)}</dt><dd class="${mono ? "mono" : ""}">${esc(v)}</dd></div>`);
  $("#drawer").innerHTML = `
    <div class="drawer-back" data-close></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
      <header>
        <div>
          <h2 id="drawer-title"><span class="dot-o" data-o="${out}"></span>${esc(VERDICT_TITLE[o.verdict] || o.verdict)}</h2>
          <p>${esc(VERDICT_MEANS[o.verdict] || "")}</p>
        </div>
        <button type="button" class="x" data-close aria-label="Close">×</button>
      </header>
      <div class="body">
        ${o.price != null ? `<p class="amount">${usd(o.price)}<small>${o.verdict === "paid" ? "paid" : "quoted"}</small></p>` : ""}
        <dl>
          ${fact("When", exactTime(o.at))}
          ${fact("Page", `${o.host}${o.path || (o.slug ? "/" + o.slug : "/")}`, true)}
          ${fact("Caller", o.classifiedAs === "agent" ? o.agent : o.claimedOperator ? `${o.agent || o.agentUa || o.claimedOperator} (claimed)` : "a person")}
          ${o.identityCheck && o.identityCheck !== "signature"
            ? fact("Address check", o.identityCheck === "forged"
              ? `outside the crawler's published addresses${o.forgedFrom ? ` (network ${o.forgedFrom})` : ""}`
              : o.identityCheck === "ip-verified" ? "inside the crawler's published addresses" : "not checked: no usable caller address, or no current address list")
            : ""}
          ${fact("Identity", o.verified ? `signed by ${o.verifiedAgent}, verified` : o.sigInvalid ? "a signature was presented and failed" : "not signed; the name comes from the user agent")}
          ${fact("User agent", o.agentUa, true)}
          ${fact("How it was classified", (o.classifyReason || "").replace(/^human \(seo allowlist matched ("[^"]*")\)/, "allowed crawler (matched $1)"), true)}
          ${fact("Why it failed", o.failureReason)}
          ${fact("Sent by", o.referrerHost, true)}
          ${fact("Served as", EXTRACTION[o.extraction] || o.extraction)}
          ${fact("Size", o.servedBytes != null && o.sourceBytes ? `${Math.round(o.servedBytes / 1024)} KB of a ${Math.round(o.sourceBytes / 1024)} KB page` : null)}
          ${fact("Request id", o.id, true)}
        </dl>
      </div>
      <footer>
        ${o.classifiedAs === "agent" ? `<button type="button" class="btn" data-only-agent="${esc(o.agent)}">Only this agent</button>` : ""}
        <button type="button" class="btn" data-only-slug="${esc(o.slug)}">Only this path</button>
      </footer>
    </aside>`;
  $("#drawer").querySelector(".drawer-back").addEventListener("click", closeDrawer);
  for (const d of $("#drawer").querySelectorAll("[data-o]")) d.style.background = outcomeColor(d.dataset.o);
  $("#drawer").querySelector("button[data-close]").focus();
}

function closeDrawer() {
  const opener = document.activeElement;
  $("#drawer").innerHTML = "";
  if (opener && opener.isConnected) opener.focus();
}

async function tick() {
  try {
    const r = await fetch(`/api/traffic?${query()}`, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    next = d.next || null;
    renderLead(d.outcomes || {}, d.money || { earned: 0, missed: 0 });
    renderRibbon(d.outcomes || {});
    renderPaths(d.topPaths || []);
    renderAgents(d.topAgents || []);
    renderMissed(d.missed);
    renderHeat(d.heatmap || []);
    renderRows(d.rows || [], d.matched || 0);
    renderChips();
    $("#notice").innerHTML = "";
  } catch {
    $("#notice").innerHTML = `<div class="banner pending">Could not read the traffic log. The console is up; the request that failed was <span class="mono">/api/traffic</span>.</div>`;
  }
}

/** A filter change is a new list: start at its head and repaint now, not at the next poll. */
const restart = () => {
  trail = [null];
  void tick();
};

for (const b of $("#winSeg").querySelectorAll(".seg-btn")) b.classList.toggle("on", b.dataset.win === state.win);
wireSeg($("#winSeg"), "win", (v) => {
  state.win = v;
  restart();
});
$("#q").addEventListener("input", debounced((e) => {
  state.q = e.target.value.trim();
  restart();
}));
$("#identity").addEventListener("change", (e) => {
  state.identity = e.target.value;
  restart();
});
$("#who").addEventListener("change", (e) => {
  state.who = e.target.checked;
  restart();
});
$("#size").addEventListener("change", (e) => {
  state.size = Number(e.target.value);
  restart();
});
$("#older").addEventListener("click", () => {
  if (!next) return;
  trail.push(next);
  void tick();
});
$("#newer").addEventListener("click", () => {
  if (trail.length > 1) trail.pop();
  void tick();
});
$("#newest").addEventListener("click", restart);

// One delegated listener for every drill: ribbon, legend, rollups, chips, rows and the drawer.
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-outcome],[data-agent],[data-slug],[data-clear],[data-open],[data-close],[data-only-agent],[data-only-slug],tr[data-id]");
  if (!t) return;
  if (t.dataset.outcome !== undefined) {
    e.preventDefault();
    state.outcome = state.outcome === t.dataset.outcome ? "" : t.dataset.outcome;
  } else if (t.dataset.agent !== undefined) state.agent = t.dataset.agent;
  else if (t.dataset.slug !== undefined) state.slug = t.dataset.slug;
  else if (t.dataset.clear) state[t.dataset.clear] = t.dataset.clear === "slug" ? undefined : "";
  else if (t.dataset.onlyAgent !== undefined) {
    state.agent = t.dataset.onlyAgent;
    closeDrawer();
  } else if (t.dataset.onlySlug !== undefined) {
    state.slug = t.dataset.onlySlug;
    closeDrawer();
  } else if (t.dataset.close !== undefined) return closeDrawer();
  else {
    const o = rowsById.get(t.dataset.open ?? t.dataset.id);
    if (o) openDrawer(o);
    return;
  }
  restart();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("#drawer").innerHTML) closeDrawer();
});

$("#exportBtn").addEventListener("click", () => {
  // A plain navigation, so the browser's own download UI handles it. No blob, no object URL.
  window.location.href = `/api/export?kind=observations&format=csv&window=${encodeURIComponent(state.win)}`;
});

// Only the newest page follows the log live. An older page stays exactly the rows it showed, or
// the list would shift under the reader every five seconds.
poll(() => (trail.length === 1 && !$("#drawer").innerHTML ? tick() : undefined), 5000);
