/**
 * The 402 body in the format the caller asked for. JSON stays the default and is byte-identical to
 * `paymentRequiredBodyText`. Markdown is for a fetcher that asks for prose (an LLM tool reading
 * `text/markdown` or `text/plain`), and HTML is for a browser-shaped `Accept`. All three render one
 * body, so they state the same facts.
 *
 * Negotiation runs only after the request was classified as an agent and refused; `Accept` here
 * chooses a rendering and never changes who pays. Every 402 rendered this way must carry
 * `Vary: Accept`, which the emitters set.
 */
import { networkPhrase } from "./agentGuide.ts";
import { PAYMENT_BODY_CONTENT_TYPE, type PaymentRequiredBody } from "./paymentBody.ts";

export type Body402Format = "json" | "markdown" | "html";

const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";
const HTML_CONTENT_TYPE = "text/html; charset=utf-8";

/**
 * Highest q wins. JSON wins every tie with HTML and takes `*` / absent, so a client that states no
 * preference gets exactly what it got before negotiation existed. Markdown beats HTML on a tie: a
 * client naming both is a reader, not a browser.
 */
export function negotiate402Format(accept: string | null | undefined): Body402Format {
  if (!accept) return "json";
  let json = 0;
  let md = 0;
  let html = 0;
  for (const part of accept.split(",")) {
    const [rawType = "", ...params] = part.trim().toLowerCase().split(";");
    const type = rawType.trim();
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const q = qParam ? Number(qParam.slice(2)) : 1;
    if (!Number.isFinite(q) || q <= 0) continue;
    if (type === "application/json" || type === "application/*" || type === "*/*") json = Math.max(json, q);
    else if (type === "text/markdown" || type === "text/plain") md = Math.max(md, q);
    else if (type === "text/html" || type === "application/xhtml+xml") html = Math.max(html, q);
  }
  if (md > json && md >= html) return "markdown";
  if (html > json) return "html";
  return "json";
}

type GuidedBody = PaymentRequiredBody & Required<Pick<PaymentRequiredBody, "forYourUser" | "howToPay" | "links">>;

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * Text from outside this gate (a publisher's title, a facilitator's error) made inert in markdown:
 * no link or image syntax, no raw HTML, no code span. URLs are left readable, since `[`, `]`, `<`,
 * `>` and backticks do not occur in the ones this body carries.
 */
const mdText = (s: string): string =>
  s.replace(/[[\]`]/g, (c) => `\\${c}`).replace(/</g, "&lt;").replace(/>/g, "&gt;");

function markdown(b: GuidedBody): string {
  const h = b.howToPay;
  const lines = ["# Payment required", "", mdText(b.forYourUser.text), ""];
  if (b.failure) lines.push("## Why the payment was refused", "", mdText(b.failure.remedy), "", `Detail: ${mdText(b.failure.detail)}`, "");
  lines.push("## For an AI assistant", "", mdText(b.message), "");
  lines.push("## How to pay", "", `Price: ${h.price} in USDC on ${networkPhrase(h.network)}, asset ${h.asset.address}.`, "");
  for (const l of h.legs) lines.push(`- ${l.role}: ${l.atomic} atomic USDC${l.inAccepts ? " (accepts[0])" : " (naulonLegs)"}`);
  lines.push("");
  h.steps.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.do}${s.contract ? ` Contract: ${s.contract}.` : ""}${s.docs ? ` Docs: ${s.docs}` : ""}`);
  });
  lines.push("", "## Links", "", `- Guide: ${b.links.guide}`, `- Terms: ${b.links.manifest}`);
  if (b.links.fund) lines.push(`- Set up an agent wallet: ${b.links.fund}`);
  if (b.links.mcp) lines.push(`- MCP server: ${b.links.mcp}`);
  return `${lines.join("\n")}\n`;
}

function html(b: GuidedBody): string {
  const h = b.howToPay;
  const link = (href: string, label: string) => `<a href="${esc(href)}">${esc(label)}</a>`;
  const steps = h.steps
    .map((s) => `<li>${esc(s.do)}${s.contract ? ` <code>${esc(s.contract)}</code>` : ""}${s.docs ? ` ${link(s.docs, "Docs")}` : ""}</li>`)
    .join("");
  const failure = b.failure
    ? `<h2>Why the payment was refused</h2><p>${esc(b.failure.remedy)}</p><p><small>${esc(b.failure.detail)}</small></p>`
    : "";
  const extra = [b.links.fund ? link(b.links.fund, "Set up an agent wallet") : "", b.links.mcp ? link(b.links.mcp, "MCP server") : ""]
    .filter(Boolean)
    .join(" · ");
  return [
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>Payment required</title></head>`,
    `<body><main><h1>Payment required</h1><p>${esc(b.forYourUser.text)}</p>`,
    `<p>${link(b.forYourUser.readFreeUrl, "Read it free in a browser")}</p>`,
    failure,
    `<h2>How an agent pays</h2><p>${esc(h.price)} in USDC on ${esc(networkPhrase(h.network))}.</p><ol>${steps}</ol>`,
    `<p>${link(b.links.guide, "Guide")} · ${link(b.links.manifest, "Terms")}${extra ? ` · ${extra}` : ""}</p>`,
    `</main></body></html>`,
  ].join("");
}

export function render402(accept: string | null | undefined, body: PaymentRequiredBody): { text: string; contentType: string } {
  const json = { text: JSON.stringify(body, null, 2), contentType: PAYMENT_BODY_CONTENT_TYPE };
  if (!body.forYourUser || !body.howToPay || !body.links) return json;
  const guided = body as GuidedBody;
  switch (negotiate402Format(accept)) {
    case "markdown":
      return { text: markdown(guided), contentType: MARKDOWN_CONTENT_TYPE };
    case "html":
      return { text: html(guided), contentType: HTML_CONTENT_TYPE };
    default:
      return json;
  }
}
