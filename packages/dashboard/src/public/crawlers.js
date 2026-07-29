/*
 * Crawlers — pick a state per crawler, then save. Reads and writes /api/crawlers; the
 * server owns validation (shared's normalizeCrawlerPolicy), and this page never
 * second-guesses it: a refusal is rendered verbatim because that sentence already
 * explains itself to an operator.
 *
 * Security: crawler fragments are operator-typed and round-trip from a file, so every
 * one goes through esc() before it touches innerHTML.
 */
import { $, $$, esc, renderShell, setGate, wireSeg } from "./shell.js";

renderShell({ active: "crawlers" });

const STATES = ["default", "allow", "charge", "block"];
const STATE_LABEL = { default: "default", allow: "free", charge: "charge", block: "block" };

/** What the gate does today when a crawler is left on `default`. */
const DEFAULT_NOTE = { free: "reads free", charged: "pays the toll" };

const CATEGORY_LABEL = {
  "ai-training": "AI training",
  "ai-assistant": "AI assistants",
  search: "Search",
  archiver: "Archivers",
  seo: "SEO tools",
};

/** Categories in the order an operator cares about them, money first. */
const CATEGORY_ORDER = ["ai-training", "ai-assistant", "search", "archiver", "seo"];

let view = null;      // the last server view
let picks = new Map(); // fragment → state, the operator's unsaved intent
let custom = [];      // [{fragment, state}]
let newState = "allow";

const dirty = () => {
  if (!view) return false;
  if (custom.length !== view.custom.length) return true;
  const before = new Map(view.custom.map((c) => [c.fragment, c.state]));
  if (custom.some((c) => before.get(c.fragment) !== c.state)) return true;
  return view.crawlers.some((c) => (picks.get(c.fragment) ?? c.state) !== c.state);
};

function paintDirty() {
  $("#saveBtn").disabled = !dirty();
}

function counts() {
  let allow = 0, charge = 0, block = 0, def = 0;
  for (const c of view.crawlers) {
    const s = picks.get(c.fragment) ?? c.state;
    if (s === "allow") allow++;
    else if (s === "charge") charge++;
    else if (s === "block") block++;
    else def++;
  }
  for (const c of custom) {
    if (c.state === "allow") allow++;
    else if (c.state === "charge") charge++;
    else block++;
  }
  $("#nAllow").textContent = allow;
  $("#nCharge").textContent = charge;
  $("#nBlock").textContent = block;
  $("#nDefault").textContent = def;
}

function renderCrawlers() {
  const byCat = new Map();
  for (const c of view.crawlers) {
    if (!byCat.has(c.category)) byCat.set(c.category, []);
    byCat.get(c.category).push(c);
  }
  $("#crawlers").innerHTML = CATEGORY_ORDER.filter((k) => byCat.has(k))
    .map((cat) => {
      const rows = byCat.get(cat).map((c) => {
        const state = picks.get(c.fragment) ?? c.state;
        const seg = STATES.map(
          (s) =>
            `<button type="button" class="seg-btn${s === state ? " on" : ""}" data-frag="${esc(c.fragment)}" data-pick="${esc(s)}">${esc(STATE_LABEL[s])}</button>`,
        ).join("");
        // The search caution is the one place this page argues with the operator: tolling
        // a search indexer deindexes the site, which is a bigger loss than the toll.
        const caution =
          cat === "search" && (state === "charge" || state === "block")
            ? `<div class="crawl-caution">Tolling or refusing a search indexer takes this site out of that index. That is usually a worse trade than the toll.</div>`
            : "";
        return `<div class="crawl">
          <div class="crawl-id">
            <div class="crawl-name">${esc(c.name)}</div>
            <div class="crawl-meta">
              <span class="mono">${esc(c.fragment)}</span> · ${esc(c.operator)}
              ${c.directoryHost ? `<span class="badge verified" title="This operator publishes a Web Bot Auth key directory">signs · ${esc(c.directoryHost)}</span>` : ""}
            </div>
          </div>
          <div class="crawl-default">default: ${esc(DEFAULT_NOTE[c.defaultState])}</div>
          <div class="seg crawl-seg">${seg}</div>
          ${caution}
        </div>`;
      }).join("");
      return `<div class="crawl-cat">${esc(CATEGORY_LABEL[cat] ?? cat)}</div>${rows}`;
    })
    .join("");
}

function renderCustom() {
  $("#custom").innerHTML = custom.length
    ? custom.map((c, i) => `
      <div class="kv">
        <span class="k mono">${esc(c.fragment)}</span>
        <span class="v"><span class="badge ${esc(c.state)}">${esc(STATE_LABEL[c.state])}</span></span>
        <button class="x" data-drop="${i}" aria-label="Remove ${esc(c.fragment)}">✕</button>
      </div>`).join("")
    : `<div class="panel-empty">No rules of your own. The list above covers the crawlers we know by name.</div>`;
}

