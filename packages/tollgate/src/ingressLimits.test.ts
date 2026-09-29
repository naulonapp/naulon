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
      forwarded: `for=${client};host=${site}`,
      "x-naulon-edge-auth": sharedEdge,
    },
  });
}

test("each crawler behind one CDN gets its own bucket, per publisher", async () => {
  const app = ingressApp();
  assert.equal((await hit(app, "www.a.example", "203.0.113.1")).status, 200);
  assert.equal((await hit(app, "www.a.example", "203.0.113.1")).status, 200);
  const third = await hit(app, "www.a.example", "203.0.113.1");
  assert.equal(third.status, 429);
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
