/*
 * Sites: every connection this gate issued, grouped by the site it acts for, and the revoke the
 * approve page promises. Reads /api/sites; the server owns the grouping (sites.ts).
 *
 * The page never holds a credential. It has each connection's id (a SHA-256, what the gate stores
 * it under) and its last four characters, which is what a site owner can match against their copy.
 *
 * Revoke is two steps in place, like Save on Content: the first press says what will happen, the
 * second does it. Focus moves to the confirm, Escape backs out to the button that opened it, and
 * the outcome is announced in #notice, because the row the focus was on is gone.
 *
 * Security: site, app name and approver come from outside this process (a site's client document,
 * an account name). All of it goes through esc() before innerHTML.
 */
import { $, esc, emptyState, renderShell, poll, timeTag } from "./shell.js";

renderShell({ active: "sites" });

/** GitLab's runner thresholds, for the same question: is the thing holding this token still alive? */
const QUIET_MS = 7 * 24 * 3_600_000;

let state = null;
let refresh = null;
/** The connection whose revoke is awaiting its second press. Survives repaints, or a poll would drop it. */
let confirming = null;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** What "last asked" means is only as fresh as the gate records it, so the page says the hour, not the second. */
function seenLine(c, now, everyMs) {
  if (c.lastSeenAt === null) return `<span class="badge">not used yet</span>`;
  const age = now - c.lastSeenAt;
  if (age < everyMs) return `<span class="badge pass">asked this gate within the hour</span>`;
  const tone = age >= QUIET_MS ? "warn" : "";
  return `<span class="badge ${tone}">last asked ${timeTag(c.lastSeenAt)}</span>`;
}

function connectionRow(site, c, now, d) {
  const isConfirming = confirming === c.id;
  const action = isConfirming
    ? `<div class="confirm" role="group" aria-label="Confirm revoke">` +
      `<span>Revoke this connection? ${esc(site.host)} reads free from the next request.</span>` +
      `<button type="button" class="btn sm danger" data-revoke-now="${esc(c.id)}">Revoke</button>` +
      `<button type="button" class="btn ghost sm" data-cancel>Cancel</button></div>`
    : `<button type="button" class="btn sm" data-revoke="${esc(c.id)}" aria-label="Revoke ${esc(c.clientName)}, credential ending ${esc(c.hint)}">Revoke</button>`;
  return `<li class="site-conn">
    <div class="site-conn-id">
      <div class="site-conn-top"><span class="site-app">${esc(c.clientName)}</span> <span class="site-desc">(its own description)</span></div>
      <div class="site-conn-meta">
        <span>approved by ${esc(c.approvedBy)} ${timeTag(c.createdAt)}</span>
        <span>credential ending <span class="mono">${esc(c.hint)}</span></span>
        ${seenLine(c, now, d.seenEveryMs)}
      </div>
    </div>
    <div class="site-conn-act">${action}</div>
  </li>`;
}

/** Two connections for one site means it connected again. The older one still works until revoked. */
function reconnectNote(site) {
  if (site.connections.length < 2) return "";
  return `<p class="site-note">${esc(plural(site.connections.length, "connection", "connections"))}: this site connected more than once, and every one still works. Revoke the ones it no longer uses; the newest is listed first.</p>`;
}

function siteCard(site, now, d) {
  return `<section class="site" aria-labelledby="site-${esc(site.connections[0].id)}">
    <h3 class="site-host mono" id="site-${esc(site.connections[0].id)}">${esc(site.host)}</h3>
    ${reconnectNote(site)}
    <ul class="site-conns">${site.connections.map((c) => connectionRow(site, c, now, d)).join("")}</ul>
  </section>`;
}

function emptySites() {
  return emptyState({
    icon: "sites",
    lead: "No site is connected yet.",
    body: [
      "A site connects from its own side: the naulon library running on it starts the connect, and sends you to this console to approve it. Once you approve, it shows up here.",
      `Sites set up before connect may use the key in <span class="mono">NAULON_ENFORCE_KEY</span> instead. Those keep working and do not appear on this page.`,
    ],
  });
}

function renderLegacy(d) {
  $("#legacy").innerHTML = !d.legacyKey
    ? ""
    : `<div class="banner pending"><b>This gate also accepts <span class="mono">NAULON_ENFORCE_KEY</span>.</b>
        <div class="toll-fix">Anything holding that key can toll any site this gate serves, and it is not listed below. Once each of your sites is connected here, remove it from the gate's environment and restart the gate.</div></div>`;
}

function render(d) {
  const now = Date.now();
  const host = $("#sites");
  host.removeAttribute("aria-busy");
  const n = d.sites.reduce((acc, s) => acc + s.connections.length, 0);
  $("#siteCount").textContent = d.sites.length ? `${plural(d.sites.length, "site", "sites")} · ${plural(n, "connection", "connections")}` : "";
  renderLegacy(d);
  if (confirming && !d.sites.some((s) => s.connections.some((c) => c.id === confirming))) confirming = null;
  host.innerHTML = d.sites.length ? d.sites.map((s) => siteCard(s, now, d)).join("") : emptySites();
}

let noticeIsError = false;
function notice(html, isError = false) {
  noticeIsError = isError;
  $("#notice").innerHTML = html;
}

async function tick() {
  try {
    const r = await fetch("/api/sites", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    state = await r.json();
    if (noticeIsError) notice("");
    // A repaint while a confirm is open would steal its focus. The poll waits for the owner instead.
    if (!confirming) render(state);
  } catch {
    $("#sites").removeAttribute("aria-busy");
    notice(`<div class="banner pending"><b>Could not read this gate's connections.</b><div class="toll-fix">The console is up; the request that failed was <span class="mono">/api/sites</span>. The gate's state store may be unreadable from here.</div></div>`, true);
  }
}

function openConfirm(id) {
  confirming = id;
  render(state);
  $(`[data-revoke-now="${CSS.escape(id)}"]`)?.focus();
}

function closeConfirm() {
  const id = confirming;
  confirming = null;
  render(state);
  if (id) $(`[data-revoke="${CSS.escape(id)}"]`)?.focus();
}

async function revoke(btn) {
  const id = btn.dataset.revokeNow;
  btn.disabled = true;
  btn.textContent = "Revoking…";
  const r = await fetch("/api/sites/revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  }).catch(() => null);
  const data = r ? await r.json().catch(() => ({})) : {};
  confirming = null;
  notice(
    r?.ok
      ? `<div class="banner synced"><b>Revoked. ${esc(data.clientName)} can no longer toll ${esc(new URL(data.site).host)}.</b><div class="toll-fix">Its readers read free from the next request. To toll it again, connect the site again from its own settings.</div></div>`
      : `<div class="banner pending"><b>Nothing was revoked.</b><div class="toll-fix">${esc(data.error ?? "The console could not reach its own server.")}</div></div>`,
  );
  $("#notice").focus();
  await refresh?.run();
}

document.addEventListener("click", (e) => {
  const open = e.target.closest("[data-revoke]");
  if (open) return openConfirm(open.dataset.revoke);
  if (e.target.closest("[data-cancel]")) return closeConfirm();
  const now = e.target.closest("[data-revoke-now]");
  if (now) void revoke(now);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && confirming) {
    e.preventDefault();
    closeConfirm();
  }
});

refresh = poll(tick, 10_000);
