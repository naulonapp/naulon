/**
 * Rate limiting and the self-host env on the crawler route.
 *
 * Before admission every crawler behind one publisher's CDN arrives from that CDN's egress
 * addresses, which other publishers share too. So the ingress is limited after admission, per
 * (publisher, crawler address from `Forwarded: for=`), and the global limiter leaves it alone.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublisherConfig } from "@naulon/shared";

const selfEdge = randomBytes(24).toString("hex");
process.env.EVENTS_PATH = join(tmpdir(), `naulon-ingress-limits-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "60";
process.env.RATE_LIMIT_BURST = "2";
process.env.INGRESS_HOST = "ingress.self.test";
process.env.EDGE_SECRET = selfEdge;
// The sender of a request that reaches no site (a miss, an open route) is keyed like any other
// request, so the tests name it the way a proxy in front of the gate would.
process.env.TRUST_PROXY = "true";

const { createApp } = await import("./app.ts");
const { edgeSecretDigest } = await import("./ingress.ts");
const { usdc, walletAddress } = await import("@naulon/shared");

function pub(id: string): PublisherConfig {
  return {
    id,
    originUrl: `https://origin.${id}.example`,
    articlePrefixes: ["essays"],
    price: usdc(0.001),
    citationMultiplier: 5,
    credits: {
      async resolve(slug: string) {
        return { slug, title: slug, contributors: [{ authorId: "a", wallet: walletAddress("0x0000000000000000000000000000000000000001") }] };
      },
    },
    licenseIdentity: `naulon:${id}`,
  };
}

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async () => new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });

const sharedEdge = randomBytes(24).toString("hex");
function ingressApp() {
  return createApp(
    { async resolve() { return undefined; } },
    {
      ingress: {
        host: "ingress.naulon.test",
        async resolve(site) {
          return site === "www.a.example" || site === "www.b.example"
            ? { config: pub(site.split(".")[1]!), edgeSecretDigests: [edgeSecretDigest(sharedEdge)] }
            : undefined;
        },
      },
    },
  );
}
function hit(app: ReturnType<typeof createApp>, site: string, client: string) {
  return app.request("/about", {
    headers: {
      host: "ingress.naulon.test",
      "user-agent": "GPTBot/1.2",
      forwarded: `for=${client};host=${site};naulon-route=2`,
      "x-naulon-edge-auth": sharedEdge,
    },
  });
}

test("each crawler behind one CDN gets its own bucket, per publisher", async () => {
  const app = ingressApp();
  assert.equal((await hit(app, "www.a.example", "203.0.113.1")).status, 200);
  assert.equal((await hit(app, "www.a.example", "203.0.113.1")).status, 200);
  const third = await hit(app, "www.a.example", "203.0.113.1");
  assert.equal(third.status, 429, "a revision-2 route file relays the 429");
  assert.equal(third.headers.get("cache-control"), "no-store");
  assert.equal((await hit(app, "www.a.example", "203.0.113.2")).status, 200, "another crawler on the same CDN is unaffected");
  assert.equal((await hit(app, "www.b.example", "203.0.113.1")).status, 200, "the same crawler on another publisher is unaffected");
});

test("self-host env ingress: the default app admits INGRESS_HOST with EDGE_SECRET", async () => {
  const app = createApp();
  const ok = await app.request("/about", {
    headers: { host: "ingress.self.test", "user-agent": "GPTBot/1.2", forwarded: "host=www.self.example", "x-naulon-edge-auth": selfEdge },
  });
  assert.equal(ok.status, 200);
  assert.ok(ok.headers.get("cache-control")?.startsWith("private"), "admitted, so treated as ingress traffic");
  const wrong = await app.request("/about", {
    headers: { host: "ingress.self.test", "user-agent": "GPTBot/1.2", forwarded: "host=www.self.example", "x-naulon-edge-auth": randomBytes(24).toString("hex") },
  });
  assert.equal(wrong.status, 502);
});

test("the env secret is never handed to an injected multi-publisher resolver", async () => {
  const app = createApp({ async resolve() { return pub("many"); } });
  const res = await app.request("/about", {
    headers: { host: "ingress.self.test", "user-agent": "GPTBot/1.2", forwarded: "host=www.victim.example", "x-naulon-edge-auth": selfEdge },
  });
  // The injected resolver answers the ingress hostname as an ordinary Host: nothing was admitted,
  // so the response is not ingress traffic and names no site.
  assert.equal(res.headers.get("cache-control")?.startsWith("private") ?? false, false);
});

function fromCaller(app: ReturnType<typeof createApp>, path: string, caller: string) {
  return app.request(path, { headers: { host: "ingress.naulon.test", "x-forwarded-for": caller } });
}

test("the gate's own routes on the ingress are limited per sender, not left open", async () => {
  const app = ingressApp();
  const codes: number[] = [];
  for (let i = 0; i < 3; i++) codes.push((await fromCaller(app, "/healthz", "198.51.100.7")).status);
  assert.deepEqual(codes, [200, 200, 429]);
  assert.equal((await fromCaller(app, "/healthz", "198.51.100.8")).status, 200, "another sender has its own budget");
});

test("misses and ?host= reads on the ingress share one budget per sender", async () => {
  const app = ingressApp();
  const a = await fromCaller(app, "/.well-known/x402?host=www.a.example", "198.51.100.9");
  const b = await fromCaller(app, "/essays/x", "198.51.100.9");
  const c = await fromCaller(app, "/.well-known/x402?host=www.a.example", "198.51.100.9");
  assert.deepEqual([a.status, b.status, c.status], [200, 502, 429]);
});

test("an ingress host that is not a bare hostname stops the app from being built", () => {
  for (const host of ["https://ingress.naulon.test", "ingress.naulon.test:443", "INGRESS.naulon.test", "localhost"]) {
    assert.throws(() => createApp({ async resolve() { return undefined; } }, { ingress: { host, async resolve() { return undefined; } } }), /bare lowercase hostname/, host);
  }
});

test("self-host: INGRESS_HOST without EDGE_SECRET, or the reverse, fails at boot", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const appPath = fileURLToPath(new URL("./app.ts", import.meta.url));
  for (const env of [{ INGRESS_HOST: "ingress.self.test" }, { EDGE_SECRET: selfEdge }]) {
    // Importing the module builds the default app, which is the boot a self-hoster runs.
    const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `await import(${JSON.stringify(appPath)});`], {
      env: { PATH: process.env.PATH, NODE_ENV: "test", PAYMENT_MODE: "mock", EVENTS_PATH: process.env.EVENTS_PATH, ...env },
      encoding: "utf8",
    });
    assert.notEqual(run.status, 0, JSON.stringify(Object.keys(env)));
    assert.match(run.stderr, /set both, or neither/, JSON.stringify(Object.keys(env)));
  }
});

test("a sender out of miss budget is refused before the site is looked up", async () => {
  let lookups = 0;
  const app = createApp(
    { async resolve() { return undefined; } },
    { ingress: { host: "ingress.naulon.test", async resolve() { lookups++; return undefined; } } },
  );
  const probe = (edge: string | null) =>
    app.request("/essays/x", {
      headers: {
        host: "ingress.naulon.test",
        "x-forwarded-for": "198.51.100.20",
        forwarded: "host=www.random.example",
        ...(edge ? { "x-naulon-edge-auth": edge } : {}),
      },
    });
  assert.equal((await probe(null)).status, 502);
  assert.equal(lookups, 0, "no secret, no lookup");
  const codes = [(await probe(sharedEdge)).status, (await probe(sharedEdge)).status];
  assert.deepEqual(codes, [502, 429], "burst 2: the secretless miss and one looked-up miss, then refused");
  assert.equal(lookups, 1, "the refused request never reached the resolver");
});

test("one site's refused requests never use up another site's budget behind the same CDN", async () => {
  let lookups = 0;
  const good = randomBytes(24).toString("hex");
  const app = createApp(
    { async resolve() { return undefined; } },
    {
      ingress: {
        host: "ingress.naulon.test",
        async resolve(site) {
          lookups++;
          return site === "www.b.example" ? { config: pub("b"), edgeSecretDigests: [edgeSecretDigest(good)] } : undefined;
        },
      },
    },
  );
  // Every request below comes from ONE sender: the CDN's egress.
  const via = (site: string, edge: string) =>
    app.request("/about", {
      headers: {
        host: "ingress.naulon.test",
        "x-forwarded-for": "198.51.100.30",
        "user-agent": "GPTBot/1.2",
        forwarded: `for=203.0.113.9;host=${site}`,
        "x-naulon-edge-auth": edge,
      },
    });
  const stale = [];
  for (let i = 0; i < 4; i++) stale.push((await via("www.a.example", sharedEdge)).status);
  assert.deepEqual(stale, [502, 502, 429, 429], "the site with a stale rule is refused once its budget is spent");
  assert.notEqual((await via("www.b.example", good)).status, 429, "a correctly routed site behind the same CDN is untouched");
});

test("a site that has been admitted is never refused by a stranger's misses on the same egress", async () => {
  const good = randomBytes(24).toString("hex");
  const app = createApp(
    { async resolve() { return undefined; } },
    {
      ingress: {
        host: "ingress.naulon.test",
        async resolve(site) {
          return site === "www.b.example" ? { config: pub("b"), edgeSecretDigests: [edgeSecretDigest(good)] } : undefined;
        },
      },
    },
  );
  const via = (site: string, edge: string, crawler: string) =>
    app.request("/about", {
      headers: {
        host: "ingress.naulon.test",
        "x-forwarded-for": "198.51.100.50",
        "user-agent": "GPTBot/1.2",
        forwarded: `for=${crawler};host=${site}`,
        "x-naulon-edge-auth": edge,
      },
    });
  assert.equal((await via("www.b.example", good, "203.0.113.1")).status, 200);
  // A stranger on the same egress names b with a forged secret until b's miss budget is gone.
  for (let i = 0; i < 5; i++) await via("www.b.example", randomBytes(24).toString("hex"), "203.0.113.66");
  // The route serves the origin free on a refusal, so b's own crawlers must still be admitted.
  assert.equal((await via("www.b.example", good, "203.0.113.2")).status, 200);
});

test("a site whose secret stops matching loses its pass through the pre-check", async () => {
  let current = randomBytes(24).toString("hex");
  const app = createApp(
    { async resolve() { return undefined; } },
    {
      ingress: {
        host: "ingress.naulon.test",
        async resolve(site) {
          return site === "www.b.example" ? { config: pub("b"), edgeSecretDigests: [edgeSecretDigest(current)] } : undefined;
        },
      },
    },
  );
  const old = current;
  const via = (edge: string) =>
    app.request("/about", {
      headers: { host: "ingress.naulon.test", "x-forwarded-for": "198.51.100.60", "user-agent": "GPTBot/1.2", forwarded: "for=203.0.113.5;host=www.b.example", "x-naulon-edge-auth": edge },
    });
  assert.equal((await via(old)).status, 200);
  current = randomBytes(24).toString("hex"); // rotated
  const codes = [(await via(old)).status, (await via(old)).status, (await via(old)).status];
  assert.deepEqual(codes, [502, 502, 429], "the old secret is back under the miss budget after its first miss");
});

test("an older route file never receives a 429, because it would serve the page free on one", async () => {
  const app = ingressApp();
  // An older file forwards the crawler's own headers, so a crawler can add anything it likes
  // except `Forwarded`, which the file replaces. A revision claimed in a header must change nothing.
  const old = (client: string) =>
    app.request("/about", {
      headers: { host: "ingress.naulon.test", "user-agent": "GPTBot/1.2", forwarded: `for=${client};host=www.a.example`, "x-naulon-edge-auth": sharedEdge, "x-naulon-route": "2" },
    });
  const codes = [(await old("203.0.113.70")).status, (await old("203.0.113.70")).status];
  const third = await old("203.0.113.70");
  assert.deepEqual(codes, [200, 200]);
  assert.equal(third.status, 403);
  assert.ok(third.headers.get("retry-after"), "the wait is still stated");
});
