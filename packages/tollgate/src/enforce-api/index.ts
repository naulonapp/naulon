/**
 * The in-app enforce API: the HTTP plane every runtime that tolls from inside a publisher's own app
 * calls (the `@naulon/enforce` middleware, the WordPress plugin, the Python package).
 *
 * A runtime only classifies. Everything that involves money or a signature is asked of this API:
 * the policy document (`enforce-config`), the price and the 402 body (`quote`), settlement
 * (`verify`), licence checks (`license/check`) and the decision log (`observe`).
 *
 * Who may call it, which publisher a host belongs to, and where observations go are all injected,
 * so the same routes serve a single self-hosted gate (one shared key) and a multi-tenant control
 * plane (per-tenant keys, a database resolver).
 */
import type { Context } from "hono";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { IdentityResult } from "@naulon/enforce";
import type { JwkSet, PublisherConfig, PublisherResolver } from "@naulon/shared";
import type { ObservationEmitter } from "./observation.ts";
import { mountConfig } from "./config.ts";
import { mountStatus } from "./status.ts";
import { mountQuote } from "./quote.ts";
import { mountVerify } from "./verify.ts";
import { mountLicense } from "./license.ts";
import { mountObserve } from "./observe.ts";
import type { build402, licenseEntitlesRead, quote as resolveQuote } from "@naulon/enforce";
import type { settleAndAttribute } from "../settle.ts";

export { fleetAgentHost, rulesOf } from "./config.ts";
export { toObservationEvent, type InAppObservation, type ObservationEmitter, type ReportedAgent } from "./observation.ts";
export { isSingleLegPayment } from "../x402.ts";

/**
 * Decide whether this request may act for `host`'s publisher. Runs before anything else on every
 * route, so an unauthenticated caller learns nothing about which hosts exist. `host` is null when
 * the request named no usable resource; a key check still answers then, so a missing key is a 401
 * before a malformed request is a 400.
 */
export type EnforceAuth = (
  c: Context,
  host: string | null,
) => Promise<
  | { ok: true; publisherId: string; selfHosted: boolean }
  | { ok: false; status: 401 | 403; error: string }
  /** A complete refusal, for an implementation whose auth layer already built one. */
  | { ok: false; response: Response }
>;

/** Side effects only a hosted control plane performs. Every one is optional. */
export interface EnforceApiHooks {
  /** An authenticated config fetch proves the publisher's runtime is installed and running. */
  stampInAppConfig?(publisherId: string, host: string, atMs: number, headers: Headers): void;
  /** Any other authenticated call for an owned host. */
  stampInApp?(publisherId: string, host: string, atMs: number): void;
  /** A call for a host this key's publisher does not own. */
  reportUnownedHost?(publisherId: string, host: string): void;
  /** An owned host the resolver does not route (the publisher serves it from their own runtime). */
  resolveByOwner?(publisherId: string, host: string): Promise<PublisherConfig | undefined>;
  /** The crawler operators this publisher's identity check is armed for. */
  armedFor?(publisherId: string): string[];
  /** CAIP-2 chain named in the licence's `<accepts>` body. */
  x402NetworkFor?(p: { settlementNetwork?: string }): string | undefined;
  /** Whether a publisher refuses a payment that covers less than every leg. */
  requiresFullPayment?(publisherId: string): Promise<boolean>;
  /** Record a runtime's identity verdict. */
  recordIdentity?(publisherId: string, result: IdentityResult, at: number): void;
}

export interface EnforceApiDeps {
  resolver: PublisherResolver;
  auth: EnforceAuth;
  /** Where decisions are recorded. Called fire-and-forget; it must not throw. */
  observe: ObservationEmitter;
  /** Keys licences are verified against. Absent: licence checks answer not entitled. */
  licenseKeys?: JwkSet;
  /** The host the gate signs its origin pulls as, when it signs any. */
  fleetAgent?: string;
  hooks?: EnforceApiHooks;
  now?: () => number;
  /** Test seams for the money path. Production uses the gate's own implementations. */
  impl?: EnforceApiImpl;
}

export interface EnforceApiImpl {
  price?: typeof resolveQuote;
  build402?: typeof build402;
  settle?: typeof settleAndAttribute;
  entitles?: typeof licenseEntitlesRead;
}

export function mountEnforceApi(app: OpenAPIHono, deps: EnforceApiDeps): void {
  mountConfig(app, deps);
  mountStatus(app, deps);
  mountQuote(app, deps);
  mountVerify(app, deps);
  mountLicense(app, deps);
  mountObserve(app, deps);
}
