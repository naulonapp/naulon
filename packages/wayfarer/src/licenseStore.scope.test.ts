/**
 * The buyer half of W8: a licence bought over a SCOPE has to be findable, and must not become a
 * skeleton key for every other publisher whose paths look similar.
 *
 * The store is keyed by slug, so before `findHeld` a scope licence was filed under a synthetic
 * key (`scope:/articles/*`) nobody would ever look up — unreachable the moment it was bought.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findHeld, type HeldLicense } from "./licenseStore.ts";

const AUD = "naulon:alice.demo.test";
const OTHER = "naulon:bob.demo.test";

function held(over: Partial<HeldLicense> = {}): HeldLicense {
  return {
    slug: "on-stillness",
    title: "On stillness",
    jti: "j-1",
    exp: 2_000,
    aud: AUD,
    pop: false,
    jws: "jws",
    ...over,
  };
}

const scoped = (patterns: string[], over: Partial<HeldLicense> = {}) =>
  held({ slug: `scope:${patterns.join(",")}`, jti: "j-scope", scope: { patterns }, ...over });

test("a scoped licence is found by PATH — the slug it is filed under matches nothing", () => {
  const store = [scoped(["/articles/*"])];
  assert.equal(
    findHeld(store, { slug: "on-stillness", path: "/articles/on-stillness", aud: AUD }, 1_000)?.jti,
    "j-scope",
  );
  // The old lookup — slug equality — is exactly what could never have found it.
  assert.equal(store[0]!.slug === "on-stillness", false);
});

test("a scoped licence does not cover a path outside its scope", () => {
  const store = [scoped(["/articles/*"])];
  assert.equal(findHeld(store, { slug: "x", path: "/notes/x", aud: AUD }, 1_000), null);
});

test("a scoped licence is refused for another publisher's gate — the same paths are everywhere", () => {
  const store = [scoped(["/articles/*"])];
  assert.equal(findHeld(store, { slug: "x", path: "/articles/x", aud: OTHER }, 1_000), null);
});

test("a scoped licence is refused when the caller cannot name the gate (fails closed)", () => {
  const store = [scoped(["/articles/*"])];
  assert.equal(findHeld(store, { slug: "x", path: "/articles/x" }, 1_000), null);
});

test("an unscoped licence matches by slug, but only at the gate that minted it", () => {
  const store = [held()];
  assert.equal(findHeld(store, { slug: "on-stillness", aud: AUD }, 1_000)?.jti, "j-1");
  assert.equal(findHeld(store, { slug: "other", aud: AUD }, 1_000), null);
});

test("an unscoped licence is NOT reused for a same-slug article on another site", () => {
  // Two independently-run publishers share a generic slug — `faq`, `about`, `introduction`. The
  // slug-only match marked it licensed, and the re-read then fetched the licence's OWN paid url,
  // so the agent cited site A's bytes under site B's title, free and silently. The selling gate
  // never saw anything wrong, because the token was only ever presented to the site that minted it.
  const store = [held({ slug: "faq" })];
  assert.equal(findHeld(store, { slug: "faq", aud: AUD }, 1_000)?.jti, "j-1");
  assert.equal(findHeld(store, { slug: "faq", aud: OTHER }, 1_000), null);
});

test("a licence is not used by a caller that cannot name the gate — scoped or not", () => {
  assert.equal(findHeld([held()], { slug: "on-stillness" }, 1_000), null);
});

test("expiry is honoured for both shapes", () => {
  assert.equal(findHeld([held()], { slug: "on-stillness" }, 3_000), null);
  assert.equal(
    findHeld([scoped(["/articles/*"])], { slug: "x", path: "/articles/x", aud: AUD }, 3_000),
    null,
  );
});

test("the exact-slug licence outranks a scope that also covers the path", () => {
  const store = [scoped(["/articles/*"]), held({ jti: "j-exact" })];
  assert.equal(
    findHeld(store, { slug: "on-stillness", path: "/articles/on-stillness", aud: AUD }, 1_000)?.jti,
    "j-exact",
  );
});

test("the narrower scope wins over the wider one — longest literal run, as RFC 9309 orders", () => {
  const store = [
    scoped(["/*"], { jti: "j-wide" }),
    scoped(["/articles/2026/*"], { jti: "j-narrow" }),
    scoped(["/articles/*"], { jti: "j-mid" }),
  ];
  assert.equal(
    findHeld(store, { slug: "x", path: "/articles/2026/x", aud: AUD }, 1_000)?.jti,
    "j-narrow",
  );
});

test("a scope with no patterns covers nothing", () => {
  assert.equal(findHeld([scoped([])], { slug: "x", path: "/articles/x", aud: AUD }, 1_000), null);
});

test("a publisher who overrode LICENSE_ISSUER misses, and pays again — the accepted cost", () => {
  // `licenseIdentity` is `LICENSE_ISSUER ?? naulon:${host}`, and the agent derives the latter. On
  // such a deployment a held licence no longer matches, so the agent pays a second time. That is
  // the deliberate trade: an extra charge is bounded and visible; citing the wrong publisher's
  // bytes is neither. Asserted so the cost is a decision on record rather than a surprise.
  const store = [held({ aud: "https://custom-issuer.example" })];
  assert.equal(findHeld(store, { slug: "on-stillness", aud: AUD }, 1_000), null);
});
