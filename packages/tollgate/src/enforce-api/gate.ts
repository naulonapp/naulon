/**
 * The enforce API as a self-hosted gate serves it: one shared key, the gate's own resolver, its
 * observation log and its arming store. Also serves the OpenAPI document at `/_naulon/openapi.json`,
 * generated from the same schemas the routes validate with, so a client in any language can be
 * generated from a running gate and cannot drift from it.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import type { ArmingStore } from "@naulon/enforce";
import { CRAWLER_PROOF, type JwkSet, type PublisherResolver } from "@naulon/shared";
import { observe } from "../observationLog.ts";
import { fleetAgentHost } from "./config.ts";
import { mountEnforceApi } from "./index.ts";
import { toObservationEvent } from "./observation.ts";
import { ENFORCE_API_VERSION, OPENAPI_PATH } from "./schemas.ts";
import { sharedKeyAuth } from "./sharedKeyAuth.ts";

export interface GateEnforceOptions {
  key: string;
  resolver: PublisherResolver;
  arming: ArmingStore;
  licenseKeys?: JwkSet;
  /** The gate's Web Bot Auth signing seed and advertised agent, when it signs its origin pulls. */
  signingKey?: string;
  signatureAgent?: string;
}

const OPERATOR_IDS = CRAWLER_PROOF.map((r) => r.id);

/** Describe the API: the bearer scheme every route names, and the document metadata. */
export function documentEnforceApi(api: OpenAPIHono): void {
  api.openAPIRegistry.registerComponent("securitySchemes", "naulonKey", { type: "http", scheme: "bearer" });
  api.doc31(OPENAPI_PATH, {
    openapi: "3.1.0",
    info: {
      title: "naulon in-app enforce API",
      version: ENFORCE_API_VERSION,
      description: "What a runtime tolling from inside a publisher's app asks the gate. See docs/protocol/in-app.md.",
    },
  });
}

export function enforceApiForGate(o: GateEnforceOptions): OpenAPIHono {
  const api = new OpenAPIHono();
  const fleetAgent = fleetAgentHost(o.signingKey, o.signatureAgent);
  mountEnforceApi(api, {
    resolver: o.resolver,
    auth: sharedKeyAuth(o.key, o.resolver),
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
