/**
 * Parity guard across the publisher boundary: what the SENDER puts on the wire
 * (`CanonicalEvent`, signed by `signPayload`) must be exactly what a publisher's
 * receiver in `@naulon/sdk` accepts (`webhookEnvelopeSchema`, verified by
 * `verifyPayload`). The two live in different packages on purpose — the SDK is what
 * a site installs, and the dependency only ever points shared → sdk — so nothing but
 * a test holds the shapes together.
 *
 * The event-type check is deliberately one-directional: a NEW type the gate emits
 * must be added to the SDK's `KNOWN_WEBHOOK_EVENT_TYPES` (and the customer doc), but
 * a deployed receiver is never broken by one, because the envelope's `type` is an
 * open string. Red here means "document the new event", not "the wire is broken".
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KNOWN_WEBHOOK_EVENT_TYPES,
  webhookEnvelopeSchema,
  signPayload,
  verifyPayload,
} from "@naulon/sdk";
import { WEBHOOK_EVENT_TYPES } from "./types.ts";
import type { CanonicalEvent } from "./transform.ts";

const SECRET = "whsec_parity";

test("every event type the gate emits is named in the SDK's known list", () => {
  for (const t of [...WEBHOOK_EVENT_TYPES, "ping"]) {
    assert.ok(
      (KNOWN_WEBHOOK_EVENT_TYPES as readonly string[]).includes(t),
      `@naulon/sdk KNOWN_WEBHOOK_EVENT_TYPES is missing "${t}" — add it and document the event`,
    );
  }
});

test("a CanonicalEvent from the sender parses as the SDK's receive envelope", () => {
  const canonical: CanonicalEvent = {
    id: "dlv_1",
    type: "settlement.completed",
    eventId: "evt_1",
    createdAt: 1_700_000_000_000,
    data: { tenant: "acme", announced: 3 },
  };
  const parsed = webhookEnvelopeSchema.safeParse(canonical);
  assert.equal(parsed.success, true, "the SDK receiver would 400 the sender's own body");
});

test("an added field does not turn a valid delivery into a 400", () => {
  // Additive-optional is how this contract evolves — the receiver must tolerate it.
  const withExtra = {
    id: "dlv_2",
    type: "settlement.completed",
    eventId: "evt_2",
    createdAt: 1_700_000_000_000,
    data: {},
    futureField: "added later",
  };
  assert.equal(webhookEnvelopeSchema.safeParse(withExtra).success, true);
});

test("the header the sender writes is the header the receiver verifies", () => {
  const body = JSON.stringify({ id: "dlv_3", type: "ping", eventId: "evt_3", createdAt: 0, data: {} });
  const t = 1_700_000_000;
  assert.equal(verifyPayload(SECRET, body, signPayload(SECRET, body, t), t), true);
});
