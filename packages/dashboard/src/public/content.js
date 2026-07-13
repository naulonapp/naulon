/*
 * Content manager — map articles → payout wallets in the browser, no JSON by
 * hand. Scan (server-side crawl) discovers articles; you fill wallets; save
 * writes credits.json (validated, .bak'd, server-side). Same esc() XSS boundary.
 *
 * Splits (an article with >1 payee, or nested members) are shown READ-ONLY and
 * preserved verbatim on save — the single-author editor never flattens them.
 *
 * Money-write safety: Save is a two-step confirm (it rewrites the whole file, so a
 * removed row silently un-tolls); a beforeunload guard stops you losing edits by
 * navigating away; the banner tells you whether the gate is serving your current
 * file or needs a restart to pick up your edits.
 */
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
const titleFromSlug = (s) => s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

let rows = []; // { slug, author, wallet, locked, raw, isNew }
let savedSlugs = new Set(); // slugs as of the last load/save — to count removals on confirm
let dirty = false; // unsaved edits present → beforeunload guard + fresh save confirm

function markDirty() {
  dirty = true;
  cancelConfirm(); // any edit invalidates a pending save confirmation
}
function markClean(slugs) {
  dirty = false;
  savedSlugs = new Set(slugs);
}

function entryToRow(slug, entry) {
  const cs = (entry && entry.contributors) || [];
  const single = cs.length === 1 && !cs[0].members;
  if (single) return { slug, author: cs[0].authorId || "", wallet: cs[0].wallet || "", locked: false };
  return { slug, author: `${cs.length} payees`, wallet: "", locked: true, raw: entry };
}

async function load() {
  const d = await fetch("/api/content").then((r) => r.json());
  if (d.apiMode) {
    setBanner("api");
    $("#rows").innerHTML = `<div class="empty"><div class="big">Credits come from a live API.</div><p>Your articles + wallets are served by <code>${esc(d.origin)}/api/credits</code> — edit them at your CMS. This file manager applies only to the static <code>credits.json</code> path.</p></div>`;
    $("#scanBtn").disabled = true; $("#saveBtn").disabled = true; $("#addBtn").disabled = true;
    return;
  }
  rows = Object.entries(d.credits || {}).map(([slug, e]) => entryToRow(slug, e));
  markClean(rows.map((r) => r.slug));
  setBanner(d.restartPending ? "pending" : d.gate && d.gate.up ? "synced" : "unknown");
  render();
}

// The banner reflects the gate's relationship to credits.json on disk.
function setBanner(state) {
  const el = $("#banner");
  el.classList.remove("pending", "synced");
  if (state === "pending") {
    el.classList.add("pending");
    el.innerHTML = `<b>Edits pending a restart.</b> <span class="mono">credits.json</span> changed after the gate started — your edits are saved but <b>not live</b> until you restart the gate. <span class="dim">naulon cloud applies wallet edits instantly, no restart.</span>`;
  } else if (state === "synced") {
    el.classList.add("synced");
    el.innerHTML = `<b>In sync.</b> The gate is serving the current <span class="mono">credits.json</span>. Edits here apply on the next gate restart.`;
  } else if (state === "api") {
    el.innerHTML = `Credits are served from a live API — edit them at your CMS, not here.`;
  } else {
    el.innerHTML = `Edits write <span class="mono">credits.json</span> and apply when you <b>restart the gate</b>.`;
  }
}

function render() {
  $("#count").textContent = `${rows.length} article${rows.length === 1 ? "" : "s"}`;
  $("#rows").innerHTML = rows.length
    ? rows.map((r, i) => rowHtml(r, i)).join("")
    : `<div class="empty"><div class="big">No articles yet.</div><p>Hit <b>Scan site</b> to pull them from your sitemap/RSS, or <b>+ Add article</b>.</p></div>`;
  bind();
}

function rowHtml(r, i) {
  const bad = r.wallet && !WALLET_RE.test(r.wallet);
  const forSlug = r.slug ? ` for ${esc(r.slug)}` : "";
  if (r.locked) {
    return `<div class="crow rise" data-i="${i}">
      <span class="slug">${esc(r.slug)}</span>
      <span class="split-badge">${esc(r.author)} · split</span>
      <span class="dim mono">edit via credits.json</span><span></span></div>`;
  }
  return `<div class="crow rise" data-i="${i}">
    ${r.isNew ? `<input class="in slug-in" data-i="${i}" data-k="slug" value="${esc(r.slug)}" placeholder="article-slug" aria-label="article slug" spellcheck="false" />`
              : `<span class="slug">${esc(r.slug)}</span>`}
    <input class="in" data-i="${i}" data-k="author" value="${esc(r.author)}" placeholder="author" aria-label="author${forSlug}" spellcheck="false" />
    <input class="in wallet ${bad ? "bad" : ""}" data-i="${i}" data-k="wallet" value="${esc(r.wallet)}" placeholder="0x… 40 hex" aria-label="payout wallet${forSlug}" aria-invalid="${bad ? "true" : "false"}" spellcheck="false" autocomplete="off" />
    <button class="x" data-del="${i}" aria-label="remove ${esc(r.slug || "article")}" title="remove">✕</button></div>`;
}

