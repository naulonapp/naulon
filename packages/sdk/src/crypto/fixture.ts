/**
 * Offline conformance helper. A publisher feeds the output into THEIR own receiver
 * in THEIR test harness and asserts a 200 + a written row — proving their
 * integration without ever needing a real settlement to happen. The CLI prints this
 * fixture (`naulon-kit check … --secret whsec_…`).
 *
 * The body is a real `settlement.completed` delivery envelope, signed the way the
 * sender signs it, so a receiver that accepts this accepts production traffic.
 */
import { signPayload } from "./webhook.ts";
import type { WebhookEnvelope } from "../contract/webhook.ts";

/** A representative delivery — the `detailed` settlement body, one author leg. */
const SAMPLE_ENVELOPE: WebhookEnvelope = {
  id: "11111111-2222-4333-8444-555555555555",
  type: "settlement.completed",
  eventId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
  createdAt: 1_700_000_000_000,
  data: {
    tenant: "your-site",
    host: "your-site.example",
    window: { toMs: 1_700_000_000_000, spanMs: 60_000 },
    citations: { settled: 1 },
    gross: { microUsdc: 5000, usdc: "0.005000" },
    legs: [
      {
        role: "author",
        payTo: "0x1111111111111111111111111111111111111111",
        microUsdc: 5000,
        settled: true,
        settlementRef: "0xfeed",
      },
    ],
    settlementRefs: ["0xfeed"],
  },
};

export function makeSignedWebhookFixture(opts: {
  secret: string;
  envelope?: WebhookEnvelope;
  now?: number;
}): { rawBody: string; headers: { "naulon-signature": string } } {
  const rawBody = JSON.stringify(opts.envelope ?? SAMPLE_ENVELOPE);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  return { rawBody, headers: { "naulon-signature": signPayload(opts.secret, rawBody, now) } };
}
