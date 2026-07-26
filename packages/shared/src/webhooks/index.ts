// Webhook core (part of @naulon/shared) — the machinery the OSS gate and the cloud control plane both
// run: event/channel catalogs + stored shapes and store seams (types), Stripe-style signing (sign),
// per-channel wire transforms (transform), the SSRF-guarded HTTP sender (sender), the enqueue +
// sweep/retry/backoff/dead-letter engine (dispatch), and an in-memory reference delivery store.
//
// Deliberately generic + settlement-agnostic: store IMPLEMENTATIONS live in the consumer (cloud:
// Supabase; OSS gate: env config), and the settlement.completed BODY builder is cloud's concern
// (cloud/src/webhooks/payload.ts) — the gate builds its own basic body inline. Not on the publisher
// (@naulon/sdk) path, so nothing here leaks into a site's install.

export * from "./types.ts";
export * from "./memory-store.ts";
export * from "./sign.ts";
export * from "./transform.ts";
export * from "./sender.ts";
export * from "./dispatch.ts";
