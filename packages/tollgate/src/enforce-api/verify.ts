/**
 * `POST /_naulon/verify`: settle a payment an in-app runtime relays, and answer whether to serve.
 *
 * The runtime is the publisher's own code, so nothing it sends about money is taken on trust:
 *  - the buyer-signed legs must equal, as a multiset of (payTo, amount), the legs the quote implies;
 *  - when the publisher owes additive legs (an operator fee), the price is re-derived from the
 *    publisher's configuration and the signed legs must carry every owed leg.
 * Both are checked before anything reaches the facilitator, so a refusal never moves money.
 *
 * The money verdicts (`paid`, `payment-failed`) are written here and nowhere else on this plane,
 * which is why `/observe` refuses them from a client.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { build402, settledChargedMicro, tollPrice, type SettlementLegReq } from "@naulon/enforce";
import { classifyPaymentFailure, toAtomicUsdc, usdc } from "@naulon/shared";
import { canonicalResource } from "../resource.ts";
import { settleAndAttribute } from "../settle.ts";
import { isSingleLegPayment } from "../x402.ts";
import { authorize, targetOf } from "./authorize.ts";
import type { EnforceApiDeps } from "./index.ts";
import type { ReportedAgent } from "./observation.ts";
import { SECURITY } from "./schemas.ts";

const AgentBlock = z
  .object({
    ua: z.string().optional(),
    classifyReason: z.string().optional(),
    verified: z.boolean().optional(),
    verifiedAgent: z.string().optional(),
    sigInvalid: z.boolean().optional(),
  })
  .openapi("ObservedAgent", { description: "Who the caller was, as the publisher's classifier saw them. Never used for authorization." });

/** The shape the handler enforces. `legs` and `quote` are opaque here: the settle layer validates the
 *  legs against the buyer's signature, and the checks below hold the quote to them. */
const VerifyBodyStrict = z.object({
  payment: z.string().min(1),
  legs: z.array(z.unknown()),
  quote: z.unknown(),
  resource: z.string().url(),
  agent: AgentBlock.optional(),
});

/** The documented body: the same fields, optional, so the OpenAPI validator never answers before auth. */
const VerifyBodyDoc = z
  .object({
    payment: z.string().min(1).optional().openapi({ description: "The buyer's x402 payment payload (required)." }),
    legs: z.array(z.unknown()).optional().openapi({ description: "Settlement legs, validated against the signature (required)." }),
    quote: z.unknown().openapi({ description: "The quote that priced the resource (required)." }),
    resource: z.string().optional().openapi({ example: "https://your-site.com/articles/x" }),
    agent: AgentBlock.optional(),
  })
  .openapi("VerifyRequest");

const VerifyOk = z
  .object({
    ok: z.literal(true),
    settlementRef: z.string().optional(),
    payer: z.string().optional(),
    responseHeader: z.string().optional(),
    licenseJws: z.string().optional(),
    /** What the buyer was actually charged, integer micro-USDC as a string. */
    chargedMicro: z.string().optional(),
  })
  .openapi("VerifyReceipt");

const VerifyError = z.object({ ok: z.literal(false), error: z.string() }).openapi("VerifyError");

const verifyRoute = createRoute({
  method: "post",
  path: "/_naulon/verify",
  summary: "Settle a relayed payment",
  tags: ["Enforce"],
  security: SECURITY,
  request: { body: { content: { "application/json": { schema: VerifyBodyDoc } }, required: false } },
  responses: {
    200: { description: "Settled: serve the resource.", content: { "application/json": { schema: VerifyOk } } },
    400: { description: "Malformed body, quote or legs.", content: { "application/json": { schema: VerifyError } } },
    401: { description: "Missing or invalid key.", content: { "application/json": { schema: VerifyError } } },
    402: { description: "Not settled, or the site is observing.", content: { "application/json": { schema: VerifyError } } },
    403: { description: "Not owned, or suspended.", content: { "application/json": { schema: VerifyError } } },
  },
});

const failed = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** (payTo, amount) for one settlement leg; the address lowercased so checksum case never mismatches. */
function legKey(leg: unknown): string {
  const r = (leg as { requirements?: { payTo?: unknown; amount?: unknown } }).requirements;
  const payTo = typeof r?.payTo === "string" ? r.payTo.toLowerCase() : "";
  const amount = typeof r?.amount === "string" || typeof r?.amount === "number" ? String(r.amount) : "";
  return `${payTo}@${amount}`;
}

/** Do the signed legs equal the quote's legs as a multiset? No phantom recipient, none dropped. */
function legsMatchQuote(signed: unknown[], expected: SettlementLegReq[]): boolean {
  if (signed.length !== expected.length) return false;
  const a = signed.map(legKey).sort();
  const b = expected.map(legKey).sort();
  return a.every((k, i) => k === b[i]);
}

/** Do the signed legs contain every owed additive leg? Matched on (payTo, amount), never on the
 *  caller's role label, and as a multiset so one signed leg never satisfies two owed ones. */
function owedLegsSigned(signed: unknown[], owed: readonly { payTo: string; amount: string }[]): boolean {
  const pool = new Map<string, number>();
  for (const leg of signed) pool.set(legKey(leg), (pool.get(legKey(leg)) ?? 0) + 1);
  for (const leg of owed) {
    const k = `${leg.payTo.toLowerCase()}@${String(leg.amount)}`;
    const left = pool.get(k) ?? 0;
    if (left === 0) return false;
    pool.set(k, left - 1);
  }
  return true;
}

