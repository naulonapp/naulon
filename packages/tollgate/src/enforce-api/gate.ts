/**
 * The enforce API as a self-hosted gate serves it: site credentials issued by connect (and, for a gate
 * set up before connect, the operator key), the gate's own resolver, its observation log and its
 * arming store. Also serves the OpenAPI document at `/_naulon/openapi.json`,
 * generated from the same schemas the routes validate with, so a client in any language can be
 * generated from a running gate and cannot drift from it.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import type { ArmingStore } from "@naulon/enforce";
import { CRAWLER_PROOF, type GateStateStore, type JwkSet, type PublisherResolver } from "@naulon/shared";
import { siteCredentialAuth } from "../connect/auth.ts";
import { observe } from "../observationLog.ts";
import { fleetAgentHost } from "./config.ts";
import { mountEnforceApi } from "./index.ts";
import { toObservationEvent } from "./observation.ts";
import { ENFORCE_API_VERSION, OPENAPI_PATH } from "./schemas.ts";

export interface GateEnforceOptions {
  /** The operator key (`NAULON_ENFORCE_KEY`), for runtimes connected before connect existed. */
  key?: string;
  /** Where site credentials live. */
  state: GateStateStore;
  resolver: PublisherResolver;
  arming: ArmingStore;
  licenseKeys?: JwkSet;
  /** The gate's Web Bot Auth signing seed and advertised agent, when it signs its origin pulls. */
  signingKey?: string;
  signatureAgent?: string;
}

const OPERATOR_IDS = CRAWLER_PROOF.map((r) => r.id);

/** The document metadata, shared by the served document and the committed copy. */
export const OPENAPI_INFO = {
  openapi: "3.1.0",
  info: {
    title: "naulon in-app enforce API",
    version: ENFORCE_API_VERSION,
    description: "What a runtime tolling from inside a publisher's app asks the gate. See docs/protocol/in-app.md.",
  },
};

/** Register the bearer scheme every route names. */
export function registerEnforceSecurity(api: OpenAPIHono): void {
  api.openAPIRegistry.registerComponent("securitySchemes", "naulonKey", { type: "http", scheme: "bearer" });
}

/** Describe the API and serve its document at `OPENAPI_PATH`. */
export function documentEnforceApi(api: OpenAPIHono): void {
  registerEnforceSecurity(api);
  api.doc31(OPENAPI_PATH, OPENAPI_INFO);
}

export function enforceApiForGate(o: GateEnforceOptions): OpenAPIHono {
  const api = new OpenAPIHono();
  const fleetAgent = fleetAgentHost(o.signingKey, o.signatureAgent);
  mountEnforceApi(api, {
    resolver: o.resolver,
    auth: siteCredentialAuth({ state: o.state, resolver: o.resolver, ...(o.key ? { legacyKey: o.key } : {}) }),
    observe: (obs) => observe(toObservationEvent(obs)),
    ...(o.licenseKeys ? { licenseKeys: o.licenseKeys } : {}),
    ...(fleetAgent ? { fleetAgent } : {}),
    hooks: {
      armedFor: (publisherId) => OPERATOR_IDS.filter((id) => o.arming.isArmed(publisherId, id)),
      recordIdentity: (publisherId, result, at) => o.arming.record(publisherId, result, at),
    },
  });
  documentEnforceApi(api);
  return api;
}
