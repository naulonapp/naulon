/*
 * Doctor — client. Deliberately thin: the server decides every verdict and writes
 * every sentence (doctor.ts / test-toll.ts), so this file only paints rows and owns
 * two buttons. Nothing here interprets a status; if the wording is wrong, it is wrong
 * on the server where it can be unit-tested.
 */
import { $, esc, rel, renderShell, setGate } from "./shell.js";

renderShell({ active: "doctor" });

const ICON = { pass: "✓", warn: "!", fail: "✕" };

function renderChecks(report) {
  $("#headline").textContent = report.headline;
  $("#nPass").textContent = report.counts.pass;
  $("#nWarn").textContent = report.counts.warn;
  const fail = $("#nFail");
  fail.textContent = report.counts.fail;
  fail.classList.toggle("bad", report.counts.fail > 0);
  fail.classList.toggle("pos", report.counts.fail === 0);
  $("#checkedAt").textContent = `checked ${rel(report.at)} ago`;

  $("#checks").innerHTML = report.checks.map((c) => `
    <div class="check ${esc(c.status)}">
      <span class="check-mark" aria-hidden="true">${ICON[c.status] ?? "?"}</span>
      <div class="check-body">
        <div class="check-label">${esc(c.label)}</div>
        <div class="check-detail">${esc(c.detail)}</div>
        ${c.fix ? `<div class="check-fix">${esc(c.fix)}</div>` : ""}
      </div>
      <span class="badge ${esc(c.status)}">${esc(c.status)}</span>
    </div>`).join("");

  // The gate check owns the rail's state on this page.
  const gate = report.checks.find((c) => c.id === "gate");
  if (gate) setGate(gate.status === "pass", gate.status === "pass" ? "gate up" : "gate down");
}

async function load() {
  const btn = $("#rerunBtn");
  btn.disabled = true;
  btn.textContent = "checking…";
  try {
    const r = await fetch("/api/doctor", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    renderChecks(await r.json());
  } catch (e) {
    $("#headline").textContent = "The console could not run the checks.";
    $("#checks").innerHTML = `<div class="empty"><div class="lead">${esc(e.message)}</div></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Re-run";
  }
}

async function testToll() {
  const btn = $("#tollBtn");
  btn.disabled = true;
  btn.textContent = "probing…";
  $("#tollOut").innerHTML = "";
  try {
    const r = await fetch("/api/test-toll", { method: "POST", headers: { "content-type": "application/json" } });
    const p = await r.json();
    const tone = p.status === "pass" ? "synced" : p.status === "skipped" ? "" : "pending";
    $("#tollOut").innerHTML = `
      <div class="banner ${tone}">
        <b>${esc(p.summary)}</b>
        ${p.fix ? `<div class="toll-fix">${esc(p.fix)}</div>` : ""}
        ${p.url ? `<div class="toll-meta"><span class="mono">GET ${esc(p.url)}</span>${p.httpStatus ? ` → <span class="mono">${esc(p.httpStatus)}</span>` : ""}${p.verdict ? ` · <span class="mono">${esc(p.verdict)}</span>` : ""} · ${esc(p.elapsedMs)}ms</div>` : ""}
      </div>`;
  } catch (e) {
    $("#tollOut").innerHTML = `<div class="banner pending"><b>${esc(e.message)}</b></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Test toll";
  }
}

$("#rerunBtn").addEventListener("click", load);
$("#tollBtn").addEventListener("click", testToll);
load();
