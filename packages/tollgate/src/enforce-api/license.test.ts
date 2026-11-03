import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAPIHono } from "@hono/zod-openapi";
import { mountFromHostedDeps as mountEnforceLicense } from "./hostedDeps.testkit.ts";
import type { PublisherConfig } from "@naulon/shared";

const publisher = (over: Partial<PublisherConfig> = {}): PublisherConfig =>
  ({
    id: "pub_a",
    licenseIdentity: "https://gate.naulon.app",
    suspended: false,
    ...over,
  }) as PublisherConfig;

interface Seen {
  entitles: Array<{ jws: string; slug: string; kind: string; identity: string; license: string | null; proof: string | null }>;
  stamped: Array<{ tenantId: string; host: string }>;
}

/** An app whose licence verifier is exactly the injected function — for asserting which refusal
 *  reasons are allowed to cross the wire. */
function mountWithEntitles(entitles: (...a: never[]) => Promise<unknown>): OpenAPIHono {
  const app = new OpenAPIHono();
  mountEnforceLicense(app, {
    resolver: { resolve: async () => publisher() } as never,
    verify: (async () => null) as never,
    apiKeyResolve: (async () => ({ tenantId: "pub_a", ownerUserId: "u1", scopes: ["tenant.read"] })) as never,
    ownsVerifiedHost: async () => false,
    resolveByTenant: async () => undefined,
    licenseKeys: { keys: [] },
    entitles: entitles as never,
  });
  return app;
}

function appWith(opts: {
  resolveKey?: () => { tenantId: string; ownerUserId: string; scopes: string[] } | null;
  resolve?: (host: string) => PublisherConfig | undefined;
  owns?: boolean;
  byTenant?: (tenantId: string, host: string) => PublisherConfig | undefined;
  entitled?: boolean;
}): { app: OpenAPIHono; seen: Seen } {
  const seen: Seen = { entitles: [], stamped: [] };
  const app = new OpenAPIHono();
  mountEnforceLicense(app, {
    resolver: { resolve: async (host: string) => (opts.resolve ? opts.resolve(host) : publisher()) } as never,
    verify: (async () => null) as never,
    apiKeyResolve: (async () =>
      opts.resolveKey ? opts.resolveKey() : { tenantId: "pub_a", ownerUserId: "u1", scopes: ["tenant.read"] }) as never,
    ownsVerifiedHost: async () => opts.owns ?? false,
    resolveByTenant: async (tenantId, host) => (opts.byTenant ? opts.byTenant(tenantId, host) : undefined),
    licenseKeys: { keys: [] },
    stampInApp: (tenantId, host) => {
      seen.stamped.push({ tenantId, host });
    },
    entitles: (async (jws: string, slug: string, kind: string, req: Request, verification: { issuer: string } | undefined) => {
      seen.entitles.push({
        jws,
        slug,
        kind,
        identity: verification?.issuer ?? "",
        // Prove the reconstructed Request actually carries what the verifier reads off it.
        license: req.headers.get("X-Naulon-License"),
        proof: req.headers.get("X-Naulon-Proof"),
      });
      // `licenseEntitlesRead` returns a RESULT, not a boolean: a refusal carries why, so a
      // deployment that can verify nothing is distinguishable from a bad token.
      return (opts.entitled ?? true) ? { ok: true } : { ok: false, reason: "unverifiable" };
    }) as never,
  });
  return { app, seen };
}

const keyHeaders: Record<string, string> = { authorization: "Bearer nln_live_test", "content-type": "application/json" };
const body = (over: Record<string, unknown> = {}) => ({
  license: "jws.header.sig",
  resource: "https://site.example.com/blog/post",
  slug: "blog/post",
  ...over,
});
const post = (b: unknown, headers = keyHeaders) => ({ method: "POST", headers, body: JSON.stringify(b) }) as const;

test("missing key → 401", async () => {
  const { app } = appWith({});
  const res = await app.request("/_naulon/license/check", post(body(), { "content-type": "application/json" }));
  assert.equal(res.status, 401);
});

