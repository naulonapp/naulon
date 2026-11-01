/**
 * `GET /_naulon/enforce-config`: the policy an in-app runtime enforces before it prices anything.
 *
 * What is in scope, who reads free, who is refused, who is charged anyway, and which identity signs
 * a licence. Read from the publisher's configuration on every fetch, so a change reaches the
 * runtime without a redeploy.
 *
 * The response is an explicit projection, written one key at a time, never a spread of the
 * configuration: a secret field added to `PublisherConfig` cannot reach a publisher's runtime until
 * someone adds it here on purpose. It carries no price and no chain either; those belong to the
 * quote, per slug, and travel together.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { buildX402Manifest } from "@naulon/enforce";
import { CRAWLER_REGISTRY, activeNetwork, getNetwork, prohibitedUse, type PublisherConfig } from "@naulon/shared";
import { buildRslDocument } from "../rsl/document.ts";
import { termsFor } from "../rsl/terms.ts";
import { authorize, hostOfResource } from "./authorize.ts";
import type { EnforceApiDeps } from "./index.ts";
import { ErrorSchema, SECURITY } from "./schemas.ts";

const ConfigSchema = z
  .looseObject({ enforcement: z.looseObject({}) })
  .openapi("EnforcementConfig", {
    description: "The decision inputs an in-app enforcer reads before pricing, plus the x402 manifest and the RSL licence.",
  });

const configRoute = createRoute({
  method: "get",
  path: "/_naulon/enforce-config",
  summary: "The enforcement config for a resource's publisher",
  tags: ["Enforce"],
  security: SECURITY,
  request: {
    query: z.object({ resource: z.string().optional().openapi({ example: "https://your-site.com/articles/x" }) }),
  },
  responses: {
    200: { description: "The config.", content: { "application/json": { schema: ConfigSchema } } },
    400: { description: "Missing or invalid resource.", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Missing or invalid key.", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Resource not owned by this key.", content: { "application/json": { schema: ErrorSchema } } },
  },
});

/** The fields `decide()` reads off a publisher. Absent stays absent, never `undefined` on the wire:
 *  a runtime merges this over its local floor, and a present-but-empty value would overwrite it. */
function enforcementOf(p: PublisherConfig, fleetAgent: string | undefined) {
  return {
    articlePrefixes: p.articlePrefixes,
    licenseIdentity: p.licenseIdentity,
    ...(p.gateScope !== undefined ? { gateScope: p.gateScope } : {}),
    ...(p.seoAllowlist !== undefined ? { seoAllowlist: p.seoAllowlist } : {}),
    ...(p.crawlerPolicy !== undefined ? { crawlerPolicy: p.crawlerPolicy } : {}),
    ...(p.identityMode !== undefined ? { identityMode: p.identityMode } : {}),
    ...(p.tollMode !== undefined ? { tollMode: p.tollMode } : {}),
    ...(p.termsPolicy !== undefined ? { termsPolicy: p.termsPolicy } : {}),
    ...(p.licenceServer !== undefined ? { licenceServer: p.licenceServer } : {}),
    // The publisher id is required beside the agent: any operator can name any site as its origin,
    // so the agent alone would let another publisher's pull read this site free.
    ...(fleetAgent !== undefined ? { fleetAgent, fleetPublisher: p.id } : {}),
  };
}

/** The bare hostname the gate signs its origin pulls as, or undefined when it signs none. */
export function fleetAgentHost(signingKey: string | undefined, agent: string | undefined): string | undefined {
  if (!signingKey || !agent) return undefined;
  try {
    return new URL(agent.includes("://") ? agent : `https://${agent}`).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The same enforcement, pre-resolved for a runtime that cannot import `@naulon/shared` (PHP,
 * Python). It applies these lists in `decide()`'s order (block, classify, refusal, free) without
 * re-deriving a rule. `refuse.crawlers` is the registry in order, so a runtime taking the FIRST
 * fragment found in the user agent resolves an overlap (`applebot` inside `applebot-extended`)
 * exactly as `prohibitedUse` does.
 */
export function rulesOf(p: PublisherConfig) {
  const policy = p.termsPolicy;
  const refusesAny = Boolean(policy && (policy.search === "prohibit" || policy["ai-train"] === "prohibit" || policy["ai-input"] === "prohibit"));
  return {
    block: p.crawlerPolicy?.block ?? [],
    allow: [...(p.seoAllowlist ?? []), ...(p.crawlerPolicy?.allow ?? [])],
    charge: p.crawlerPolicy?.charge ?? [],
    refuse: {
      crawlers: refusesAny
        ? CRAWLER_REGISTRY.map((c) => [c.fragment, prohibitedUse({ policy, ua: c.fragment, classifiedAs: "human" }) !== null] as const)
        : [],
      agents: policy?.["ai-input"] === "prohibit",
    },
    agentReadsFree: policy?.["ai-input"] === "free",
    forged: p.crawlerPolicy?.forged ?? "charge",
    identityMode: p.identityMode ?? "auto",
    tollMode: p.tollMode ?? "charge",
  };
}

export function mountConfig(app: OpenAPIHono, deps: EnforceApiDeps): void {
  const clock = deps.now ?? Date.now;
  app.openapi(configRoute, async (c) => {
    const authed = await authorize(c, deps, hostOfResource(c.req.query("resource")));
    if (!authed.ok) return authed.response as never;
    const { publisher, host } = authed;

    // Fire-and-forget: the config answers before any heartbeat write lands.
    try {
      deps.hooks?.stampInAppConfig?.(publisher.id, host, clock(), c.req.raw.headers);
    } catch {
      // A failed heartbeat must never cost the runtime its policy.
    }

    const net = publisher.settlementNetwork ? getNetwork(publisher.settlementNetwork) : activeNetwork();
    const license = buildRslDocument(termsFor(host, publisher, deps.hooks?.x402NetworkFor?.(publisher)));
    c.header("cache-control", "private, no-store");
    return c.json(
      {
        enforcement: enforcementOf(publisher, deps.fleetAgent),
        rules: rulesOf(publisher),
        // Sent empty included: runtimes keep a last-good copy, so silence would leave a disarmed
        // site armed.
        ...(deps.hooks?.armedFor ? { identity: { armed: deps.hooks.armedFor(publisher.id) } } : {}),
        manifest: buildX402Manifest(publisher, net),
        license,
      },
      200,
    );
  });
}
