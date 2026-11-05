/**
 * `POST /_naulon/observe`: what an in-app runtime decided, for the decision log.
 *
 * A runtime serving an agent itself is the only witness to the free reads, the refused crawlers and
 * the 402s an agent walked away from. This is where it hands them over, one report or a batch.
 *
 * The money verdicts are refused: `paid` and `payment-failed` are written by `/verify` from the
 * settle outcome, so a publisher can describe its traffic but never mint a payment no settlement
 * backs. `publisherId` is the authenticated publisher, never read from the body, and every host in
 * a batch is ownership-checked before anything is written.
 *
 * Telemetry, not a toll: the answer is `202` as soon as the batch is accepted and shaped.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { CRAWLER_PROOF, FREE_REASONS, type FreeReason, type PublisherConfig } from "@naulon/shared";
import { authBeforeValidation, ownedPublisher } from "./authorize.ts";
import type { EnforceApiDeps } from "./index.ts";
import type { InAppObservation, ReportedAgent } from "./observation.ts";
import { SECURITY } from "./schemas.ts";

/** Verdicts only the publisher's own runtime can witness. */
const REPORTABLE = ["served-free", "agent-reread", "denied", "blocked"] as const;
/** Written by the settle path or the proxy, never reported. In the schema so a client that sends one
 *  is told why rather than handed a generic validation failure. */
const MONEY_VERDICTS = ["paid", "payment-failed", "unservable"] as const;

function isReportable(verdict: string): verdict is (typeof REPORTABLE)[number] {
  return (REPORTABLE as readonly string[]).includes(verdict);
}

/** Reports per call: bounds one call's fan-out of sink writes. */
const MAX_BATCH = 50;
/** A queued batch may be old; older than this is clamped to now rather than written into a closed window. */
const MAX_BACKDATE_MS = 7 * 24 * 60 * 60 * 1000;
/** Tolerated forward clock skew. */
const MAX_SKEW_MS = 5 * 60 * 1000;

const AgentBlock = z
  .object({
    ua: z.string().optional(),
    classifyReason: z.string().optional(),
    verified: z.boolean().optional(),
    verifiedAgent: z.string().optional(),
    sigInvalid: z.boolean().optional(),
  })
  .openapi("ReportedAgent");

const ObservationBody = z
  .object({
    resource: z.string().url().openapi({ example: "https://your-site.com/articles/x", description: "The URL the decision was made for. Its host must be this key's." }),
    slug: z.string().optional().openapi({ example: "articles/x", description: "The slug that was priced. Empty for a gated non-article path." }),
    verdict: z.enum([...REPORTABLE, ...MONEY_VERDICTS]).openapi({ example: "denied", description: "What happened. `paid` and `payment-failed` are refused: /verify writes those." }),
    classifiedAs: z.enum(["human", "agent"]).openapi({ example: "agent" }),
    kind: z.enum(["read", "citation"]).optional(),
    priceMicro: z.number().int().nonnegative().optional().openapi({ example: 1000, description: "What the request would have paid, integer micro-USDC." }),
    at: z.number().int().positive().optional().openapi({ description: "When the decision happened (epoch ms). Defaults to now; clamped." }),
    agent: AgentBlock.optional(),
    referrerHost: z.string().max(253).regex(/^[a-z0-9.-]+$/i).optional().openapi({ example: "chatgpt.com", description: "On a person's read, the host of the site that sent them." }),
    identityCheck: z.enum(["signature", "ip-verified", "unverified", "forged"]).optional(),
    claimedOperator: z.string().max(64).optional().openapi({ example: "google", description: "The crawler operator the user agent claimed. Unknown ids are dropped." }),
    observeOnly: z.boolean().optional().openapi({ description: "The site was observing. Kept only on a `denied` row." }),
    // Strings rather than enums, so an unknown value drops the field instead of failing the batch.
    crawlerBudget: z.string().max(16).optional().openapi({ example: "within", description: "`within` or `over`. Kept only on a `denied` row." }),
    paymentPresented: z.boolean().optional().openapi({ description: "An observing site received a payment it did not settle." }),
    freeReason: z.string().max(16).optional().openapi({ example: "terms", description: "`unpriced`, `terms`, `fleet` or `unavailable` (the gate gave no verdict, so the read was served). Kept only on an agent's `served-free` row." }),
    forgedFrom: z.string().max(64).optional().openapi({ example: "203.0.113.0/24", description: "On a forged row: the caller's network as a /24 or /48. A full address is dropped." }),
  })
  .openapi("ObservationReport");

const ObserveBody = z.union([ObservationBody, z.array(ObservationBody).min(1).max(MAX_BATCH)]);
const ObserveOk = z.object({ ok: z.literal(true), accepted: z.number().int() }).openapi("ObserveAccepted");
const ObserveError = z.object({ ok: z.literal(false), error: z.string() }).openapi("ObserveError");

const observeRoute = createRoute({
  method: "post",
  path: "/_naulon/observe",
  summary: "Report gating decisions",
  tags: ["Enforce"],
  security: SECURITY,
  request: { body: { content: { "application/json": { schema: ObserveBody } }, required: true } },
  responses: {
    202: { description: "Accepted.", content: { "application/json": { schema: ObserveOk } } },
    400: { description: "A money verdict, or a malformed report.", content: { "application/json": { schema: ObserveError } } },
    401: { description: "Missing or invalid key.", content: { "application/json": { schema: ObserveError } } },
    403: { description: "A host not owned by this key.", content: { "application/json": { schema: ObserveError } } },
  },
});

