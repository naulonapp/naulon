import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runDoctor, parseEnvFile, type DoctorInputs } from "./doctor.ts";

const WALLET = "0x1111111111111111111111111111111111111111";
const CREDITS = JSON.stringify({
  "on-stillness": { slug: "on-stillness", title: "On Stillness", contributors: [{ authorId: "you", wallet: WALLET }] },
});
const MOCK_ENV = `PAYMENT_MODE=mock\nORIGIN_URL=https://mysite.com\nTOLLGATE_PORT=8402\nARTICLE_PATH_PREFIXES=essays\nCREDITS_FIXTURES=./credits.json\n`;

/** Base inputs: valid mock env + a 1-entry credits file, no live probe. */
function base(overrides: Partial<DoctorInputs> = {}): DoctorInputs {
  return {
    envText: MOCK_ENV,
    fileExists: () => true,
    readFile: () => CREDITS,
    cwd: "/proj",
    ...overrides,
  };
}
const find = (checks: { name: string; level: string; detail: string }[], name: string) => checks.find((c) => c.name === name);

test("parseEnvFile ignores comments + blanks, keeps KEY=VALUE", () => {
  const env = parseEnvFile("# a comment\n\nPAYMENT_MODE=mock\nORIGIN_URL=https://x.com\n");
  assert.deepEqual(env, { PAYMENT_MODE: "mock", ORIGIN_URL: "https://x.com" });
});

test("parseEnvFile reads a value the way the gate's dotenv does", () => {
  const env = parseEnvFile(
    [
      "ORIGIN_URL=http://localhost:3000     # the site the gate sits in front of",
      "CREDITS_API_URL=",
      "CIRCLE_API_KEY=   # filled in for gateway mode",
      'QUOTED="a # not a comment"',
      "export PAYMENT_MODE=mock",
      "HASH_IN_VALUE=abc#123",
    ].join("\n"),
  );
  assert.deepEqual(env, {
    ORIGIN_URL: "http://localhost:3000",
    QUOTED: "a # not a comment",
    PAYMENT_MODE: "mock",
    HASH_IN_VALUE: "abc#123",
  });
});

test("a .env copied from .env.example passes the env check", async () => {
  const example = readFileSync(new URL("../../../../.env.example", import.meta.url), "utf8");
  const out = await runDoctor(base({ envText: example }));
  assert.equal(find(out.checks, "env")?.level, "pass", find(out.checks, "env")?.detail);
});

test("missing .env → env fails hard, not ok", async () => {
  const out = await runDoctor(base({ envText: null }));
  assert.equal(out.ok, false);
  assert.equal(find(out.checks, "env")?.level, "fail");
});

test("valid mock setup → env pass, credits pass, settlement warns (mock), overall ok", async () => {
  const out = await runDoctor(base());
  assert.equal(find(out.checks, "env")?.level, "pass");
  assert.equal(find(out.checks, "credits")?.level, "pass");
  assert.match(find(out.checks, "credits")!.detail, /1 valid entry/);
  assert.equal(find(out.checks, "settlement")?.level, "warn");
  assert.equal(out.ok, true); // warnings don't fail
});

test("invalid env value (bad ORIGIN_URL) → env fail", async () => {
  const out = await runDoctor(base({ envText: "ORIGIN_URL=not-a-url\n" }));
  assert.equal(find(out.checks, "env")?.level, "fail");
  assert.equal(out.ok, false);
});

test("gateway on arcTestnet without RELAYER_PRIVATE_KEY → settlement warn", async () => {
  const env = "PAYMENT_MODE=gateway\nSETTLEMENT_NETWORK=arcTestnet\nCREDITS_FIXTURES=./credits.json\n";
  const out = await runDoctor(base({ envText: env }));
  assert.equal(find(out.checks, "settlement")?.level, "warn");
  assert.match(find(out.checks, "settlement")!.detail, /RELAYER_PRIVATE_KEY/);
});

test("credits file missing → credits fail", async () => {
  const out = await runDoctor(base({ fileExists: () => false }));
  assert.equal(find(out.checks, "credits")?.level, "fail");
  assert.equal(out.ok, false);
});

test("credits file with a malformed wallet → credits fail", async () => {
  const bad = JSON.stringify({ x: { slug: "x", title: "X", contributors: [{ authorId: "a", wallet: "0xnothex" }] } });
  const out = await runDoctor(base({ readFile: () => bad }));
  assert.equal(find(out.checks, "credits")?.level, "fail");
});

test("live probe: human free + agent 402 → both pass", async () => {
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const ua = String((init?.headers as Record<string, string>)["user-agent"] ?? "");
    return ua.includes("python")
      ? new Response(null, { status: 402, headers: { "payment-required": "x" } })
      : new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  const out = await runDoctor(base({ fetchImpl }));
  assert.equal(find(out.checks, "gate:human")?.level, "pass");
  assert.equal(find(out.checks, "gate:agent")?.level, "pass");
  assert.equal(out.ok, true);
});

test("live probe: a human tolled (402) → gate:human FAIL (humans must read free)", async () => {
  const fetchImpl = (async () => new Response(null, { status: 402, headers: { "payment-required": "x" } })) as unknown as typeof fetch;
  const out = await runDoctor(base({ fetchImpl }));
  assert.equal(find(out.checks, "gate:human")?.level, "fail");
  assert.equal(out.ok, false);
});

test("live probe: gate unreachable → warn, not fail", async () => {
  const fetchImpl = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const out = await runDoctor(base({ fetchImpl }));
  assert.equal(find(out.checks, "gate")?.level, "warn");
  assert.equal(out.ok, true);
});
