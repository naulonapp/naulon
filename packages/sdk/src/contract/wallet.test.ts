import { test } from "node:test";
import assert from "node:assert/strict";

import { BURN_ADDRESS, isBurnAddress, payeeWalletSchema, walletSchema, walletAddress } from "./wallet.ts";
import { parseCredits } from "./credits.ts";

const REAL = "0x1111111111111111111111111111111111111111";

/**
 * Two rules, deliberately not one. The burn address has to stay VALID as a plain address, because
 * x402 uses it as the "payer unknown" sentinel and `tollgate/src/settle.ts` brands it on every
 * settle it cannot attribute. It has to be INVALID as a payee, because a transfer to it succeeds
 * and destroys the money.
 */
test("the format rule still accepts the burn address — the x402 payer sentinel depends on it", () => {
  assert.equal(walletSchema.safeParse(BURN_ADDRESS).success, true);
  assert.equal(walletAddress(BURN_ADDRESS), BURN_ADDRESS);
});

test("the payee rule refuses it, and says why in words a publisher can act on", () => {
  const res = payeeWalletSchema.safeParse(BURN_ADDRESS);
  assert.equal(res.success, false);
  assert.match(res.error!.issues[0]!.message, /burn address/);
});

test("…in any casing — 0x0…0 has no checksum to hide behind", () => {
  assert.equal(isBurnAddress("0x0000000000000000000000000000000000000000"), true);
  assert.equal(isBurnAddress("  0X0000000000000000000000000000000000000000  "), true);
  assert.equal(isBurnAddress(REAL), false);
});

test("a real address passes both", () => {
  assert.equal(walletSchema.safeParse(REAL).success, true);
  assert.equal(payeeWalletSchema.safeParse(REAL).success, true);
});

test("credits naming the burn address do not parse — the same answer a malformed one gets", () => {
  assert.throws(
    () =>
      parseCredits(
        { slug: "s", title: "t", contributors: [{ authorId: "a", wallet: BURN_ADDRESS }] },
        "test",
      ),
    /burn address/,
  );
});

test("a burn co-author sinks the whole body, rather than being silently paid", () => {
  assert.throws(
    () =>
      parseCredits(
        {
          slug: "s",
          title: "t",
          contributors: [
            { authorId: "a", wallet: REAL, weight: 3 },
            { authorId: "b", wallet: BURN_ADDRESS, weight: 1 },
          ],
        },
        "test",
      ),
    /burn address/,
  );
});

test("and inside a composite, where it is easiest to miss", () => {
  assert.throws(
    () =>
      parseCredits(
        {
          slug: "s",
          title: "t",
          contributors: [{ authorId: "group", members: [{ authorId: "b", wallet: BURN_ADDRESS }] }],
        },
        "test",
      ),
    /burn address/,
  );
});
