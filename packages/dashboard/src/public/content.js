/*
 * Content manager — map articles → payout wallets in the browser, no JSON by
 * hand. Scan (server-side crawl) discovers articles; you fill wallets; save
 * writes credits.json (validated, .bak'd, server-side). Same esc() XSS boundary.
 *
 * Splits (an article with >1 payee, or nested members) are shown READ-ONLY and
 * preserved verbatim on save — the single-author editor never flattens them.
 */
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
const titleFromSlug = (s) => s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

let rows = []; // { slug, author, wallet, locked, raw, isNew }

function entryToRow(slug, entry) {
  const cs = (entry && entry.contributors) || [];
  const single = cs.length === 1 && !cs[0].members;
  if (single) return { slug, author: cs[0].authorId || "", wallet: cs[0].wallet || "", locked: false };
  return { slug, author: `${cs.length} payees`, wallet: "", locked: true, raw: entry };
}

async function load() {
  const d = await fetch("/api/content").then((r) => r.json());
  if (d.apiMode) {
    $("#rows").innerHTML = `<div class="empty"><div class="big">Credits come from a live API.</div><p>Your articles + wallets are served by <code>${esc(d.origin)}/api/credits</code> — edit them at your CMS. This file manager applies only to the static <code>credits.json</code> path.</p></div>`;
    $("#scanBtn").disabled = true; $("#saveBtn").disabled = true; $("#addBtn").disabled = true;
    return;
  }
  rows = Object.entries(d.credits || {}).map(([slug, e]) => entryToRow(slug, e));
  render();
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
  if (r.locked) {
    return `<div class="crow rise" data-i="${i}">
      <span class="slug">${esc(r.slug)}</span>
      <span class="split-badge">${esc(r.author)} · split</span>
      <span class="dim mono">edit via credits.json</span><span></span></div>`;
  }
  return `<div class="crow rise" data-i="${i}">
    ${r.isNew ? `<input class="in slug-in" data-i="${i}" data-k="slug" value="${esc(r.slug)}" placeholder="article-slug" spellcheck="false" />`
              : `<span class="slug">${esc(r.slug)}</span>`}
    <input class="in" data-i="${i}" data-k="author" value="${esc(r.author)}" placeholder="author" spellcheck="false" />
    <input class="in wallet ${bad ? "bad" : ""}" data-i="${i}" data-k="wallet" value="${esc(r.wallet)}" placeholder="0x… 40 hex" spellcheck="false" autocomplete="off" />
    <button class="x" data-del="${i}" title="remove">✕</button></div>`;
}

function bind() {
  $("#rows").querySelectorAll("input[data-k]").forEach((el) => {
    el.addEventListener("input", () => {
      const r = rows[+el.dataset.i]; if (!r) return;
      r[el.dataset.k] = el.value.trim();
      if (el.dataset.k === "wallet") el.classList.toggle("bad", !!r.wallet && !WALLET_RE.test(r.wallet));
    });
  });
  $("#rows").querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => { rows.splice(+b.dataset.del, 1); render(); }));
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
    for (const [slug, e] of Object.entries(d.credits || {})) if (!have.has(slug)) { rows.push(entryToRow(slug, e)); have.add(slug); }
    for (const u of d.unmapped || []) if (!have.has(u.slug)) { rows.push({ slug: u.slug, author: u.author || "", wallet: "", locked: false }); have.add(u.slug); }
    render();
    $("#scanOut").innerHTML = `via <b>${esc(d.adapterId || "none")}</b> · ${d.discovered} found · <span class="ok">${d.added.length} new</span> · ${d.unmapped.length} need a wallet · ${d.keptExisting.length} already mapped`;
  } catch (e) {
    $("#scanOut").innerHTML = `<span class="err">${esc(e.message)}</span>`;
  } finally {
    btn.disabled = false; btn.textContent = "Scan site";
  }
}

async function save() {
  const btn = $("#saveBtn"); btn.disabled = true; btn.textContent = "saving…";
  try {
    const r = await fetch("/api/content", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ credits: toCreditsMap() }),
    });
    const d = await r.json();
    if (d.written) {
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
$("#saveBtn").addEventListener("click", save);
$("#addBtn").addEventListener("click", () => { rows.push({ slug: "", author: "", wallet: "", locked: false, isNew: true }); render(); });
load();
