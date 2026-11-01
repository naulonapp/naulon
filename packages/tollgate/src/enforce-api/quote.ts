/**
 * `GET /_naulon/quote`: what one resource costs, and with `build=402` the whole 402 an agent should
 * receive.
 *
 * `build=402` exists for runtimes that cannot import `@naulon/enforce`. Porting the leg and rounding
 * math into PHP or Python would put a second copy of the settlement arithmetic in the world, and one
 * wrong rounding rule in it pays an author the wrong amount. Building the 402 here keeps exactly one
 * implementation; every other runtime is a transport for it.
 *
 * 204 is the free-read answer: untollable, free-listed, wallet-less, or terms that give agent reads
 * away.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { build402, quote as resolveQuote } from "@naulon/enforce";
import type { TollKind } from "@naulon/shared";
import { authorize, targetOf } from "./authorize.ts";
import type { EnforceApiDeps } from "./index.ts";
import { ErrorSchema, SECURITY } from "./schemas.ts";

const MicroUsdc = z.number().int().nonnegative();

const QuoteSchema = z
  .object({
    price: MicroUsdc,
    extraLegs: z
      .array(z.object({ role: z.string(), payTo: z.string(), amount: z.string() }))
      .optional()
      .openapi({ description: "Additive settlement legs beyond the author's. Every one must be paid." }),
  })
  .passthrough()
  .openapi("Quote", {
    description:
      "Custody-free quote. `price` is the author leg in micro-USDC and `extraLegs` carries every other "
      + "transfer the same read requires, so the amount to authorize is `price` plus every extra leg. "
      + "Pass `build=402` to receive the built 402 instead of assembling legs yourself. `204` = free.",
  });

const quoteRoute = createRoute({
  method: "get",
  path: "/_naulon/quote",
  summary: "Price one resource",
  tags: ["Enforce"],
  security: SECURITY,
  request: {
    query: z.object({
      resource: z.string().optional().openapi({ example: "https://your-site.com/articles/x" }),
      slug: z.string().optional().openapi({ example: "articles/x" }),
      kind: z.enum(["read", "citation"]).optional(),
      verifiedAgent: z.string().optional().openapi({
        description: "A Web Bot Auth identity (signature directory host) your runtime verified. Never a User-Agent.",
        example: "chatgpt.com",
      }),
      // A string, not a literal: anything other than "402" is treated as absent, never a 400.
      build: z.string().optional().openapi({ description: "`402` returns the built 402 as `x402: { header, legs }`.", example: "402" }),
      observe: z.string().optional().openapi({ description: "`1` from a runtime that can observe a read with nobody to pay." }),
    }),
  },
  responses: {
    200: { description: "The quote.", content: { "application/json": { schema: QuoteSchema } } },
    204: { description: "No toll: a free read." },
    400: { description: "Missing or invalid params.", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Missing or invalid key.", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Resource not owned by this key.", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const AGENT_HOST = /^[a-z0-9.-]{1,253}$/;

export function mountQuote(app: OpenAPIHono, deps: EnforceApiDeps): void {
  const price = deps.impl?.price ?? resolveQuote;
  const derive402 = deps.impl?.build402 ?? build402;
  const clock = deps.now ?? Date.now;

  app.openapi(quoteRoute, async (c) => {
    const resource = c.req.query("resource");
    const slug = c.req.query("slug");
    // A missing slug is the same refusal as a missing resource, decided after auth.
    const authed = await authorize(c, deps, slug ? targetOf(resource) : { error: "bad request" });
    if (!authed.ok) return authed.response as never;
    const { publisher, host, path } = authed;
    const kind: TollKind = c.req.query("kind") === "citation" ? "citation" : "read";

    try {
      deps.hooks?.stampInApp?.(publisher.id, host, clock());
    } catch {
      // A heartbeat must never cost a price.
    }

    if (publisher.termsPolicy?.["ai-input"] === "free") return c.body(null, 204);

    const claimed = c.req.query("verifiedAgent")?.trim().toLowerCase();
    const verifiedAgent = claimed && AGENT_HOST.test(claimed) ? claimed : undefined;
    const quote = await price(publisher, slug as string, kind, path, verifiedAgent);
    if (!quote) return c.body(null, 204);
    // Nobody to pay: priced only so an observing runtime can report the read. A runtime that has not
    // said it can observe keeps the free-read 204.
    if (quote.payees.length === 0 && c.req.query("observe") !== "1") return c.body(null, 204);

    if (c.req.query("build") === "402") {
      if (quote.payees.length === 0) return c.json({ ...quote, x402: { header: "", legs: [] } }, 200);
      const built = derive402(quote, resource as string, clock());
      return c.json({ ...quote, x402: { header: built.header, legs: built.legs } }, 200);
    }
    return c.json(quote, 200);
  });
}
