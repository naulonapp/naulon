import { test } from "node:test";
import assert from "node:assert/strict";
import { runCheck, type CheckResult } from "./check.ts";

const VALID_CREDITS = {
  slug: "on-stillness",
  title: "On Stillness",
  contributors: [{ authorId: "ava", wallet: "0x1111111111111111111111111111111111111111" }],
};

/** Build a fetch double from a path→Response map keyed by the URL pathname. */
function fetchFor(routes: Record<string, { status: number; body: unknown }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const r = routes[url.pathname];
    if (!r) return new Response("", { status: 404 });
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
}

const get = (o: { checks: CheckResult[] }, name: string) =>
  o.checks.find((c) => c.name === name)!;

test("valid /credits + 404 on a nonexistent slug → all checks pass", async () => {
  const out = await runCheck({
    baseUrl: "https://site.test/api",
    slug: "on-stillness",
    absentSlug: "__missing__",
    fetchImpl: fetchFor({
      "/api/credits/on-stillness": { status: 200, body: VALID_CREDITS },
      // "/api/credits/__missing__" absent → fetchFor returns 404
    }),
  });
  assert.equal(get(out, "credits-endpoint").ok, true);
  assert.equal(get(out, "free-signal-404").ok, true);
  assert.equal(out.allPassed, true);
});

test("200 with a malformed credits body → credits-endpoint fails", async () => {
  const out = await runCheck({
    baseUrl: "https://site.test/api",
    slug: "on-stillness",
    absentSlug: "__missing__",
    fetchImpl: fetchFor({
      "/api/credits/on-stillness": { status: 200, body: { slug: "x", contributors: [{ authorId: "a", wallet: "0xnope" }] } },
    }),
  });
  assert.equal(get(out, "credits-endpoint").ok, false);
  assert.match(get(out, "credits-endpoint").detail, /wallet|invalid|credits/i);
  assert.equal(out.allPassed, false);
});

test("nonexistent slug returns 200 instead of 404 → free-signal fails", async () => {
  const out = await runCheck({
    baseUrl: "https://site.test/api",
    slug: "on-stillness",
    absentSlug: "__missing__",
    fetchImpl: fetchFor({
      "/api/credits/on-stillness": { status: 200, body: VALID_CREDITS },
      "/api/credits/__missing__": { status: 200, body: VALID_CREDITS },
    }),
  });
  assert.equal(get(out, "free-signal-404").ok, false);
  assert.equal(out.allPassed, false);
});

test("non-200 from the endpoint → credits-endpoint fails with the status", async () => {
  const out = await runCheck({
    baseUrl: "https://site.test/api",
    slug: "on-stillness",
    absentSlug: "__missing__",
    fetchImpl: fetchFor({ "/api/credits/on-stillness": { status: 500, body: "boom" } }),
  });
  assert.equal(get(out, "credits-endpoint").ok, false);
  assert.match(get(out, "credits-endpoint").detail, /500/);
});

test("--token is forwarded as a Bearer header on the credits fetch", async () => {
  let sawAuth: string | null = "MISSING";
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    sawAuth = (init.headers as Record<string, string> | undefined)?.authorization ?? null;
    return new Response(JSON.stringify(VALID_CREDITS), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  await runCheck({ baseUrl: "https://site.test/api", slug: "on-stillness", absentSlug: "__missing__", token: "tkn-123", fetchImpl: impl });
  assert.equal(sawAuth, "Bearer tkn-123");
});

test("--secret produces a signed settlement fixture for offline receiver testing", async () => {
  const out = await runCheck({
    baseUrl: "https://site.test/api",
    slug: "on-stillness",
    absentSlug: "__missing__",
    secret: "shh",
    fetchImpl: fetchFor({ "/api/credits/on-stillness": { status: 200, body: VALID_CREDITS } }),
  });
  assert.ok(out.fixture, "a fixture should be emitted when --secret is given");
  assert.match(out.fixture!.headers["x-naulon-signature"], /^sha256=/);
  assert.ok(out.fixture!.rawBody.length > 0);
});
