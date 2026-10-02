/*
 * Agents — the identity split given its own surface. Reads /api/agents; the server
 * owns the rollup (traffic.ts), this only paints it.
 *
 * Security: agent keys are caller-controlled (a raw User-Agent, when unsigned). Every
 * one goes through esc() from shell.js before it touches innerHTML.
 */
import { $, esc, usd, rel, emptyState, renderShell, poll, wireSeg, debounced, live } from "./shell.js";

renderShell({ active: "agents" });

let win = "24h";
let q = "";
let refresh = null;

const pct = (n, total) => (total ? `${Math.round((n / total) * 100)}% of agent traffic` : "");

/** The crawler registry's purposes, in the words the hosted audit page uses. */
const PURPOSE = {
  "ai-training": "AI training",
  "ai-assistant": "AI assistant",
  search: "search",
  archiver: "archive",
  seo: "SEO",
};

const IDENTITY_NOTE = {
  verified: "signature verified",
  unsigned: "no signature — the user-agent is a claim, not proof",
  masquerade: "presented a signature that failed to verify",
};

function renderSplit(s) {
  $("#sTotal").textContent = s.total;
  $("#sVerified").textContent = s.verified;
  $("#sUnsigned").textContent = s.unsigned;
  $("#sMasq").textContent = s.masquerade;
  $("#sVerifiedPct").textContent = pct(s.verified, s.total);
  $("#sUnsignedPct").textContent = pct(s.unsigned, s.total);
  $("#sMasq").classList.toggle("bad", s.masquerade > 0);
  $("#sForged").textContent = s.forged ?? 0;
  $("#sForged").classList.toggle("bad", (s.forged ?? 0) > 0);

  // A masquerade is not a misconfiguration on the operator's side, so it gets a
  // statement of fact and no "fix" — there is nothing for them to change. Saying
  // nothing at all would be worse: this is the one number on the page that means
  // somebody is actively lying about who they are.
  live($("#masqNote")).html = s.masquerade
    ? `<div class="banner pending"><b>${s.masquerade} request${s.masquerade === 1 ? "" : "s"} presented a signature that did not verify.</b>
       <div class="toll-fix">That is a different thing from unsigned traffic: a key was claimed and the claim failed. The gate already refused to treat them as verified — nothing is broken on your side. The rows below name which agent string it was.</div></div>`
    : "";
}

/**
 * The six counts, always all six, always in this order. Hiding a zero used to feel
 * tidier and made the table unreadable: the columns shifted from row to row, so
 * "4" under one row's `refused` sat under the next row's `failed`. A zero is a fact
 * here — "0 blocked" is something the operator wants to be able to read off.
 */
const NUM_CELLS = [
  ["requests", (r) => r.requests, false],
  ["free", (r) => r.free, false],
  ["paid", (r) => r.paid, false],
  // The Requests page and the hosted audit page call a 402 walk-away "left at the price" and a
  // 403 "refused". This table used "refused" for the walk-away, so one word meant two outcomes.
  // Short forms of the same words, so seven columns fit.
  ["left", (r) => r.denied, false],
  ["failed", (r) => r.paymentFailed, true],
  ["unserved", (r) => r.unservable ?? 0, true],
  ["refused", (r) => r.blocked, false],
];

const numCells = (r) =>
  NUM_CELLS.map(([label, get, alarming]) => {
    const n = get(r);
    const tone = n === 0 ? " zero" : alarming ? " bad" : "";
    return `<div class="kv"><span class="k">${esc(label)}</span><span class="v mono${tone}">${n}</span></div>`;
  }).join("");

function renderAgents(rows) {
  $("#agentCount").textContent = `${rows.length} agent${rows.length === 1 ? "" : "s"}`;
  if (!rows.length) {
    live($("#agents")).html = emptyState({
      icon: "agents",
      lead: "No agent traffic in this window.",
      body: q ? "Nothing matches that filter." : "Humans do not appear here — they read free, always, and there is nothing to act on.",
      foot: q ? "" : `If you expected crawlers, <a href="/doctor">Doctor</a> checks whether traffic is being recorded at all.`,
    });
    return;
  }
  live($("#agents")).html = rows.map((r) => `
    <a class="agent-row agent-link" href="/requests?${esc(new URLSearchParams({ agent: r.agent, window: win }).toString())}" aria-label="${esc(`See ${r.agent}'s requests`)}">
      <div class="agent-id">
        <div class="rank-name mono">${esc(r.agent)}</div>
        <div class="rank-meta"><span class="badge ${esc(r.identity)}">${esc(r.identity)}</span> ${esc(IDENTITY_NOTE[r.identity] ?? "")}</div>
        ${r.operator ? `<div class="rank-meta">${esc(r.operator)} · ${esc(PURPOSE[r.purpose] ?? r.purpose ?? "")}</div>` : ""}
      </div>
      <div class="agent-nums">${numCells(r)}</div>
      <div class="agent-money">
        <div class="mono-figure pos">${usd(r.earned)}</div>
        ${r.missed > 0 ? `<div class="stat-sub">${usd(r.missed)} missed</div>` : ""}
        <div class="stat-sub">last seen ${esc(rel(r.lastAt))} ago</div>
      </div>
    </a>`).join("");
}

async function tick() {
  try {
    const p = new URLSearchParams({ window: win });
    if (q) p.set("q", q);
    const r = await fetch(`/api/agents?${p}`, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    renderSplit(d.split || { total: 0, verified: 0, unsigned: 0, masquerade: 0 });
    renderAgents(d.agents || []);
    $("#notice").innerHTML = "";
  } catch {
    $("#notice").innerHTML = `<div class="banner pending">Could not read the traffic log. The console is up; the request that failed was <span class="mono">/api/agents</span>.</div>`;
  }
}

wireSeg($("#winSeg"), "win", (v) => {
  win = v;
  refresh?.run();
});

$("#q").addEventListener(
  "input",
  debounced((e) => {
    q = e.target.value.trim();
    refresh?.run();
  }),
);

refresh = poll(tick, 5000);
