/*
 * Doctor — client. Deliberately thin: the server decides every verdict and writes
 * every sentence (doctor.ts / test-toll.ts), so this file only paints rows and owns
 * two buttons. Nothing here interprets a status; if the wording is wrong, it is wrong
 * on the server where it can be unit-tested.
 */
import { $, esc, rel, emptyState, renderShell, wireTestToll } from "./shell.js";

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
    $("#checks").innerHTML = emptyState({ icon: "doctor", lead: esc(e.message) });
  } finally {
    btn.disabled = false;
    btn.textContent = "Re-run";
  }
}

$("#rerunBtn").addEventListener("click", load);
wireTestToll();
load();
