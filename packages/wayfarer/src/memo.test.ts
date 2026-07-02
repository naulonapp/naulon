/**
 * The memo buyer signs a raw USDC EIP-3009 authorization that the GATE must be able to
 * verify. This test proves that contract without crossing the package boundary: it
 * recovers the signer against the SAME shared descriptor (`usdcDomain` +
 * `TRANSFER_WITH_AUTHORIZATION_TYPES`) that the gate's `preverifyEip3009` recovers
 * against — so buyer and gate agree by construction, single-sourced in `@naulon/shared`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

// memo signing reads BUYER_PRIVATE_KEY + the active network from config — set a throwaway
// key (generated at runtime, never a real wallet) and the memo-capable network first.
const KEY = generatePrivateKey();
process.env.SETTLEMENT_NETWORK = "arcTestnet";
process.env.BUYER_PRIVATE_KEY = KEY;

const { activeNetwork, usdcDomain, TRANSFER_WITH_AUTHORIZATION_TYPES } = await import("@naulon/shared");
const { signMemoPayment } = await import("./memo.ts");

const payTo = "0x1111111111111111111111111111111111111111";
const net = activeNetwork();
const requirements = { network: net.network, asset: net.usdc, payTo, amount: "5000", maxTimeoutSeconds: 691200 };

test("memo buyer signs the leg's payTo + amount, as itself", async () => {
  const b64 = await signMemoPayment(requirements, 1_700_000_000_000);
  const { authorization } = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  assert.equal(authorization.to.toLowerCase(), payTo);
  assert.equal(authorization.value, "5000");
  assert.equal(authorization.from.toLowerCase(), privateKeyToAccount(KEY).address.toLowerCase());
  assert.equal(authorization.validBefore, String(1_700_000_000 + 691200));
});

test("the signature recovers against the shared descriptor the gate verifies with", async () => {
  const b64 = await signMemoPayment(requirements, 1_700_000_000_000);
  const { authorization, signature } = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  const recovered = await recoverTypedDataAddress({
    domain: usdcDomain(net),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
    signature,
  });
  assert.equal(recovered.toLowerCase(), authorization.from.toLowerCase());
});

test("each signature uses a fresh nonce (no replay)", async () => {
  const a = JSON.parse(Buffer.from(await signMemoPayment(requirements, 1_700_000_000_000), "base64").toString("utf8"));
  const b = JSON.parse(Buffer.from(await signMemoPayment(requirements, 1_700_000_000_000), "base64").toString("utf8"));
  assert.notEqual(a.authorization.nonce, b.authorization.nonce);
});

// An operator-fee (N-leg) toll: the gate advertises naulonLegs and rejects a payment
// that doesn't sign every leg. The memo buyer must sign one raw EIP-3009 authorization
// per leg and post the ARRAY — author leg to the author, operator leg to the operator.
test("memoBuyer signs one authorization per advertised leg into the array the gate parses", async () => {
  const { memoBuyer } = await import("./memo.ts");
  const OPERATOR = "0x3333333333333333333333333333333333333333";
  const header = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "https://x.test/a", description: "naulon read toll: A", mimeType: "text/html" },
      accepts: [{ network: net.network, asset: net.usdc, payTo, amount: "10000", maxTimeoutSeconds: 691200 }],
      extensions: {
        naulonLegs: {
          version: 1,
          settlement: "author-sync-rest-deferred",
          legs: [
            { role: "author", payTo, amount: "10000" },
            { role: "operator", payTo: OPERATOR, amount: "500" },
          ],
        },
      },
    }),
  ).toString("base64");

  const real = globalThis.fetch;
  let captured: string | undefined;
  globalThis.fetch = (async (_url: string, init?: { headers?: Record<string, string> }) => {
    const sig = init?.headers?.["payment-signature"];
    if (!sig) return new Response(null, { status: 402, headers: { "payment-required": header } });
    captured = sig;
    const parsed = JSON.parse(Buffer.from(sig, "base64").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return new Response(JSON.stringify({ error: "leg count" }), { status: 402 });
    return new Response("<html>origin</html>", { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    const result = await memoBuyer().fetch("https://x.test/a", "read");
    assert.equal(result.ok, true, "the fee'd resource must unlock");
    const payloads = JSON.parse(Buffer.from(captured!, "base64").toString("utf8"));
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].authorization.to.toLowerCase(), payTo);
    assert.equal(payloads[0].authorization.value, "10000");
    assert.equal(payloads[1].authorization.to.toLowerCase(), OPERATOR.toLowerCase());
    assert.equal(payloads[1].authorization.value, "500");
    // Independent EIP-3009 authorizations — distinct nonces, never an atomic multi-transfer.
    assert.notEqual(payloads[0].authorization.nonce, payloads[1].authorization.nonce);
  } finally {
    globalThis.fetch = real;
  }
});

// ── BUY-1.4 — validity stamped at pay time, floored to a margin ────────────────

test("a too-short gate window is floored to WAYFARER_MIN_VALIDITY_SECONDS (auth can't expire pre-relay)", async () => {
  const { resetConfig } = await import("@naulon/shared");
  const saved = process.env.WAYFARER_MIN_VALIDITY_SECONDS;
  process.env.WAYFARER_MIN_VALIDITY_SECONDS = "60";
  resetConfig();
  try {
    // The gate advertises a 5s window — far too short for an LLM to "think" then pay.
    const shortReq = { ...requirements, maxTimeoutSeconds: 5 };
    const b64 = await signMemoPayment(shortReq, 1_700_000_000_000);
    const { authorization } = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    assert.equal(authorization.validBefore, String(1_700_000_000 + 60), "the 5s window is widened to the 60s floor");

    // A window already longer than the floor is honored as-is (only widens, never shrinks).
    const longReq = { ...requirements, maxTimeoutSeconds: 691200 };
    const b64Long = await signMemoPayment(longReq, 1_700_000_000_000);
    const { authorization: longAuth } = JSON.parse(Buffer.from(b64Long, "base64").toString("utf8"));
    assert.equal(longAuth.validBefore, String(1_700_000_000 + 691200), "a generous gate window is left untouched");
  } finally {
    if (saved === undefined) delete process.env.WAYFARER_MIN_VALIDITY_SECONDS;
    else process.env.WAYFARER_MIN_VALIDITY_SECONDS = saved;
    resetConfig();
  }
});

// ── BUY-2 — injected MemoSigner seam (a cloud session key signs, not the env BUYER_PRIVATE_KEY) ──
// The cloud hosts the wallet: the MCP hands memoBuyer a MemoSigner that signs each leg elsewhere (a
// grant-checked BFF holding the encrypted session key). This proves the seam routes EVERY leg through
// the injected signer, signs as the session address (never the env key), and produces a signature the
// gate verifies against the SAME shared descriptor.
test("an injected MemoSigner signs every leg as itself; the env key is never used", async () => {
  const { memoBuyer } = await import("./memo.ts");
  type MemoSigner = import("./memo.ts").MemoSigner;
  // A DIFFERENT key than BUYER_PRIVATE_KEY, so a passing assertion proves the injected signer signed.
  const sessionKey = generatePrivateKey();
  const sessionAccount = privateKeyToAccount(sessionKey);
  assert.notEqual(sessionAccount.address.toLowerCase(), privateKeyToAccount(KEY).address.toLowerCase());
  let calls = 0;
  const signer: MemoSigner = {
    address: sessionAccount.address,
    signTypedData: (args) => {
      calls++;
      return sessionAccount.signTypedData(args);
    },
  };

  const OPERATOR = "0x3333333333333333333333333333333333333333";
  const header = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "https://x.test/a", description: "naulon read toll: A", mimeType: "text/html" },
      accepts: [{ network: net.network, asset: net.usdc, payTo, amount: "10000", maxTimeoutSeconds: 691200 }],
      extensions: {
        naulonLegs: {
          version: 1,
          settlement: "author-sync-rest-deferred",
          legs: [
            { role: "author", payTo, amount: "10000" },
            { role: "operator", payTo: OPERATOR, amount: "500" },
          ],
        },
      },
    }),
  ).toString("base64");

  const real = globalThis.fetch;
  let captured: string | undefined;
  globalThis.fetch = (async (_url: string, init?: { headers?: Record<string, string> }) => {
    const sig = init?.headers?.["payment-signature"];
    if (!sig) return new Response(null, { status: 402, headers: { "payment-required": header } });
    captured = sig;
    return new Response("<html>origin</html>", { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    const result = await memoBuyer(signer).fetch("https://x.test/a", "read");
    assert.equal(result.ok, true, "the fee'd resource must unlock via the injected signer");
    const payloads = JSON.parse(Buffer.from(captured!, "base64").toString("utf8"));
    assert.equal(payloads.length, 2, "one authorization per advertised leg");
    for (const p of payloads) {
      assert.equal(
        p.authorization.from.toLowerCase(),
        sessionAccount.address.toLowerCase(),
        "every leg is signed FROM the session address, not the env key",
      );
    }
    // A leg signature recovers to the session address against the shared descriptor the gate verifies.
    const recovered = await recoverTypedDataAddress({
      domain: usdcDomain(net),
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: payloads[0].authorization.from,
        to: payloads[0].authorization.to,
        value: BigInt(payloads[0].authorization.value),
        validAfter: BigInt(payloads[0].authorization.validAfter),
        validBefore: BigInt(payloads[0].authorization.validBefore),
        nonce: payloads[0].authorization.nonce,
      },
      signature: payloads[0].signature,
    });
    assert.equal(recovered.toLowerCase(), sessionAccount.address.toLowerCase());
    assert.equal(calls, 2, "the injected signer is invoked once per leg");
  } finally {
    globalThis.fetch = real;
  }
});