test("a valid license for an owned resource → entitled:true", async () => {
  const { app, seen } = appWith({ entitled: true });
  const res = await app.request("/_naulon/license/check", post(body()));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { entitled: true, verdict: "paid" });
  assert.equal(seen.entitles.length, 1);
  assert.equal(seen.entitles[0]?.slug, "blog/post");
  assert.equal(seen.entitles[0]?.kind, "read");
  // The publisher's identity — NOT a default — is what pins iss/aud. Getting this wrong is
  // exactly what 402s a valid license.
  assert.equal(seen.entitles[0]?.identity, "https://gate.naulon.app");
});

test("the verifier receives the license and the forwarded proof on the reconstructed request", async () => {
  const { app, seen } = appWith({});
  await app.request("/_naulon/license/check", post(body({ proof: "pop-proof-value" })));
  assert.equal(seen.entitles[0]?.license, "jws.header.sig");
  assert.equal(seen.entitles[0]?.proof, "pop-proof-value");
});

test("no proof forwarded → no proof header invented", async () => {
  const { app, seen } = appWith({});
  await app.request("/_naulon/license/check", post(body()));
  assert.equal(seen.entitles[0]?.proof, null);
});

test("citation kind is carried through — a citation license must not entitle a read by accident", async () => {
  const { app, seen } = appWith({});
  await app.request("/_naulon/license/check", post(body({ kind: "citation" })));
  assert.equal(seen.entitles[0]?.kind, "citation");
});

test("a rejected license → entitled:false with no reason (no oracle for forging)", async () => {
  const { app } = appWith({ entitled: false });
  const res = await app.request("/_naulon/license/check", post(body()));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { entitled: false, verdict: "refused" });
});

// The one refusal that is NOT about the token, and therefore the one that may be disclosed.
// `no_verifier` means this deployment can verify nothing — every valid licence is being refused
// and every agent charged twice. Withholding it is what made that condition invisible while it
// billed one article four times in a day; disclosing the others would hand a forger an oracle.
test("no_verifier IS disclosed — a deployment fault must be visible to the caller", async () => {
  const appNoVerifier = mountWithEntitles(async () => ({ ok: false, reason: "no_verifier" }));
  const res = await appNoVerifier.request("/_naulon/license/check", post(body()));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { entitled: false, verdict: "refused", reason: "no_verifier" });
});

test("a TOKEN-side refusal still discloses nothing — the forging oracle stays shut", async () => {
  for (const reason of ["unverifiable", "grant_none", "not_covered", "kind_mismatch", "revoked"]) {
    const a = mountWithEntitles(async () => ({ ok: false, reason }));
    const res = await a.request("/_naulon/license/check", post(body()));
    assert.deepEqual(await res.json(), { entitled: false, verdict: "refused" }, `${reason} must not reach the caller`);
  }
});

test("another tenant's resource → 403, never a verdict", async () => {
  const { app, seen } = appWith({ resolve: () => publisher({ id: "pub_other" }) });
  const res = await app.request("/_naulon/license/check", post(body()));
  assert.equal(res.status, 403);
  assert.deepEqual(seen.entitles, []);
});

test("an in-app host missing from hosts[] resolves by proven ownership", async () => {
  const { app, seen } = appWith({
    resolve: () => undefined, // a routing miss: an in-app host is not in the resolver's set
    owns: true,
    byTenant: () => publisher(),
  });
  const res = await app.request("/_naulon/license/check", post(body()));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { entitled: true, verdict: "paid" });
  assert.deepEqual(seen.stamped, [{ tenantId: "pub_a", host: "site.example.com" }]);
});

test("byHost miss with NO proven ownership → 403", async () => {
  const { app } = appWith({ resolve: () => undefined, owns: false });
  const res = await app.request("/_naulon/license/check", post(body()));
  assert.equal(res.status, 403);
});

test("a suspended publisher entitles nothing", async () => {
  const { app, seen } = appWith({ resolve: () => publisher({ suspended: true }) });
  const res = await app.request("/_naulon/license/check", post(body()));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { entitled: false, verdict: "refused" });
  assert.deepEqual(seen.entitles, []);
});

test("a malformed resource is a 400, not a crash", async () => {
  const { app } = appWith({});
  const res = await app.request("/_naulon/license/check", post(body({ resource: "not-a-url" })));
  assert.equal(res.status, 400);
});

test("an empty license is refused by the schema", async () => {
  const { app, seen } = appWith({});
  const res = await app.request("/_naulon/license/check", post(body({ license: "" })));
  assert.equal(res.status, 400);
  assert.deepEqual(seen.entitles, []);
});
