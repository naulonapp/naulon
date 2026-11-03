/**
 * `POST /_naulon/license/check`: does a licence an agent presents entitle it to a free re-read?
 *
 * A Node runtime verifies locally with `licenseEntitlesRead`. Any other runtime would have to
 * re-implement EdDSA JWS verification and the entitlement rules (issuer and audience pinning, slug
 * scope, kind, expiry, the holder-of-key binding), so this route runs the same function the gate
 * runs, for the publisher resolved the same way every other route resolves it.
 *
 * The answer is a bare boolean. Saying why a token failed would let a caller probe the verifier with
 * forged tokens to learn its rules. The one reason that crosses is `no_verifier`, because it is about
 * this deployment rather than the token: it means every valid licence is being refused.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { LICENSE_HEADER, PROOF_HEADER, licenseEntitlesRead } from "@naulon/enforce";
import type { TollKind } from "@naulon/shared";
import { authBeforeValidation, authorize, refuseUnreadable, targetOf } from "./authorize.ts";
import type { EnforceApiDeps } from "./index.ts";
import { ErrorSchema, SECURITY } from "./schemas.ts";

/** The shape the handler enforces. Parsed in the handler, not by the route validator, so a body
 *  this gate cannot read still gets a verdict rather than a bare validation error. */
const CheckBodyStrict = z.object({
  license: z.string().min(1),
  resource: z.string().url(),
  slug: z.string().min(1),
  kind: z.enum(["read", "citation"]).default("read"),
  proof: z.string().optional(),
});

const CheckBody = z
  .object({
    license: z.string().min(1).optional().openapi({ description: "The licence JWS the agent presented (required)." }),
    resource: z.string().optional().openapi({ description: "Absolute URL of the resource being re-read (required).", example: "https://your-site.com/articles/x" }),
    slug: z.string().min(1).optional().openapi({ description: "Canonical slug the licence must be scoped to (required)." }),
    kind: z.enum(["read", "citation"]).optional().openapi({ description: "Defaults to `read`." }),
    proof: z.string().optional().openapi({ description: "The agent's holder-of-key proof header, forwarded verbatim when it sent one." }),
  })
  .openapi("LicenseCheckBody");

const CheckResult = z
  .object({
    entitled: z.boolean(),
    verdict: z.enum(["paid", "refused"]).openapi({ description: "`paid`: serve it free, the read was paid for. `refused`: answer the 402. Switch on this, never on the HTTP status." }),
    reason: z.literal("no_verifier").optional(),
  })
  .openapi("LicenseCheckResult");

const refused = { entitled: false, verdict: "refused" } as const;

const checkRoute = createRoute({
  method: "post",
  path: "/_naulon/license/check",
  summary: "Does this licence entitle a free re-read?",
  tags: ["Enforce"],
  security: SECURITY,
  request: { body: { content: { "application/json": { schema: CheckBody } }, required: false } },
  responses: {
    200: { description: "The verdict.", content: { "application/json": { schema: CheckResult } } },
    400: { description: "Bad request (`verdict: refused`).", content: { "application/json": { schema: CheckResult } } },
    401: { description: "Missing or invalid key. Carries no verdict: serve the page.", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Resource not owned by this key. Carries no verdict: serve the page.", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function mountLicense(app: OpenAPIHono, deps: EnforceApiDeps): void {
  const entitles = deps.impl?.entitles ?? licenseEntitlesRead;
  const clock = deps.now ?? Date.now;

  authBeforeValidation(app, "/_naulon/license/check", deps, undefined, () => refused);

  app.openapi(checkRoute, async (c) => {
    const parsed = CheckBodyStrict.safeParse(await c.req.json().catch(() => undefined));
    // Authenticated already (`authBeforeValidation`): an unreadable body is refused, never served free.
    if (!parsed.success) return c.json(refused, 400) as never;
    const { license, resource, slug, kind, proof } = parsed.data;
    const target = targetOf(resource);
    if ("error" in target) return c.json(refused, 400) as never;
    const authed = await authorize(c, deps, target);
    if (!authed.ok) return authed.response as never;
    const { publisher, host } = authed;

    try {
      deps.hooks?.stampInApp?.(publisher.id, host, clock());
    } catch {
      // A heartbeat never costs a verdict.
    }
    if (publisher.suspended) return c.json(refused, 200);

    // `licenseEntitlesRead` reads the licence and the proof off the agent's Request. That request
    // happened at the publisher's runtime, so the two headers it needs are rebuilt from what was
    // forwarded.
    //
    // Everything here reads the agent's own bytes, so a throw is the agent's doing and answers as a
    // refusal. A 5xx would be read by the runtime as the gate failing, and serve the page free on
    // demand (a licence carrying a byte `Headers` refuses was exactly that).
    let check: Awaited<ReturnType<typeof entitles>>;
    try {
      const headers = new Headers({ [LICENSE_HEADER]: license });
      if (proof) headers.set(PROOF_HEADER, proof);
      check = await entitles(
        license,
        slug,
        kind as TollKind,
        new Request(resource, { headers }),
        deps.licenseKeys ? { jwks: deps.licenseKeys, issuer: publisher.licenseIdentity } : undefined,
      );
    } catch {
      return c.json(refused, 200);
    }
    const disclosable = !check.ok && check.reason === "no_verifier" ? { reason: "no_verifier" as const } : {};
    return c.json(check.ok ? { entitled: true, verdict: "paid" as const } : { ...refused, ...disclosable }, 200);
  }, refuseUnreadable(() => refused));
}
