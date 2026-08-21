import { test } from "node:test";
import assert from "node:assert/strict";
import { runSelftest, readQuote, mockSignature, SELFTEST_PAYER, type SelftestInputs, type SelftestStep } from "./selftest.ts";

const WALLET = "0x1111111111111111111111111111111111111111";
const CREDITS = JSON.stringify({
  "on-stillness": { slug: "on-stillness", title: "On Stillness", contributors: [{ authorId: "you", wallet: WALLET }] },
});
const ENV = `PAYMENT_MODE=mock\nTOLLGATE_PORT=8402\nARTICLE_PATH_PREFIXES=essays\nCREDITS_FIXTURES=./credits.json\n`;

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const find = (steps: SelftestStep[], name: string) => steps.find((s) => s.name === name);

const MANIFEST = {
  resources: { pathPrefixes: ["essays"] },
  payment: { price: { read: { atomic: "1000" }, citation: { atomic: "5000" } } },
};

/** A licence body shaped like the gate's — only the claims the run reads. */
function licence(slug: string): string {
  const claims = { naulon: { slug, payees: [{ authorId: "you", wallet: WALLET, share: 1 }] } };
  return `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
}

function quoteHeader(amount: string, nonce = "n-1"): string {
  return b64({ accepts: [{ amount, payTo: WALLET, extra: { nonce } }] });
}

interface GateOpts {
  humanStatus?: number;
  readAmount?: string;
  citationAmount?: string;
  /** Signatures already spent — a second presentation gets a fresh 402. */
  replayAllowed?: boolean;
  payStatus?: number;
  withLicence?: boolean;
}

/**
 * A gate in ~40 lines: free for a reader, 402 with a quote for an agent, 200 for an agent
 * carrying a well-formed mock signature, and 402 again if that same signature comes back.
 *
 * It classifies the way the real one does — DECLARED INTENT only (`x-naulon-agent` or a payment
 * header), never a user-agent guess. An earlier fake sniffed for `Mozilla/` and happily called
 * the selftest an agent, which is exactly why the first live run against a real gate failed:
 * the fake was more credulous than the thing it stood in for.
 */
function fakeGate(o: GateOpts = {}): typeof fetch {
  const spent = new Set<string>();
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url.endsWith("/.well-known/x402")) {
      return new Response(JSON.stringify(MANIFEST), { status: 200, headers: { "content-type": "application/json" } });
    }
    const declared = headers.get("x-naulon-agent") !== null || headers.get("payment-signature") !== null;
    if (!declared) return new Response("<h1>free</h1>", { status: o.humanStatus ?? 200 });

    const citation = headers.get("x-naulon-kind") === "citation";
    const amount = citation ? (o.citationAmount ?? "5000") : (o.readAmount ?? "1000");
    const sig = headers.get("payment-signature");
    if (!sig) {
      return new Response("", { status: 402, headers: { "payment-required": quoteHeader(amount, citation ? "n-cite" : "n-read") } });
    }
    if (spent.has(sig) && !o.replayAllowed) {
      return new Response("", { status: 402, headers: { "payment-required": quoteHeader(amount, "n-fresh") } });
    }
    spent.add(sig);
    const status = o.payStatus ?? 200;
    if (status !== 200) return new Response("", { status });
    const h = new Headers({ "payment-response": b64({ success: true }) });
    if (o.withLicence !== false) h.set("x-naulon-license", licence("on-stillness"));
    return new Response("<h1>paid</h1>", { status: 200, headers: h });
  }) as typeof fetch;
}

function base(overrides: Partial<SelftestInputs> = {}): SelftestInputs {
  return {
    envText: ENV,
    fileExists: () => true,
    readFile: () => CREDITS,
    cwd: "/proj",
    fetchImpl: fakeGate(),
    ...overrides,
  };
}

test("readQuote pulls amount, payTo and the nonce out of a 402 header", () => {
  const q = readQuote(quoteHeader("1000", "abc"));
  assert.deepEqual(q, { amount: "1000", payTo: WALLET, nonce: "abc" });
});

test("readQuote refuses garbage rather than inventing a quote", () => {
  assert.equal(readQuote(null), undefined);
  assert.equal(readQuote("not-base64-json"), undefined);
  assert.equal(readQuote(b64({ accepts: [] })), undefined);
  assert.equal(readQuote(b64({ accepts: [{ payTo: WALLET }] })), undefined, "an entry with no amount is not payable");
});

test("the mock signature is the shape the gate accepts: {payer, amount, nonce}, base64", () => {
  const decoded = JSON.parse(Buffer.from(mockSignature("0xabc", "1000", "n"), "base64").toString("utf8"));
  assert.deepEqual(decoded, { payer: "0xabc", amount: "1000", nonce: "n" });
});

test("the happy path clears every step and reports what it authorized", async () => {
  const out = await runSelftest(base());
  assert.equal(out.ok, true, JSON.stringify(out.steps));
  for (const name of ["manifest", "article", "human", "quote", "pay", "licence", "replay", "citation"]) {
    assert.equal(find(out.steps, name)?.level, "pass", `${name}: ${find(out.steps, name)?.detail}`);
  }
  assert.equal(out.paidAtomic, 6000n, "1000 read + 5000 citation");
  assert.equal(out.url, "http://localhost:8402/essays/on-stillness");
});

test("the path under test comes from the gate's manifest, not from a constant", async () => {
  const gate = fakeGate();
  const impl: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/.well-known/x402")) {
      return new Response(JSON.stringify({ ...MANIFEST, resources: { pathPrefixes: ["writing"] } }), { status: 200 });
    }
    return gate(input, init);
  };
  const out = await runSelftest(base({ fetchImpl: impl }));
  assert.equal(out.url, "http://localhost:8402/writing/on-stillness");
});

test("a tolled human is fatal and stops the run before any payment", async () => {
  const out = await runSelftest(base({ fetchImpl: fakeGate({ humanStatus: 402 }) }));
  assert.equal(out.ok, false);
  assert.equal(find(out.steps, "human")?.level, "fail");
  assert.equal(find(out.steps, "quote"), undefined, "nothing after the sacred invariant runs");
  assert.equal(out.paidAtomic, 0n);
});

test("a gate that lets the same payment through twice FAILS the replay step", async () => {
  const out = await runSelftest(base({ fetchImpl: fakeGate({ replayAllowed: true }) }));
  assert.equal(out.ok, false);
  assert.equal(find(out.steps, "replay")?.level, "fail");
  assert.match(find(out.steps, "replay")!.detail, /nonce was not consumed/);
});

test("a citation priced no higher than a read is a warning, not a pass", async () => {
  const out = await runSelftest(base({ fetchImpl: fakeGate({ citationAmount: "1000" }) }));
  assert.equal(find(out.steps, "citation")?.level, "warn");
  assert.equal(out.ok, true, "pricing policy is the operator's call — it does not fail the run");
});

test("a refused mock payment fails in mock mode", async () => {
  const out = await runSelftest(base({ fetchImpl: fakeGate({ payStatus: 500 }) }));
  assert.equal(out.ok, false);
  assert.equal(find(out.steps, "pay")?.level, "fail");
});

test("the same refusal against a GATEWAY gate is expected, not a failure", async () => {
  const env = ENV.replace("PAYMENT_MODE=mock", "PAYMENT_MODE=gateway");
  const out = await runSelftest(base({ envText: env, fetchImpl: fakeGate({ payStatus: 402 }) }));
  assert.equal(find(out.steps, "pay")?.level, "warn");
  assert.match(find(out.steps, "pay")!.detail, /gateway mode/);
  assert.equal(out.ok, true);
});

test("a paid read with no licence warns — the read still happened", async () => {
  const out = await runSelftest(base({ fetchImpl: fakeGate({ withLicence: false }) }));
  assert.equal(find(out.steps, "licence")?.level, "warn");
  assert.equal(out.ok, true);
});

test("an unreachable gate says so and names the command that starts it", async () => {
  const dead: typeof fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  const out = await runSelftest(base({ fetchImpl: dead }));
  assert.equal(out.ok, false);
  assert.equal(find(out.steps, "manifest")?.level, "fail");
  assert.match(find(out.steps, "manifest")!.detail, /make dev/);
});

test("API-mode credits cannot be enumerated, so the run asks for a slug instead of guessing", async () => {
  const env = `PAYMENT_MODE=mock\nCREDITS_API_URL=https://mysite.com/api/credits\n`;
  const out = await runSelftest(base({ envText: env }));
  assert.equal(out.ok, false);
  assert.equal(find(out.steps, "article")?.level, "fail");
  assert.match(find(out.steps, "article")!.detail, /--slug/);
});

