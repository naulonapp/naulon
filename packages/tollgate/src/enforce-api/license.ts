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
import { authorize, targetOf } from "./authorize.ts";
import type { EnforceApiDeps } from "./index.ts";
import { ErrorSchema, SECURITY } from "./schemas.ts";

const CheckBody = z
  .object({
    /** The licence JWS the agent presented. */
    license: z.string().min(1),
    /** Absolute URL of the resource being re-read. */
    resource: z.string().url(),
    /** Canonical slug the licence must be scoped to. */
    slug: z.string().min(1),
    kind: z.enum(["read", "citation"]).default("read"),
    /** The agent's holder-of-key proof header, forwarded verbatim when it sent one. */
    proof: z.string().optional(),
  })
  .openapi("LicenseCheckBody");

const CheckResult = z.object({ entitled: z.boolean() }).openapi("LicenseCheckResult");

const checkRoute = createRoute({
  method: "post",
  path: "/_naulon/license/check",
  summary: "Does this licence entitle a free re-read?",
  tags: ["Enforce"],
  security: SECURITY,
  request: { body: { content: { "application/json": { schema: CheckBody } }, required: true } },
  responses: {
    200: { description: "The verdict.", content: { "application/json": { schema: CheckResult } } },
    400: { description: "Bad request.", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Missing or invalid key.", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Resource not owned by this key.", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function mountLicense(app: OpenAPIHono, deps: EnforceApiDeps): void {
  const entitles = deps.impl?.entitles ?? licenseEntitlesRead;
  const clock = deps.now ?? Date.now;

  app.openapi(checkRoute, async (c) => {
    const { license, resource, slug, kind, proof } = c.req.valid("json");
    const authed = await authorize(c, deps, targetOf(resource));
    if (!authed.ok) return authed.response as never;
    const { publisher, host } = authed;

    try {
      deps.hooks?.stampInApp?.(publisher.id, host, clock());
    } catch {
      // A heartbeat never costs a verdict.
    }
    if (publisher.suspended) return c.json({ entitled: false }, 200);

    // `licenseEntitlesRead` reads the licence and the proof off the agent's Request. That request
    // happened at the publisher's runtime, so the two headers it needs are rebuilt from what was
    // forwarded.
    const headers = new Headers({ [LICENSE_HEADER]: license });
    if (proof) headers.set(PROOF_HEADER, proof);
    const check = await entitles(
      license,
      slug,
      kind as TollKind,
      new Request(resource, { headers }),
      deps.licenseKeys ? { jwks: deps.licenseKeys, issuer: publisher.licenseIdentity } : undefined,
    );
    const disclosable = !check.ok && check.reason === "no_verifier" ? { reason: "no_verifier" as const } : {};
    return c.json(check.ok ? { entitled: true } : { entitled: false, ...disclosable }, 200);
  });
}