const OPERATOR_IDS = new Set(CRAWLER_PROOF.map((r) => r.id));
const FREE_REASON_SET: ReadonlySet<string> = new Set<string>(FREE_REASONS);
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
/** a.b.c.0/24 or x:y:z::/48, the only forms a client may send. Never a full address. */
const TRUNCATED = new RegExp(`^(?:(?:${OCTET}\\.){3}0\\/24|[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,2}::\\/48)$`, "i");

const failed = (error: string): { ok: false; error: string } => ({ ok: false, error });

export function mountObserve(app: OpenAPIHono, deps: EnforceApiDeps): void {
  const clock = deps.now ?? Date.now;
  authBeforeValidation(app, "/_naulon/observe", deps, failed);

  app.openapi(observeRoute, async (c) => {
    const body = c.req.valid("json");
    const reports = Array.isArray(body) ? body : [body];
    const firstHost = (() => {
      try {
        return new URL(reports[0]?.resource ?? "").host.toLowerCase();
      } catch {
        return null;
      }
    })();
    const auth = await deps.auth(c, firstHost);
    if (!auth.ok) return ("response" in auth ? auth.response : c.json(failed(auth.error), auth.status)) as never;

    const resolved = new Map<string, PublisherConfig | undefined>();
    const shaped: InAppObservation[] = [];
    const t = clock();
    for (const r of reports) {
      if (!isReportable(r.verdict)) {
        return c.json(failed(`"${r.verdict}" is written by /verify from the settle outcome, not reported here`), 400);
      }
      let host: string;
      let path: string;
      try {
        const u = new URL(r.resource);
        host = u.host.toLowerCase();
        // The pathname only: a query can carry the reader's tokens.
        path = u.pathname;
      } catch {
        return c.json(failed("bad resource"), 400);
      }
      // Every distinct host is checked, not just the first, or one owned host would carry reports
      // for the rest. Both checks run per host: the credential's own (a site credential acts for one
      // host only, and only `auth` knows which), then ownership.
      if (!resolved.has(host)) {
        const again = host === firstHost ? auth : await deps.auth(c, host);
        if (!again.ok) return ("response" in again ? again.response : c.json(failed(again.error), again.status)) as never;
        resolved.set(host, again.publisherId === auth.publisherId ? await ownedPublisher(deps, auth.publisherId, host) : undefined);
      }
      const publisher = resolved.get(host);
      if (!publisher) return c.json(failed("resource not owned by this key"), 403);

      try {
        deps.hooks?.stampInApp?.(publisher.id, host, t);
      } catch {
        // A heartbeat never costs a report.
      }
      // Clamped, never trusted: an unbounded `at` would write rows into any reporting window.
      const at = r.at !== undefined && r.at > t - MAX_BACKDATE_MS && r.at < t + MAX_SKEW_MS ? r.at : t;
      const agent: ReportedAgent | undefined = r.agent;
      const claimed = r.claimedOperator !== undefined && OPERATOR_IDS.has(r.claimedOperator) ? r.claimedOperator : undefined;
      const forgedFrom = r.identityCheck === "forged" && r.forgedFrom !== undefined && TRUNCATED.test(r.forgedFrom) ? r.forgedFrom : undefined;
      // The observe facts describe a priced agent read, so they mean nothing on another verdict.
      const priced = r.verdict === "denied";
      const observeOnly = priced && r.observeOnly === true;
      const crawlerBudget = priced && (r.crawlerBudget === "within" || r.crawlerBudget === "over") ? r.crawlerBudget : undefined;
      const paymentPresented = observeOnly && r.paymentPresented === true;
      const freeReason =
        r.verdict === "served-free" && r.classifiedAs === "agent" && FREE_REASON_SET.has(r.freeReason ?? "") ? (r.freeReason as FreeReason) : undefined;
      shaped.push({
        publisherId: publisher.id,
        host,
        slug: r.slug ?? "",
        path,
        ...(r.referrerHost !== undefined && r.classifiedAs === "human" ? { referrerHost: r.referrerHost.toLowerCase() } : {}),
        verdict: r.verdict,
        classifiedAs: r.classifiedAs,
        ...(r.kind !== undefined ? { kind: r.kind } : {}),
        ...(r.priceMicro !== undefined ? { priceUsdc: r.priceMicro / 1_000_000 } : {}),
        at,
        ...(agent ? { agent } : {}),
        ...(r.identityCheck ? { identityCheck: r.identityCheck } : {}),
        ...(claimed ? { claimedOperator: claimed } : {}),
        ...(forgedFrom ? { forgedFrom } : {}),
        ...(observeOnly ? { observeOnly: true as const } : {}),
        ...(crawlerBudget ? { crawlerBudget } : {}),
        ...(paymentPresented ? { paymentPresented: true as const } : {}),
        ...(freeReason ? { freeReason } : {}),
      });
    }
    // Nothing is written until the whole batch has passed ownership, so a 403 never leaves a
    // caller guessing what landed.
    for (const o of shaped) {
      try {
        deps.observe(o);
        if (o.identityCheck && o.claimedOperator) {
          deps.hooks?.recordIdentity?.(
            o.publisherId,
            { check: o.identityCheck, claims: [{ operatorId: o.claimedOperator, operator: o.claimedOperator, fragment: "", check: o.identityCheck }] },
            o.at,
          );
        }
      } catch {
        // A sink failure must never look like a rejected report.
      }
    }
    return c.json({ ok: true as const, accepted: shaped.length }, 202);
  });
}
