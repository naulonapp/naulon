/*
 * Webhooks — the endpoints this gate reports settlements to, and whether the reports landed.
 * Reads /api/webhooks; the server owns the rollup (webhooks.ts), this only paints it.
 *
 * What is deliberately ABSENT is the point of the page: no create form, no delete, no enable
 * toggle, no reveal/rotate. Endpoints come from NAULON_WEBHOOK_ENDPOINTS, so the operator's own
 * .env is the write path — rendering controls that cannot write would be a lie about who owns the
 * configuration. What the hosted portal shows as controls, this shows as state.
 *
 * Security: every url, event type, error string and payload here originates outside this process
 * (env, or a receiving server's response body). All of it goes through esc() before it touches
 * innerHTML, and the signing secret arrives already masked — the server never sends it.
 */
import { $, esc, emptyState, renderShell, poll, timeTag } from "./shell.js";

renderShell({ active: "webhooks" });

let refresh = null;
let state = null;
/** Delivery ids whose payload is expanded. Kept across repaints, or a poll would collapse them. */
const opened = new Set();

/** Portal parity: delivered reads positive, failed destructive, exhausted a warning, pending neutral. */
const STATUS_CLASS = { delivered: "pass", pending: "", failed: "fail", exhausted: "warn" };

/** A dead letter is parked, not lost — say that, because "exhausted" alone sounds terminal. */
const STATUS_LABEL = { delivered: "delivered", pending: "queued", failed: "failed", exhausted: "dead-lettered" };