function bind() {
  $("#rows").querySelectorAll("input[data-k]").forEach((el) => {
    el.addEventListener("input", () => {
      const r = rows[+el.dataset.i]; if (!r) return;
      r[el.dataset.k] = el.value.trim();
      markDirty();
      if (el.dataset.k === "wallet") {
        const isBad = !!r.wallet && !WALLET_RE.test(r.wallet);
        el.classList.toggle("bad", isBad);
        el.setAttribute("aria-invalid", isBad ? "true" : "false");
      }
    });
  });
  $("#rows").querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => { rows.splice(+b.dataset.del, 1); markDirty(); render(); }));
  // stagger index via the DOM API (no inline style → strict CSP holds)
  $("#rows").querySelectorAll(".crow").forEach((el) => el.style.setProperty("--i", el.dataset.i));
}

function toCreditsMap() {
  const map = {};
  for (const r of rows) {
    if (r.locked) { map[r.slug] = r.raw; continue; }
    if (!r.slug) continue;
    map[r.slug] = { slug: r.slug, title: titleFromSlug(r.slug), contributors: [{ authorId: r.author || "author", wallet: r.wallet }] };
  }
  return map;
}

async function scan() {
  const btn = $("#scanBtn"); btn.disabled = true; btn.textContent = "scanning…";
  $("#scanOut").textContent = "";
  try {
    const r = await fetch("/api/content/scan", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultWallet: $("#defaultWallet").value.trim() || undefined }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "scan failed");
    // merge: newly-mapped articles into rows; unmapped as empty-wallet rows.
    const have = new Set(rows.map((x) => x.slug));
    let appended = 0;
    for (const [slug, e] of Object.entries(d.credits || {})) if (!have.has(slug)) { rows.push(entryToRow(slug, e)); have.add(slug); appended++; }
    for (const u of d.unmapped || []) if (!have.has(u.slug)) { rows.push({ slug: u.slug, author: u.author || "", wallet: "", locked: false }); have.add(u.slug); appended++; }
    if (appended) markDirty();
    render();
    $("#scanOut").innerHTML = `via <b>${esc(d.adapterId || "none")}</b> · ${d.discovered} found · <span class="ok">${d.added.length} new</span> · ${d.unmapped.length} need a wallet · ${d.keptExisting.length} already mapped`;
  } catch (e) {
    $("#scanOut").innerHTML = `<span class="err">${esc(e.message)}</span>`;
  } finally {
    btn.disabled = false; btn.textContent = "Scan site";
  }
}

// Two-step save. The write rewrites credits.json wholesale, so a row you removed
// stops being tolled — surface the article count and any removals before writing.
let confirming = false;
function cancelConfirm() {
  if (!confirming) return;
  confirming = false;
  $("#saveOut").innerHTML = "";
  $("#saveOut").className = "save-out";
}
function requestSave() {
  if (confirming) return;
  const map = toCreditsMap();
  const nextSlugs = new Set(Object.keys(map));
  const removed = [...savedSlugs].filter((s) => !nextSlugs.has(s));
  confirming = true;
  const removedNote = removed.length
    ? ` <span class="warn-txt">${removed.length} article(s) removed — they stop being tolled: ${esc(removed.slice(0, 5).join(", "))}${removed.length > 5 ? "…" : ""}.</span>`
    : "";
  $("#saveOut").className = "save-out";
  $("#saveOut").innerHTML =
    `<div class="confirm">Rewrites <span class="mono">credits.json</span> with <b>${nextSlugs.size}</b> article(s).${removedNote}` +
    ` <button class="btn primary sm" id="confirmSave">Rewrite credits.json</button>` +
    ` <button class="btn ghost sm" id="cancelSave">Cancel</button></div>`;
  $("#confirmSave").addEventListener("click", doSave);
  $("#cancelSave").addEventListener("click", cancelConfirm);
}

async function doSave() {
  confirming = false;
  const btn = $("#saveBtn"); btn.disabled = true; btn.textContent = "saving…";
  try {
    const r = await fetch("/api/content", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ credits: toCreditsMap() }),
    });
    const d = await r.json();
    if (d.written) {
      markClean(Object.keys(toCreditsMap()));
      setBanner("pending"); // the file now post-dates the gate's boot → restart to apply
      $("#saveOut").innerHTML = `<span class="ok">✓ saved ${esc(d.path)}</span> · backup at <span class="mono">${esc(d.backup)}</span> · <b>restart the gate to apply.</b>${d.unmapped.length ? ` <span class="warn-txt">${d.unmapped.length} article(s) still without a wallet.</span>` : ""}`;
      $("#saveOut").className = "save-out flash";
    } else {
      $("#saveOut").innerHTML = `<span class="err">not saved — fix these:</span>` + (d.errors || []).map((e) => `<div class="err-row">${esc(e.slug)}: ${esc(e.message)}</div>`).join("");
      $("#saveOut").className = "save-out";
    }
  } catch (e) {
    $("#saveOut").innerHTML = `<span class="err">${esc(e.message)}</span>`;
  } finally {
    btn.disabled = false; btn.textContent = "Save credits.json";
  }
}

$("#scanBtn").addEventListener("click", scan);
$("#saveBtn").addEventListener("click", requestSave);
$("#addBtn").addEventListener("click", () => { rows.push({ slug: "", author: "", wallet: "", locked: false, isNew: true }); markDirty(); render(); });

// Unsaved-changes guard — don't lose wallet edits by navigating away (the nav
// links and a closed tab are both full-page unloads).
window.addEventListener("beforeunload", (e) => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = "";
});

load();
