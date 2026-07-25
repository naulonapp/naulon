import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWebhookEndpointsEnv } from "./webhookEndpointsEnv.ts";

test("blank or undefined env parses to no endpoints (dark)", () => {
  assert.deepEqual(parseWebhookEndpointsEnv(undefined), []);
  assert.deepEqual(parseWebhookEndpointsEnv(""), []);
  assert.deepEqual(parseWebhookEndpointsEnv("   "), []);
});

test("a full entry parses with defaults (events→both, hostFilter→null)", () => {
  const specs = parseWebhookEndpointsEnv(
    JSON.stringify([{ url: "https://acme.test/hook", secret: "whsec_x" }]),
  );
  assert.equal(specs.length, 1);
  assert.equal(specs[0]!.url, "https://acme.test/hook");
  assert.equal(specs[0]!.secret, "whsec_x");
  assert.deepEqual([...specs[0]!.events].sort(), ["anomaly.detected", "settlement.completed"]);
  assert.equal(specs[0]!.hostFilter, null);
});

test("explicit events + hostFilter are honored", () => {
  const specs = parseWebhookEndpointsEnv(
    JSON.stringify([
      { url: "https://a.test/h", secret: "s", events: ["settlement.completed"], hostFilter: "a.test" },
    ]),
  );
  assert.deepEqual(specs[0]!.events, ["settlement.completed"]);
  assert.equal(specs[0]!.hostFilter, "a.test");
});

test("malformed JSON throws (fail loud at boot)", () => {
  assert.throws(() => parseWebhookEndpointsEnv("{not json"), /NAULON_WEBHOOK_ENDPOINTS/);
});

test("an entry missing url or secret throws", () => {
  assert.throws(() => parseWebhookEndpointsEnv(JSON.stringify([{ url: "https://a.test/h" }])), /secret/);
  assert.throws(() => parseWebhookEndpointsEnv(JSON.stringify([{ secret: "s" }])), /url/);
});

test("an unknown event type throws", () => {
  assert.throws(
    () => parseWebhookEndpointsEnv(JSON.stringify([{ url: "https://a.test/h", secret: "s", events: ["nope"] }])),
    /event/i,
  );
});
