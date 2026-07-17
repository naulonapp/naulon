/**
 * Config validation — the licensing superRefine. Tested against the exported
 * configSchema so we don't have to mutate process.env or the getConfig singleton.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { configSchema, getConfig, resetConfig } from "./config.ts";

function issuePaths(env: Record<string, string>): string[] {
  const r = configSchema.safeParse(env);
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
}

// getConfig()/resetConfig() drive process.env directly (unlike the configSchema.safeParse
// tests above, which never touch it) — restore the env after so a dual-mode/Arc choice
// never leaks into another test in this suite.
afterEach(() => {
  delete process.env.CIRCLE_API_KEY_TESTNET;
  delete process.env.ARC_RPC_URL;
  delete process.env.RELAYER_PRIVATE_KEY_MAINNET;
  resetConfig();
});

test("mock mode with zero creds parses — the offline loop stays unbroken", () => {
  const r = configSchema.safeParse({});
  assert.equal(r.success, true);
  assert.ok(r.success && r.data.LICENSES_ENABLED === true); // default on
  assert.ok(r.success && r.data.LICENSE_TTL_SECONDS === 600);
});

test("a stable LICENSE_SIGNING_KEY is required once real money moves (gateway)", () => {
  assert.ok(issuePaths({ PAYMENT_MODE: "gateway" }).includes("LICENSE_SIGNING_KEY"));
  // ...and satisfied when the key is present.
  assert.equal(
    issuePaths({ PAYMENT_MODE: "gateway", LICENSE_SIGNING_KEY: "dummy" }).includes("LICENSE_SIGNING_KEY"),
    false,
  );
});

test("a stable key is required with a supabase backend, even in mock", () => {
  const paths = issuePaths({
    EVENTS_BACKEND: "supabase",
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_KEY: "k",
  });
  assert.ok(paths.includes("LICENSE_SIGNING_KEY"));
});

test("ephemeral key is allowed in single-instance mock (no issue raised)", () => {
  assert.equal(issuePaths({ PAYMENT_MODE: "mock" }).includes("LICENSE_SIGNING_KEY"), false);
});

test("disabling licenses lifts the stable-key requirement", () => {
  assert.equal(
    issuePaths({ PAYMENT_MODE: "gateway", LICENSES_ENABLED: "false" }).includes("LICENSE_SIGNING_KEY"),
    false,
  );
});

test("X402_MAX_TIMEOUT_SECONDS default clears Circle's 7-day validity floor", () => {
  const r = configSchema.safeParse({});
  assert.ok(r.success && r.data.X402_MAX_TIMEOUT_SECONDS >= 604_900);
});

test("an X402_MAX_TIMEOUT_SECONDS below the 604900 floor is rejected (footgun regression guard)", () => {
  // 345600 = the old hardcoded 4d value — below the floor, it must not be settable again.
  assert.ok(issuePaths({ X402_MAX_TIMEOUT_SECONDS: "345600" }).includes("X402_MAX_TIMEOUT_SECONDS"));
  // The floor itself (604900 = 7d + the SDK's 100s buffer) is accepted.
  assert.equal(
    issuePaths({ X402_MAX_TIMEOUT_SECONDS: "604900" }).includes("X402_MAX_TIMEOUT_SECONDS"),
    false,
  );
});

test("LICENSE_TTL_SECONDS is capped at 3600", () => {
  assert.ok(issuePaths({ LICENSE_TTL_SECONDS: "4000" }).includes("LICENSE_TTL_SECONDS"));
  assert.equal(issuePaths({ LICENSE_TTL_SECONDS: "3600" }).includes("LICENSE_TTL_SECONDS"), false);
});

test("holder-of-key (LICENSE_POP) is off by default with a 120s window", () => {
  const r = configSchema.safeParse({});
  assert.ok(r.success && r.data.LICENSE_POP === false);
  assert.ok(r.success && r.data.LICENSE_POP_WINDOW_SECONDS === 120);
});

test("LICENSE_POP_WINDOW_SECONDS is capped at 600 (replay window stays tight)", () => {
  assert.ok(issuePaths({ LICENSE_POP_WINDOW_SECONDS: "900" }).includes("LICENSE_POP_WINDOW_SECONDS"));
  assert.equal(issuePaths({ LICENSE_POP_WINDOW_SECONDS: "600" }).includes("LICENSE_POP_WINDOW_SECONDS"), false);
});

// ── BUY-3 decision-policy env (server-config, never LLM-controlled) ──
test("WAYFARER domain lists parse to non-empty host arrays, else undefined", () => {
  const parse = (env: Record<string, string>) => {
    const r = configSchema.safeParse(env);
    assert.ok(r.success);
    return r.data;
  };
  assert.deepEqual(parse({ WAYFARER_ALLOW_DOMAINS: "a.com, b.com ,, " }).WAYFARER_ALLOW_DOMAINS, ["a.com", "b.com"]);
  assert.equal(parse({}).WAYFARER_ALLOW_DOMAINS, undefined, "unset ⇒ undefined (no restriction)");
  assert.equal(parse({ WAYFARER_ALLOW_DOMAINS: "," }).WAYFARER_ALLOW_DOMAINS, undefined, "blank/malformed ⇒ undefined, NOT an allow-nothing []");
  assert.deepEqual(parse({ WAYFARER_DENY_DOMAINS: "evil.example" }).WAYFARER_DENY_DOMAINS, ["evil.example"]);
});

test("WAYFARER_KILL_SWITCH coerces only 'true'/'1' to true; default false", () => {
  const kill = (v?: string) => {
    const r = configSchema.safeParse(v === undefined ? {} : { WAYFARER_KILL_SWITCH: v });
    assert.ok(r.success);
    return r.data.WAYFARER_KILL_SWITCH;
  };
  assert.equal(kill(), false, "default off");
  assert.equal(kill("true"), true);
  assert.equal(kill("1"), true);
  assert.equal(kill("false"), false, "'false' does NOT coerce true (the naive z.coerce.boolean footgun)");
  assert.equal(kill("no"), false);
});

test("dual-mode + arc env vars parse and default to undefined", () => {
  delete process.env.CIRCLE_API_KEY_TESTNET;
  delete process.env.ARC_RPC_URL;
  delete process.env.RELAYER_PRIVATE_KEY_MAINNET;
  resetConfig();
  const c = getConfig();
  assert.equal(c.CIRCLE_API_KEY_TESTNET, undefined);
  assert.equal(c.ARC_RPC_URL, undefined);
  assert.equal(c.RELAYER_PRIVATE_KEY_MAINNET, undefined);

  process.env.CIRCLE_API_KEY_TESTNET = "test-key";
  process.env.ARC_RPC_URL = "https://arc.example/rpc";
  resetConfig();
  const c2 = getConfig();
  assert.equal(c2.CIRCLE_API_KEY_TESTNET, "test-key");
  assert.equal(c2.ARC_RPC_URL, "https://arc.example/rpc");
});