const EVENT_LABEL = {
  "settlement.completed": "settlement",
  "anomaly.detected": "anomaly",
  ping: "ping",
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/* ── the strip ─────────────────────────────────────────────────────────────── */

function renderStats(d) {
  const rows = d.deliveries;
  const count = (s) => rows.filter((r) => r.status === s).length;
  const cells = [
    ["endpoints", d.endpoints.length, ""],
    ["delivered", count("delivered"), "pos"],
    ["queued", count("pending"), ""],
    ["dead-lettered", d.deadLettered, d.deadLettered > 0 ? "bad" : ""],
  ];
  $("#stats").innerHTML = cells
    .map(([k, v, tone]) => `<div class="stat"><div class="stat-k">${esc(k)}</div><div class="stat-v ${esc(tone)}">${v}</div></div>`)
    .join("");
}

/* ── endpoints ─────────────────────────────────────────────────────────────── */

/** The state every fresh install is in: the machinery is there, nothing is pointed at it yet. */
function darkState() {
  return emptyState({
    icon: "webhooks",
    lead: "No endpoints configured, so nothing is sent.",
    body: [
      `This gate can post a signed <span class="mono">settlement.completed</span> to your own systems every time a citation settles. Point it somewhere by setting <span class="mono">NAULON_WEBHOOK_ENDPOINTS</span> and restarting:`,
      `<pre class="wh-recipe mono">NAULON_WEBHOOK_ENDPOINTS='[{"url":"https://your-server.example/naulon","secret":"whsec_…"}]'</pre>`,
    ],
    foot: "The secret signs the body so your server can prove the request came from this gate. Deliveries are retried with backoff and parked here if they run out of attempts — nothing is dropped silently.",
  });
}

function endpointRow(ep) {
  const failing = ep.consecutiveFailures > 0;
  const nums = [
    ["delivered", ep.counts.delivered, false],
    ["queued", ep.counts.pending, false],
    ["failed", ep.counts.failed, true],
    ["dead", ep.counts.exhausted, true],
  ]
    .map(([label, n, alarming]) => {
      const tone = n === 0 ? " zero" : alarming ? " bad" : "";
      return `<div class="kv"><span class="k">${esc(label)}</span><span class="v mono${tone}">${n}</span></div>`;
    })
    .join("");

  return `<div class="wh-ep">
    <div class="wh-ep-id">
      <div class="wh-ep-top">
        <span class="badge">signed</span>
        <code class="wh-url mono">${esc(ep.url)}</code>
        ${failing ? `<span class="badge fail">${esc(plural(ep.consecutiveFailures, "failure", "failures"))} in a row</span>` : ""}
      </div>
      <div class="wh-chips">${ep.eventTypes.map((e) => `<span class="wh-chip mono">${esc(EVENT_LABEL[e] ?? e)}</span>`).join("")}</div>
      <div class="wh-ep-meta">
        <span>signing key <span class="mono">${esc(ep.secretMasked)}</span></span>
        <span>${ep.hostFilter ? `only <span class="mono">${esc(ep.hostFilter)}</span>` : "every site this gate serves"}</span>
      </div>
    </div>
    <div class="wh-ep-right">
      <div class="wh-ep-nums">${nums}</div>
      <div class="wh-ep-act"><button type="button" class="btn" data-ping="${esc(ep.id)}">Send test ping</button></div>
    </div>
  </div>`;
}

function renderEndpoints(d) {
  const host = $("#endpoints");
  $("#endpointCount").textContent = d.configured ? plural(d.endpoints.length, "endpoint", "endpoints") : "";

  if (d.envError) {
    // The parser refuses malformed config loudly so a self-hoster learns before a settlement is
    // missed. Repeating its message verbatim is the whole value — it names the field and the row.
    host.innerHTML = `<div class="banner pending"><b>NAULON_WEBHOOK_ENDPOINTS could not be read, so no webhook is being sent.</b>
      <div class="toll-fix mono">${esc(d.envError)}</div>
      <div class="toll-fix">Fix the value and restart the gate. Until then this gate settles normally and simply reports nothing.</div></div>`;
    return;
  }
  host.innerHTML = d.configured ? d.endpoints.map(endpointRow).join("") : darkState();
}

/* ── deliveries ────────────────────────────────────────────────────────────── */

function deliveryRow(d) {
  const isOpen = opened.has(d.id);
  const status = `<span class="badge ${esc(STATUS_CLASS[d.status] ?? "")}">${esc(STATUS_LABEL[d.status] ?? d.status)}</span>`;
  const detail = isOpen
    ? `<tr class="wh-payload-row"><td colspan="6">
         <div class="wh-payload-head">
           <span class="eyebrow">payload</span>
           <button type="button" class="wh-link" data-copy="${esc(d.id)}">Copy</button>
         </div>
         <pre class="wh-payload mono">${esc(JSON.stringify(d.payload, null, 2))}</pre>
         ${d.lastError ? `<div class="wh-lasterr mono">${esc(d.lastError)}</div>` : ""}
       </td></tr>`
    : "";

  return `<tr>
    <td class="mono">${esc(EVENT_LABEL[d.eventType] ?? d.eventType)}</td>
    <td>${status}</td>
    <td class="mono dim">${d.lastStatusCode ?? "—"}</td>
    <td class="mono dim">${d.attemptCount}</td>
    <td class="dim">${timeTag(d.createdAt)}</td>
    <td class="wh-row-act">
      <button type="button" class="wh-link" data-toggle="${esc(d.id)}" aria-expanded="${isOpen}">${isOpen ? "Hide" : "View"} payload</button>
      ${d.status === "pending" ? "" : `<button type="button" class="wh-link accent" data-resend="${esc(d.id)}">Resend</button>`}
    </td>
  </tr>${detail}`;
}

function renderDeliveries(d) {
  const host = $("#deliveries");
  $("#deliveryCount").textContent = d.deliveries.length ? plural(d.deliveries.length, "delivery", "deliveries") : "";

  if (!d.deliveries.length) {
    host.innerHTML = emptyState({
      icon: "webhooks",
      lead: "Nothing has been sent yet.",
      body: d.configured
        ? "A delivery appears here the moment a citation settles. To check the path end to end without waiting for one, send a test ping above."
        : "Deliveries appear once an endpoint is configured.",
    });
    return;
  }

  host.innerHTML = `<div class="wh-scroll"><table class="wh-table">
    <thead><tr>
      <th scope="col">Event</th><th scope="col">Status</th><th scope="col">Code</th>
      <th scope="col">Attempts</th><th scope="col">When</th><th scope="col"></th>
    </tr></thead>
    <tbody>${d.deliveries.map(deliveryRow).join("")}</tbody>
  </table></div>`;
}

/* ── notices ───────────────────────────────────────────────────────────────── */

/**
 * Two kinds of notice share this slot, and they expire differently. An ACTION note ("queued",
 * "re-queued") must survive the 5s poll that follows it, or the operator's own click erases its
 * own confirmation. A CONNECTION error must NOT survive: once the next poll succeeds the message
 * is false, and a stale "could not read" banner sitting over a working page is worse than none.
 */
let noticeIsError = false;

function notice(html, isError = false) {
  noticeIsError = isError;
  $("#notice").innerHTML = html;
}

function clearErrorNotice() {
  if (!noticeIsError) return;
  noticeIsError = false;
  $("#notice").innerHTML = "";
}

/**
 * What actually happens after a ping, said honestly. The console ENQUEUES; the gate sends. So the
 * two states that would otherwise look like "the button did nothing" get named: a stopped gate, and
 * a sweep the operator has disabled.
 */
function queuedNote(d) {
  if (d.gate && d.gate.up === false) {
    return `<div class="banner pending"><b>Queued — but the gate is not running.</b>
      <div class="toll-fix">The console records deliveries; the gate is what sends them. This one will go out on the first sweep after the gate is back up.</div></div>`;
  }
  if (d.sweepIntervalMs === 0) {
    return `<div class="banner pending"><b>Queued — but the sweep is disabled.</b>
      <div class="toll-fix"><span class="mono">WEBHOOK_SWEEP_INTERVAL_MS</span> is 0, so nothing drives delivery on a timer. Something external has to run the sweep.</div></div>`;
  }
  const secs = Math.round(d.sweepIntervalMs / 1000);
  return `<div class="banner"><b>Test ping queued.</b>
    <div class="toll-fix">The gate sends it on its next sweep, within ${esc(secs)}s, signed with this endpoint's key. Watch the Deliveries table below for the result.</div></div>`;
}

/* ── data ──────────────────────────────────────────────────────────────────── */

async function tick() {
  try {
    const r = await fetch("/api/webhooks", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    state = d;
    renderStats(d);
    renderEndpoints(d);
    renderDeliveries(d);
    clearErrorNotice();
  } catch {
    notice(
      `<div class="banner pending">Could not read the webhook configuration. The console is up; the request that failed was <span class="mono">/api/webhooks</span>.</div>`,
      true,
    );
  }
}

/** POST a same-origin JSON body. The server's sameOrigin guard is the CSRF control. */
async function post(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}

document.addEventListener("click", async (e) => {
  const ping = e.target.closest("[data-ping]");
  if (ping) {
    ping.disabled = true;
    const { ok, data } = await post("/api/webhooks/ping", { endpointId: ping.dataset.ping });
    ping.disabled = false;
    notice(
      ok
        ? queuedNote({ ...state, sweepIntervalMs: data.sweepIntervalMs ?? state?.sweepIntervalMs })
        : `<div class="banner pending"><b>Could not queue the ping.</b><div class="toll-fix">${esc(data.error ?? "unknown error")}</div></div>`,
    );
    await refresh?.run();
    return;
  }

  const toggle = e.target.closest("[data-toggle]");
  if (toggle) {
    const id = toggle.dataset.toggle;
    if (opened.has(id)) opened.delete(id);
    else opened.add(id);
    if (state) renderDeliveries(state);
    return;
  }

  const copy = e.target.closest("[data-copy]");
  if (copy) {
    const row = state?.deliveries.find((d) => d.id === copy.dataset.copy);
    if (row) {
      await navigator.clipboard?.writeText(JSON.stringify(row.payload, null, 2)).catch(() => {});
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1800);
    }
    return;
  }

  const resend = e.target.closest("[data-resend]");
  if (resend) {
    resend.disabled = true;
    const { ok, data } = await post("/api/webhooks/resend", { deliveryId: resend.dataset.resend });
    if (!ok) {
      notice(`<div class="banner pending"><b>Could not re-queue that delivery.</b><div class="toll-fix">${esc(data.error ?? "unknown error")}</div></div>`);
    } else {
      notice(`<div class="banner"><b>Re-queued.</b><div class="toll-fix">It goes out on the gate's next sweep, with a fresh attempt budget.</div></div>`);
    }
    await refresh?.run();
  }
});

refresh = poll(tick, 5000);
