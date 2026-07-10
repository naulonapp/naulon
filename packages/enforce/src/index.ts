/**
 * `@naulon/enforce` — the runtime-agnostic toll-decision kernel + the in-app
 * enforcement middleware. The neutral low-level core that both `@naulon/tollgate`
 * (the gate shell) and `@naulon/sdk` (the publisher SDK) sit ABOVE, with no
 * dependency cycle. Depends only on `@naulon/shared` (+ `viem` for PoP).
 *
 * The Next.js middleware adapter is the separate `@naulon/enforce/next` subpath
 * (it imports `next/server`, so it must not be pulled into the core barrel).
 */

// The decision surface + its wire re-exports (PAYMENT_* headers, PaymentRequirements,
// SettlementLegReq, PAYMENT_LINK_HEADER, Quote, TollKind).
export * from "./decide.ts";

// Classification, Web Bot Auth, nonce replay guard, holder-of-key proof.
export * from "./agentDetect.ts";
export * from "./botAuth.ts";
export * from "./nonce.ts";
export * from "./pop.ts";

// x402 BUILD side — the symbols `decide.ts` does NOT already re-export (avoids the
// wildcard-merge ambiguity that would otherwise drop the shared PAYMENT_*/type names).
export { build402, buildRequirements, bindingOf, MAX_TIMEOUT_SECONDS } from "./build402.ts";

// Pricing (the `quote` value; the `Quote` type comes through `./decide.ts`).
export { quote } from "./pricing.ts";

// Licensing, revocation, discoverability manifest.
export { licensing, type Licensing } from "./license.ts";
export { revocations, type RevocationStore } from "./revocation.ts";
export { X402_MANIFEST_PATH, buildX402Manifest, type X402Manifest } from "./discoverability.ts";

// In-app enforcement middleware (framework-agnostic). The Next adapter is `./next`.
export * from "./enforce/quote-source.ts";
export * from "./enforce/middleware.ts";
export * from "./enforce/fetch-handler.ts";
