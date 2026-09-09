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

test("--secret produces a signed webhook fixture for offline receiver testing", async () => {
  const out = await runCheck({
    baseUrl: "https://site.test/api",
    slug: "on-stillness",
    absentSlug: "__missing__",
    secret: "shh",
    fetchImpl: fetchFor({ "/api/credits/on-stillness": { status: 200, body: VALID_CREDITS } }),
  });
  assert.ok(out.fixture, "a fixture should be emitted when --secret is given");
  assert.match(out.fixture!.headers["naulon-signature"], /^t=\d+,v1=[0-9a-f]{64}$/);
  assert.equal(JSON.parse(out.fixture!.rawBody).type, "settlement.completed");
});

/* Reports what nothing else can: a well-formed address that may not be the one meant. Advisory —
 * lower-case is legal, and a check that reddens a pipeline over a legal choice gets switched off. */
const CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"; // the EIP-55 spec's own example

test("a payee address with no checksum is reported, and does NOT fail the run", async () => {
  const out = await runCheck({
    baseUrl: "https://site.test/api",
    slug: "on-stillness",
    absentSlug: "__missing__",
    fetchImpl: fetchFor({
      "/api/credits/on-stillness": {
        status: 200,
        body: { ...VALID_CREDITS, contributors: [{ authorId: "ava", wallet: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" }] },
      },
    }),
  });
  const c = get(out, "wallet-checksum");
  assert.equal(c.ok, false);
  assert.equal(c.level, "advisory");
  assert.match(c.detail, /1 of 1/);
  assert.equal(out.allPassed, true, "an advisory must never redden the run");
});

test("a checksummed payee passes it outright", async () => {
  const out = await runCheck({
    baseUrl: "https://site.test/api",
    slug: "on-stillness",
    absentSlug: "__missing__",
    fetchImpl: fetchFor({
      "/api/credits/on-stillness": {
        status: 200,
        body: { ...VALID_CREDITS, contributors: [{ authorId: "ava", wallet: CHECKSUMMED }] },
      },
    }),
  });
  assert.equal(get(out, "wallet-checksum").ok, true);
});

test("it looks inside composites — a group's members are payees too", async () => {
  const out = await runCheck({
    baseUrl: "https://site.test/api",
    slug: "on-stillness",
    absentSlug: "__missing__",
    fetchImpl: fetchFor({
      "/api/credits/on-stillness": {
        status: 200,
        body: {
          ...VALID_CREDITS,
          contributors: [
            { authorId: "ava", wallet: CHECKSUMMED },
            { authorId: "studio", members: [{ authorId: "bo", wallet: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" }] },
          ],
        },
      },
    }),
  });
  assert.match(get(out, "wallet-checksum").detail, /1 of 2/);
});

test("nothing is claimed about wallets when the endpoint never produced a valid body", async () => {
  const out = await runCheck({
    baseUrl: "https://site.test/api",
    slug: "on-stillness",
    absentSlug: "__missing__",
    fetchImpl: fetchFor({ "/api/credits/on-stillness": { status: 500, body: "" } }),
  });
  assert.equal(
    out.checks.find((c) => c.name === "wallet-checksum"),
    undefined,
    "a check that passes when it could not read its input is worse than no check",
  );
});

/* A WordPress publisher's slug is a PATH — `/%year%/%monthnum%/%day%/%postname%/` is the default
 * permalink. Encoding it whole asked for `2026%2F09%2F08%2F…`, which an origin 404s before the app
 * runs, so this command reported "expected 200, got 404" about an endpoint that was serving
 * correctly — and it is the command a publisher runs precisely when nothing is being tolled. */
test("a hierarchical slug is requested as a path, so `naulon check` asks what the gate asks", async () => {
  const asked: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    asked.push(url.pathname);
    if (url.pathname === "/api/credits/2026/09/08/on-stillness") {
      return new Response(JSON.stringify({ ...VALID_CREDITS, slug: "2026/09/08/on-stillness" }), { status: 200 });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  const out = await runCheck({
    baseUrl: "https://site.test/api",
    slug: "2026/09/08/on-stillness",
    absentSlug: "__missing__",
    fetchImpl: impl,
  });

  assert.equal(get(out, "credits-endpoint").ok, true, get(out, "credits-endpoint").detail);
  assert.ok(
    asked.includes("/api/credits/2026/09/08/on-stillness"),
    `asked for the %2F form instead: ${asked.join(", ")}`,
  );
});
