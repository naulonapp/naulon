import { test } from "node:test";
import assert from "node:assert/strict";
import { negotiate402Format, render402 } from "./render402.ts";
import { paymentRequiredBody, PAYMENT_BODY_CONTENT_TYPE } from "./paymentBody.ts";
import { agentGuide } from "./agentGuide.ts";
import { paymentFailureDetail } from "./paymentRemedy.ts";
import type { SettlementLegReq } from "./build402.ts";

const leg: SettlementLegReq = {
  role: "author",
  requirements: {
    scheme: "exact", network: "eip155:5042", asset: "0x36", amount: "1100", payTo: "0xa", maxTimeoutSeconds: 1,
    extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x7777" },
  },
};
const guide = agentGuide({
  resource: { url: "https://e.example/x?a=1&b=2", title: `<script>alert("t")</script>` }, tollKind: "read",
  legs: [leg], links: { guide: "https://g.example", manifest: "/.well-known/x402", fund: "https://f.example", mcp: "https://m.example/mcp" },
});
const body = paymentRequiredBody({ askMicro: 1100n, publisher: "e.example", endpoint: "/x", tollKind: "read", guide });

test("absent, */* and JSON go to JSON", () => {
  for (const a of [undefined, null, "", "*/*", "application/json", "application/json, text/plain;q=0.5", "application/*"]) {
    assert.equal(negotiate402Format(a), "json", String(a));
  }
});

test("a browser Accept goes to HTML; markdown and plain text go to markdown", () => {
  assert.equal(negotiate402Format("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"), "html");
  assert.equal(negotiate402Format("text/markdown"), "markdown");
  assert.equal(negotiate402Format("text/plain, */*;q=0.1"), "markdown");
  assert.equal(negotiate402Format("TEXT/Markdown; charset=utf-8"), "markdown");
});

test("q-values decide, q=0 means never, and a malformed q is ignored", () => {
  assert.equal(negotiate402Format("text/html;q=0.1, application/json"), "json");
  assert.equal(negotiate402Format("text/markdown;q=0, */*"), "json");
  assert.equal(negotiate402Format("text/markdown;q=abc"), "json");
  assert.equal(negotiate402Format("text/markdown;q=0.9, text/html;q=0.9"), "markdown");
});

test("JSON is today's serialization byte for byte", () => {
  const r = render402("*/*", body);
  assert.equal(r.contentType, PAYMENT_BODY_CONTENT_TYPE);
  assert.equal(r.text, JSON.stringify(body, null, 2));
});

test("markdown leads with the relay text and carries every step and link", () => {
  const r = render402("text/markdown", body);
  assert.equal(r.contentType, "text/markdown; charset=utf-8");
  assert.ok(r.text.startsWith(`# Payment required\n\n${body.forYourUser!.text}`));
  for (const s of body.howToPay!.steps) assert.ok(r.text.includes(s.do));
  for (const u of ["https://g.example", "https://f.example", "https://m.example/mcp", "/.well-known/x402"]) assert.ok(r.text.includes(u), u);
});

test("HTML escapes every interpolated value and is never indexed", () => {
  const r = render402("text/html", body);
  assert.equal(r.contentType, "text/html; charset=utf-8");
  assert.ok(r.text.includes(`<meta name="robots" content="noindex">`));
  assert.ok(!r.text.includes("<script>"));
  assert.ok(r.text.includes("&lt;script&gt;"));
  assert.ok(r.text.includes(`href="https://e.example/x?a=1&amp;b=2"`), "an ampersand in a URL is escaped inside the attribute");
});

test("a refused payment shows its remedy first in prose", () => {
  const failure = paymentFailureDetail("insufficient_funds", "raw <b>", guide);
  const failed = paymentRequiredBody({ askMicro: 1100n, publisher: "e", endpoint: "/x", tollKind: "read", guide, failure });
  const md = render402("text/markdown", failed).text;
  assert.ok(md.indexOf(failure.remedy) < md.indexOf("## How to pay"));
  assert.ok(render402("text/html", failed).text.includes("raw &lt;b&gt;"));
});

test("a body without a guide always renders as JSON", () => {
  const plain = paymentRequiredBody({ askMicro: 1100n, publisher: "e", endpoint: "/x", tollKind: "read" });
  assert.equal(render402("text/html", plain).contentType, PAYMENT_BODY_CONTENT_TYPE);
  assert.equal(render402("text/markdown", plain).text, JSON.stringify(plain, null, 2));
});