test("an explicit --slug works in API mode, where nothing can be listed", async () => {
  const env = `PAYMENT_MODE=mock\nCREDITS_API_URL=https://mysite.com/api/credits\n`;
  const out = await runSelftest(base({ envText: env, slug: "chosen-one" }));
  assert.equal(out.url, "http://localhost:8402/essays/chosen-one");
  assert.equal(out.ok, true);
});

test("an empty credits file is a fail that names the command which fills it", async () => {
  const out = await runSelftest(base({ readFile: () => "{}" }));
  assert.equal(out.ok, false);
  assert.match(find(out.steps, "article")!.detail, /naulon crawl/);
});

test("the payer is stable across runs — a selftest never scatters one-off payers through the ledger", async () => {
  let seen: string | undefined;
  const gate = fakeGate();
  const impl: typeof fetch = async (input, init) => {
    const sig = new Headers(init?.headers).get("payment-signature");
    if (sig) seen = JSON.parse(Buffer.from(sig, "base64").toString("utf8")).payer;
    return gate(input, init);
  };
  await runSelftest(base({ fetchImpl: impl }));
  assert.equal(seen, SELFTEST_PAYER);
});

test("every paying request DECLARES itself an agent instead of impersonating a scraper UA", async () => {
  const seen: { ua: string | null; declared: string | null }[] = [];
  const gate = fakeGate();
  const impl: typeof fetch = async (input, init) => {
    if (!String(input).endsWith("/.well-known/x402")) {
      const h = new Headers(init?.headers);
      seen.push({ ua: h.get("user-agent"), declared: h.get("x-naulon-agent") });
    }
    return gate(input, init);
  };
  await runSelftest(base({ fetchImpl: impl }));
  const [human, ...machine] = seen;
  assert.match(human!.ua!, /^Mozilla\//, "the free-read probe is the only one that looks like a browser");
  assert.equal(human!.declared, null);
  assert.ok(machine.length >= 4);
  for (const r of machine) {
    assert.equal(r.declared, "naulon-selftest", "a machine request must declare intent");
    assert.doesNotMatch(r.ua!, /python-requests|curl|bot/i, "and must not pretend to be a known scraper");
  }
});

test("--no-citation stops after the read leg", async () => {
  const out = await runSelftest(base({ skipCitation: true }));
  assert.equal(find(out.steps, "citation"), undefined);
  assert.equal(out.paidAtomic, 1000n);
  assert.equal(out.ok, true);
});
