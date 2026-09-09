/**
 * The mirror tripwire for `GATEWAY_AUTH_VALIDITY_WINDOW_SEC`.
 *
 * `@naulon/shared` carries that number by hand so `networks.ts` stays free of an eager
 * `@circle-fin/x402-batching` import (the SDK is loaded lazily by `buildGatewaySignature`, and a
 * top-level re-export would make every consumer of shared pay for it). A hand-copied constant from
 * a dependency is exactly the thing that goes stale on a bump and is trusted anyway, so this test
 * imports the SDK — which a test may do freely — and asserts the two still agree.
 *
 * It lives in tollgate rather than shared because tollgate is the package that already depends on
 * the SDK; shared does not, and adding the dependency there just to test it would defeat the point.
 *
 * If this fails after an SDK bump, the fix is to update the shared constant to the SDK's value and
 * re-read what changed: the window is a settlement-rail parameter, so it is a `/rail-review`
 * surface, not a number to nudge until the test passes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { GATEWAY_AUTH_VALIDITY_WINDOW_SEC } from "@naulon/shared";

test("the mirrored Gateway validity window still equals the installed SDK's", async () => {
  const sdk = await import("@circle-fin/x402-batching");
  const fromSdk = (sdk as unknown as { GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS?: number })
    .GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS;

  // A missing export is a FAILURE, not a skip. The whole value of this test is that it reads the
  // real number; passing because it could not find one is the silent-green shape the repo's other
  // tripwires are written to avoid.
  assert.equal(
    typeof fromSdk,
    "number",
    "the SDK no longer exports GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS — the mirror has nothing to check itself against",
  );
  assert.equal(
    GATEWAY_AUTH_VALIDITY_WINDOW_SEC,
    fromSdk,
    "@naulon/shared's mirrored validity window has drifted from the installed SDK",
  );
});

test("the window is a 7-day floor plus the SDK's buffer, and nothing shorter", async () => {
  // Stated independently of the SDK so a bump that SHORTENS the window is visible as a decision
  // rather than absorbed silently: a shorter window would make `validBefore` bounds written against
  // 7 days start refusing authorizations the rail would have settled.
  assert.equal(GATEWAY_AUTH_VALIDITY_WINDOW_SEC, 604_900);
  assert.ok(GATEWAY_AUTH_VALIDITY_WINDOW_SEC >= 7 * 24 * 60 * 60, "never below Circle's 7-day minimum");
});