export function mountVerify(app: OpenAPIHono, deps: EnforceApiDeps): void {
  const settle = deps.impl?.settle ?? settleAndAttribute;
  const derive402 = deps.impl?.build402 ?? build402;
  const clock = deps.now ?? Date.now;

  // Auth runs before the OpenAPI body validator, so an unauthenticated caller always gets 401 and
  // never a validation 400.
  app.use("/_naulon/verify", async (c, next) => {
    if (c.req.method !== "POST") return next();
    const body: unknown = await c.req.json().catch(() => undefined);
    const resource = (body as { resource?: unknown } | undefined)?.resource;
    const target = targetOf(typeof resource === "string" ? resource : undefined);
    const auth = await deps.auth(c, "host" in target ? target.host : null);
    if (!auth.ok) return "response" in auth ? auth.response : c.json(failed(auth.error), auth.status);
    return next();
  });

  app.openapi(verifyRoute, async (c) => {
    const parsed = VerifyBodyStrict.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      // Still authenticate first, so the refusal order matches every other route.
      const authed = await authorize(c, deps, { error: "bad request" }, failed);
      return (authed.ok ? c.json(failed("bad request"), 400) : authed.response) as never;
    }
    const { payment, legs, quote, resource, agent } = parsed.data;
    const authed = await authorize(c, deps, targetOf(resource), failed);
    if (!authed.ok) return authed.response as never;
    const { publisher, host, path: pricePath } = authed;

    try {
      deps.hooks?.stampInApp?.(publisher.id, host, clock());
    } catch {
      // A heartbeat never costs a settle.
    }
    if (publisher.suspended) return c.json(failed("suspended"), 403);
    // An observing site takes no money, whatever runtime asks it to.
    if (publisher.tollMode === "observe") return c.json(failed("observing"), 402);

    let expectedLegs: SettlementLegReq[];
    try {
      expectedLegs = derive402(quote as never, resource, clock()).legs;
    } catch {
      return c.json(failed("bad quote"), 400);
    }
    if (!legsMatchQuote(legs, expectedLegs)) return c.json(failed("legs do not match quote"), 400);

    if (publisher.extraLegs) {
      const price = (quote as { price?: unknown }).price;
      // A zero or negative price makes every additive leg resolve to nothing owed, which is the
      // shape this check refuses. A free read never reaches here: `/quote` answers 204.
      if (typeof price !== "number" || !(price > 0)) return c.json(failed("bad quote"), 400);
      const kind = (quote as { kind?: unknown }).kind === "citation" ? "citation" : "read";
      const pricedFor = (quote as { pricedFor?: unknown }).pricedFor;
      // The price of record, from the same formula the quoting path uses, compared in atomic units.
      if (toAtomicUsdc(price) !== toAtomicUsdc(tollPrice(publisher, kind, pricePath, typeof pricedFor === "string" ? pricedFor : undefined))) {
        return c.json(failed("quote price does not match tenant record"), 400);
      }
      const owed = publisher.extraLegs(usdc(price), kind);
      if (owed.length > 0 && !owedLegsSigned(legs, owed)) return c.json(failed("operator fee leg missing"), 400);
    }

    // A publisher may refuse a stock payer's single signature against a multi-leg quote. Refused
    // before the facilitator, so nothing moves and the buyer can pay again with every leg.
    if (legs.length > 1 && deps.hooks?.requiresFullPayment && isSingleLegPayment(payment)
      && (await deps.hooks.requiresFullPayment(publisher.id).catch(() => false))) {
      return c.json(failed(`this site requires every leg to be signed: ${legs.length} legs were quoted, 1 was signed`), 402);
    }

    const settled = await settle({
      payment,
      legs: legs as never,
      quote: quote as never,
      publisher,
      host,
      resource: canonicalResource(host, pricePath),
      now: clock(),
    });

    const q = quote as { slug?: unknown; kind?: unknown; price?: unknown };
    const observedAgent: ReportedAgent | undefined = agent;
    try {
      deps.observe({
        publisherId: publisher.id,
        host,
        slug: typeof q.slug === "string" ? q.slug : "",
        kind: q.kind === "citation" ? "citation" : "read",
        verdict: settled.ok ? "paid" : "payment-failed",
        classifiedAs: "agent",
        ...(typeof q.price === "number" ? { priceUsdc: q.price } : {}),
        // A closed set, never `settled.error`: that string names legs, payees and amounts.
        ...(settled.ok ? {} : { failureReason: classifyPaymentFailure(settled.error) }),
        ...(settled.ok && settled.eventId ? { licenseJti: settled.eventId } : {}),
        at: clock(),
        ...(observedAgent ? { agent: observedAgent } : {}),
      });
    } catch {
      // The decision log never costs the buyer the read they paid for.
    }

    if (!settled.ok) return c.json(failed(settled.error ?? "settlement failed"), 402);
    return c.json(
      {
        ok: true,
        settlementRef: settled.settlementRef,
        payer: settled.payer,
        responseHeader: settled.responseHeader,
        licenseJws: settled.licenseJws,
        // `expectedLegs`, not the caller's legs: the two were proven the same multiset above, and
        // this side is the one the buyer did not write.
        chargedMicro: settledChargedMicro(expectedLegs, settled.forgoneLegs).toString(),
      },
      200,
    );
  });
}