function renderNotice() {
  const bits = [];
  if (view.problem) {
    // The gate is serving OPEN while this is true — say so, or the operator reads a
    // validation complaint and assumes their block is in force.
    bits.push(`<div class="banner pending"><b>The policy on disk is not being applied.</b>
      <div class="toll-fix">${esc(view.problem)}</div>
      <div class="toll-fix">Until it is fixed the gate falls back to its classifier defaults — nothing is blocked. Saving from this page writes a policy that has already passed validation.</div></div>`);
  }
  if (view.restartPending) {
    bits.push(`<div class="banner pending"><b>Saved, but not yet enforced.</b>
      <div class="toll-fix">The gate reads this policy when it starts. Restart it to apply your changes — until then the old policy is what crawlers meet.</div></div>`);
  }
  $("#notice").innerHTML = bits.join("");
}

function paint() {
  // The filename, not the path. The full path measured 794px of a 1100px section head,
  // uppercased by `.section-head .n` into an unreadable band — and it is an operator's
  // home directory, which is not something to render at that size. It stays available
  // on hover, which is the only time anyone wants it.
  const el = $("#policyPath");
  el.textContent = view.absent ? "no policy file yet" : (view.path.split("/").pop() ?? view.path);
  el.title = view.path;
  renderNotice();
  renderCrawlers();
  renderCustom();
  counts();
  paintDirty();
}

async function load() {
  try {
    const r = await fetch("/api/crawlers", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    view = await r.json();
    picks = new Map();
    custom = view.custom.map((c) => ({ ...c }));
    setGate(!!view.gate?.up, view.gate?.up ? "gate up" : "gate down");
    paint();
  } catch {
    setGate(false, "dashboard offline");
    $("#notice").innerHTML = `<div class="banner pending">Could not read the crawler policy. The request that failed was <span class="mono">/api/crawlers</span>.</div>`;
  }
}

function collect() {
  const out = { allow: [], charge: [], block: [] };
  for (const c of view.crawlers) {
    const s = picks.get(c.fragment) ?? c.state;
    if (s !== "default") out[s].push(c.fragment);
  }
  for (const c of custom) out[c.state].push(c.fragment);
  return out;
}

async function save() {
  const btn = $("#saveBtn");
  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = "saving…";
  try {
    const r = await fetch("/api/crawlers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(collect()),
    });
    const p = await r.json();
    if (!p.written) {
      // Rendered verbatim: the validator's sentence names the fragment and the reason
      // (usually "that would gate human readers"), which is exactly what to show.
      $("#notice").innerHTML = `<div class="banner pending"><b>Not saved.</b><div class="toll-fix">${esc(p.error || "The policy was refused.")}</div></div>`;
      btn.disabled = false;
      return;
    }
    await load();
    $("#notice").insertAdjacentHTML(
      "afterbegin",
      `<div class="banner synced"><b>Policy saved.</b><div class="toll-fix">Restart the gate to apply it.</div></div>`,
    );
  } catch (e) {
    $("#notice").innerHTML = `<div class="banner pending"><b>${esc(e.message)}</b></div>`;
    btn.disabled = false;
  } finally {
    btn.textContent = was;
  }
}

$("#crawlers").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-pick]");
  if (!btn) return;
  picks.set(btn.dataset.frag, btn.dataset.pick);
  for (const b of $$(`[data-frag="${CSS.escape(btn.dataset.frag)}"]`)) b.classList.toggle("on", b === btn);
  renderCrawlers();
  counts();
  paintDirty();
});

$("#custom").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-drop]");
  if (!btn) return;
  custom.splice(Number(btn.dataset.drop), 1);
  renderCustom();
  counts();
  paintDirty();
});

wireSeg($("#customState"), "state", (s) => {
  newState = s;
});

function addCustom() {
  const input = $("#customFrag");
  const frag = input.value.trim().toLowerCase();
  const out = $("#customOut");
  if (!frag) return;
  // Only the obvious client-side checks. The real validation — including the
  // humans-read-free guard — is the server's, and it runs on save regardless.
  if (custom.some((c) => c.fragment === frag) || view.crawlers.some((c) => c.fragment === frag)) {
    out.textContent = `"${frag}" is already covered above.`;
    return;
  }
  custom.push({ fragment: frag, state: newState });
  input.value = "";
  out.textContent = "";
  renderCustom();
  counts();
  paintDirty();
}

$("#addBtn").addEventListener("click", addCustom);
$("#customFrag").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addCustom();
  }
});
$("#saveBtn").addEventListener("click", save);

load();
