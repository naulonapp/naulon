// Webhook core (part of @naulon/shared) — the machinery the OSS gate and the cloud control plane both
// run: event/channel catalogs + stored shapes and store seams (types), per-channel wire transforms
// (transform), the SSRF-guarded HTTP sender (sender), the enqueue + sweep/retry/backoff/dead-letter
// engine (dispatch), and two reference delivery stores — in-memory (tests) and a JSONL journal (the
// self-host default: durable across a restart, and readable by the dashboard process, which shares
// nothing with the gate but files).
//
// Deliberately generic + settlement-agnostic: store IMPLEMENTATIONS live in the consumer (cloud:
// Supabase; OSS gate: env config), and the settlement.completed BODY builder is cloud's concern
// (cloud/src/webhooks/payload.ts) — the gate builds its own basic body inline. The MACHINERY is not
// on the publisher path; nothing here leaks into a site's install.
//
// The one exception, and it is deliberate: the Stripe-style signature primitive lives in
// @naulon/sdk (`crypto/webhook.ts`), because verifying it is exactly what a publisher installs the
// SDK to do. The sender imports the signer from there and it is re-exported here, so the bytes a
// publisher verifies are produced by the same function — one implementation, not two that drift.

export * from "./types.ts";
export * from "./memory-store.ts";
export * from "./jsonl-store.ts";
export { signPayload, verifyPayload } from "@naulon/sdk";
export * from "./transform.ts";
export * from "./sender.ts";
export * from "./dispatch.ts";
