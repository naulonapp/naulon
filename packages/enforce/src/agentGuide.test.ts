import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentGuide, headerError, guideLinks, networkLabel,
  FOR_YOUR_USER_MAX, HEADER_ERROR_MAX, CIRCLE_GATEWAY_DOCS,
} from "./agentGuide.ts";
import type { SettlementLegReq } from "./build402.ts";

const GW = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE";
const USDC = "0x3600000000000000000000000000000000000000";
const req = (amount: string, payTo: string, gateway = true): SettlementLegReq["requirements"] => ({
  scheme: "exact", network: "eip155:5042", asset: USDC, amount, payTo, maxTimeoutSeconds: 691200,
  extra: gateway ? { name: "GatewayWalletBatched", version: "1", verifyingContract: GW } : { nonce: "n1" },
});

const author: SettlementLegReq = { role: "author", requirements: req("1000", "0xaaaa") };
const operator: SettlementLegReq = { role: "operator", requirements: req("100", "0xbbbb") };
const links = { guide: "https://guide.example/pay", manifest: "/.well-known/x402" };
const url = "https://blog.example/what-pricing-taught-me/";
const input = { resource: { url, title: "What pricing taught me" }, tollKind: "read" as const, legs: [author, operator], links };

test("the guide names the network in words and the price as the whole ask", () => {
  const g = agentGuide(input);
  assert.equal(g.howToPay.network.caip, "eip155:5042");
  assert.equal(g.howToPay.network.name, "Arc");
  assert.equal(g.howToPay.network.testnet, false);
  assert.equal(g.howToPay.price, "USD 0.0011");
  assert.deepEqual(g.howToPay.asset, { symbol: "USDC", address: USDC, decimals: 6 });
});

test("the leg split says what a stock client signs and what it leaves out", () => {
  assert.deepEqual(agentGuide(input).howToPay.legs, [
    { role: "author", atomic: "1000", inAccepts: true },
    { role: "operator", atomic: "100", inAccepts: false, extension: "naulonLegs" },
  ]);
});

test("a leg amount that is not integer digits is refused, never passed through", () => {
  const bad: SettlementLegReq = { role: "author", requirements: req("0x10", "0xa") };
  assert.throws(() => agentGuide({ ...input, legs: [bad] }), /integer digits/);
});

test("a gateway rail leads with the deposit, names the contract and links Circle's guide", () => {
  const steps = agentGuide(input).howToPay.steps;
  assert.deepEqual(steps.map((s) => s.id), ["fund", "sign", "retry"]);
  assert.equal(steps[0]!.contract, GW);
  assert.equal(steps[0]!.docs, CIRCLE_GATEWAY_DOCS);
  assert.match(steps[1]!.do, /array with one signed payload per naulonLegs entry/);
  assert.match(steps[2]!.do, /PAYMENT-SIGNATURE/);
});

test("a non-gateway rail has no deposit step and a single leg says nothing about arrays", () => {
  const g = agentGuide({ ...input, legs: [{ role: "author", requirements: req("1000", "0xaaaa", false) }] });
  assert.deepEqual(g.howToPay.steps.map((s) => s.id), ["sign", "retry"]);
  assert.doesNotMatch(g.howToPay.steps[0]!.do, /naulonLegs|Gateway/);
});

test("the relay text leads with the free URL and the price and fits its cap", () => {
  const t = agentGuide(input).forYourUser.text;
  assert.ok(t.indexOf(url) < t.indexOf("USD 0.0011"), "free URL first, then the price");
  assert.ok(t.includes(links.guide));
  assert.ok(t.length <= FOR_YOUR_USER_MAX);
  assert.doesNotMatch(t, /\n/);
});

test("a citation toll says citation in the relay text", () => {
  assert.match(agentGuide({ ...input, tollKind: "citation" }).forYourUser.text, /per citation/);
});

test("a messy title is collapsed, clipped and never breaks a cap", () => {
  const title = `  <script>alert(1)</script>\n"quoted"\t${"x".repeat(500)}`;
  const g = agentGuide({ ...input, resource: { url, title } });
  assert.doesNotMatch(g.forYourUser.title, /\s{2,}|\n|\t/);
  assert.ok(g.forYourUser.title.length <= 120);
  assert.ok(g.forYourUser.text.length <= FOR_YOUR_USER_MAX);
});

test("an empty title still produces a sentence a person can read", () => {
  const t = agentGuide({ ...input, resource: { url, title: "   " } }).forYourUser.text;
  assert.ok(t.startsWith("This page is free to read"));
});

test("a very long URL drops clauses before it breaks a cap", () => {
  const long = `https://ingress.example/${"a".repeat(380)}`;
  const g = agentGuide({ ...input, resource: { url: long, title: "T" } });
  assert.ok(g.forYourUser.text.length <= FOR_YOUR_USER_MAX);
  assert.ok(headerError(input.legs, long, links.guide).length <= HEADER_ERROR_MAX);
});

test("the x402 error names price, network, deposit, free URL and guide", () => {
  const e = headerError(input.legs, url, links.guide);
  assert.ok(e.startsWith("Payment required: USD 0.0011 in USDC on Arc (eip155:5042)"));
  assert.ok(e.includes(GW));
  assert.ok(e.includes(url));
  assert.ok(e.includes(links.guide));
  assert.ok(e.length <= HEADER_ERROR_MAX);
});

test("a non-gateway error says nothing about Circle", () => {
  const e = headerError([{ role: "author", requirements: req("1000", "0xa", false) }], url, links.guide);
  assert.doesNotMatch(e, /Circle|Gateway/);
});

test("an unknown network falls back to its CAIP id; a testnet says so", () => {
  assert.deepEqual(networkLabel("eip155:999999"), { name: "eip155:999999", testnet: false });
  assert.deepEqual(networkLabel("eip155:5042002"), { name: "Arc testnet", testnet: true });
});

test("guide links include fund and MCP only when configured", () => {
  assert.deepEqual(guideLinks("/m", { BUYER_GUIDE_URL: "https://g" }), { guide: "https://g", manifest: "/m" });
  assert.deepEqual(
    guideLinks("/m", { BUYER_GUIDE_URL: "https://g", BUYER_FUND_URL: "https://f", BUYER_MCP_URL: "https://mcp" }),
    { guide: "https://g", manifest: "/m", fund: "https://f", mcp: "https://mcp" },
  );
});

test("no legs is a bug, not an empty guide", () => {
  assert.throws(() => agentGuide({ ...input, legs: [] }), /at least one leg/);
  assert.throws(() => headerError([], url, links.guide), /at least one leg/);
});
