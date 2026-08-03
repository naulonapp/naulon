/**
 * Regression cover for the scheme the gate PUBLISHES vs the one its socket observed.
 *
 * Both assertions here failed before `externalScheme` existed, and neither was caught
 * by the existing suites: every test constructs its Request with the scheme it wants,
 * so the gap only opened in a real deployment, where TLS ends at the edge.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { requestFactsFrom } from "./decide.ts";

const HOST = "fleet.raxtzu.com";
const PATH = "/articles/what-a-toll-proves";

// Passed explicitly rather than leaning on ambient env: these assertions are about the
// function's logic, and a test that only passes when TRUST_PROXY happens to be set is a
// test that will silently stop covering anything.
const PROXIED = { trustProxy: true, hops: 1 };
const DIRECT = { trustProxy: false };

test("@target-uri is rebuilt with the scheme the AGENT used, not the socket's", () => {
  // What a TLS-terminating edge hands the gate: plain HTTP, with the real scheme in
  // the forwarded header. An agent signing `@target-uri` signed the https:// form.
  const req = new Request(`http://${HOST}${PATH}`, {
    headers: {
      "x-forwarded-proto": "https",
      "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)",
    },
  });
  const facts = requestFactsFrom(req, HOST, PROXIED);
  assert.equal(
    facts.targetUri,
    `https://${HOST}${PATH}`,
    "an http:// signature base differs from what the agent signed, so a valid " +
      "signature fails and the agent is silently downgraded to unverified",
  );
});

test("@authority stays the resolved host — it never carried the scheme", () => {
  // This is why the bug hid: agents covering @authority verified correctly throughout.
  const req = new Request(`http://${HOST}${PATH}`, { headers: { "x-forwarded-proto": "https" } });
  assert.equal(requestFactsFrom(req, HOST, PROXIED).authority, HOST);
});

test("with no proxy in front, the observed scheme is still what gets signed over", () => {
  const req = new Request(`http://${HOST}${PATH}`);
  assert.equal(requestFactsFrom(req, HOST, DIRECT).targetUri, `http://${HOST}${PATH}`);
});

test("the query string stays in @target-uri, the fragment was never on the wire", () => {
  const req = new Request(`http://${HOST}${PATH}?ref=x`, {
    headers: { "x-forwarded-proto": "https" },
  });
  assert.equal(requestFactsFrom(req, HOST, PROXIED).targetUri, `https://${HOST}${PATH}?ref=x`);
});
