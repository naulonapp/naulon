/**
 * Test support: mount the enforce API from the dependency shape the hosted control plane's route
 * tests were written against (a key resolver, ownership hooks, injectable money path), so those
 * suites run unchanged against the public module.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { JwkSet, PublisherConfig, PublisherResolver } from "@naulon/shared";
import { mountEnforceApi, type EnforceApiHooks, type EnforceApiImpl, type ObservationEmitter } from "./index.ts";

export interface HostedDeps {
  resolver: PublisherResolver;
  apiKeyResolve: (token: string) => Promise<{ tenantId: string } | null>;
  /** Accepted and ignored: the hosted session verifier never runs on the key path. */
  verify?: unknown;
  observe?: ObservationEmitter;
  licenseKeys?: JwkSet;
  stampInApp?: (tenantId: string, host: string, atMs: number) => void;
  recordIdentity?: EnforceApiHooks["recordIdentity"];
  requiresFullPayment?: (tenantId: string) => Promise<boolean>;
  ownsVerifiedHost?: (tenantId: string, host: string) => Promise<boolean>;
  resolveByTenant?: (tenantId: string, host: string) => Promise<PublisherConfig | undefined>;
  settle?: EnforceApiImpl["settle"];
  build402?: EnforceApiImpl["build402"];
  entitles?: EnforceApiImpl["entitles"];
  now?: () => number;
}

export function mountFromHostedDeps(app: OpenAPIHono, d: HostedDeps): void {
  mountEnforceApi(app, {
    resolver: d.resolver,
    auth: async (c) => {
      const h = c.req.header("authorization");
      const key = h?.startsWith("Bearer ") ? await d.apiKeyResolve(h.slice(7)) : null;
      return key ? { ok: true, publisherId: key.tenantId, selfHosted: false } : { ok: false, status: 401, error: "unauthorized" };
    },
    observe: d.observe ?? (() => {}),
    ...(d.licenseKeys ? { licenseKeys: d.licenseKeys } : {}),
    hooks: {
      ...(d.stampInApp ? { stampInApp: d.stampInApp } : {}),
      ...(d.recordIdentity ? { recordIdentity: d.recordIdentity } : {}),
      ...(d.requiresFullPayment ? { requiresFullPayment: d.requiresFullPayment } : {}),
      ...(d.ownsVerifiedHost && d.resolveByTenant
        ? { resolveByOwner: hostedOwnership(d.ownsVerifiedHost, d.resolveByTenant) }
        : {}),
    },
    impl: {
      ...(d.settle ? { settle: d.settle } : {}),
      ...(d.build402 ? { build402: d.build402 } : {}),
      ...(d.entitles ? { entitles: d.entitles } : {}),
    },
    ...(d.now ? { now: d.now } : {}),
  });
}

function hostedOwnership(
  owns: NonNullable<HostedDeps["ownsVerifiedHost"]>,
  byTenant: NonNullable<HostedDeps["resolveByTenant"]>,
): (id: string, host: string) => Promise<PublisherConfig | undefined> {
  return async (id, host) => ((await owns(id, host)) ? byTenant(id, host) : undefined);
}
