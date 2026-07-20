/**
 * The ONE origin decision — "may money touch this URL?" — and the brand that makes
 * skipping it a compile error rather than a code-review habit.
 *
 * Written before the implementation. The invariant these tests defend is the one
 * decide.ts:245-248 could only ask for in prose: there is exactly one way to express
 * "which hosts may I pay", so a second surface cannot drift from the first.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { authorizeOrigin } from "./origin-policy.ts";

const GATE = "https://gate.example";

/** Unwrap an expected-ok verdict, failing loudly with the refusal when it is not. */
function ok(v: ReturnType<typeof authorizeOrigin>): string {
  assert.equal(v.ok, true, v.ok ? "" : `expected authorized, got refusal: ${v.refusal}`);
  return (v as { ok: true; target: string }).target;
}

/** Unwrap an expected-refusal verdict. */
function refusal(v: ReturnType<typeof authorizeOrigin>): string {
  assert.equal(v.ok, false, "expected a refusal, got an authorized target");
  return (v as { ok: false; refusal: string }).refusal;
}

// ── default posture: pin to the configured gate ──────────────────────────────

test("with no allowlist, the configured gate is authorized", () => {
  const target = ok(authorizeOrigin({ target: `${GATE}/essays/x`, gate: GATE }));
  assert.equal(target, `${GATE}/essays/x`, "the authorized target is returned verbatim");
});

test("with no allowlist, an off-gate host is refused", () => {
  assert.match(refusal(authorizeOrigin({ target: "https://evil.example/essays/x", gate: GATE })), /refusing to touch evil\.example/);
});

test("endpoint identity includes the port — a differing port is refused", () => {
  assert.match(
    refusal(authorizeOrigin({ target: "https://gate.example:8443/x", gate: GATE })),
    /refusing to touch gate\.example:8443/,
  );
});

test("host comparison is case-insensitive", () => {
  ok(authorizeOrigin({ target: "https://GATE.EXAMPLE/x", gate: GATE }));
});

test("a subdomain of the gate is not implied by the gate", () => {
  assert.match(refusal(authorizeOrigin({ target: "https://sub.gate.example/x", gate: GATE })), /refusing to touch sub\.gate\.example/);
});

// ── malformed input ──────────────────────────────────────────────────────────

test("a malformed target is refused as invalid, distinctly from off-gate", () => {
  const r = refusal(authorizeOrigin({ target: "not-a-url", gate: GATE }));
  assert.match(r, /"not-a-url" is not a valid URL\./);
  assert.doesNotMatch(r, /refusing to touch/);
});

test("an unparseable gate names the config key to fix", () => {
  assert.match(refusal(authorizeOrigin({ target: `${GATE}/x`, gate: "://broken" })), /is not a valid URL — fix TOLLGATE_URL/);
});

// ── a stated allowlist replaces the pin and defers to spendGate ──────────────
//
// These assert a DEFERRAL, not an approval. `authorizeOrigin` deciding which domains are
// payable would be a second copy of spendGate's job — the divergence this module exists
// to end. So once an allowlist is stated, identity steps aside; spendGate's own tests
// (decide.test.ts) cover which hosts actually get paid.

test("a stated allowlist defers off-gate identity to spendGate", () => {
  ok(authorizeOrigin({ target: "https://inneraxiom.com/articles/x", gate: GATE, allowDomains: ["inneraxiom.com"] }));
});

test("deferral is not adjudication — an off-list host also passes identity", () => {
  // spendGate refuses this one. If authorizeOrigin refused it too, the allow/deny rules
  // would exist twice and could drift; that is precisely what happened before.
  ok(authorizeOrigin({ target: "https://evil.example/x", gate: GATE, allowDomains: ["inneraxiom.com"] }));
});

test("setting an allowlist does not silently drop the gate itself", () => {
  ok(authorizeOrigin({ target: `${GATE}/x`, gate: GATE, allowDomains: ["inneraxiom.com"] }));
});

test("an EMPTY allowlist is a stated boundary, and defers like any other", () => {
  // `![]` is false, so an empty array already bypassed the pin before this refactor.
  // Deferring preserves that exactly — and spendGate reads an empty allowlist as
  // deny-by-default, so nothing becomes payable that was not payable before.
  ok(authorizeOrigin({ target: "https://inneraxiom.com/x", gate: GATE, allowDomains: [] }));
});

test("an invalid target is still rejected even when an allowlist is stated", () => {
  // Deferral applies to identity, never to parseability — spendGate is handed a host, so
  // an unparseable target must die here rather than arrive as `undefined`.
  assert.match(refusal(authorizeOrigin({ target: "nope", gate: GATE, allowDomains: ["x.example"] })), /not a valid URL/);
});

// ── no gate configured ───────────────────────────────────────────────────────

test("with no gate and no allowlist, identity defers — there is no boundary to apply", () => {
  // Deliberately NOT a refusal. The deny-list and per-domain-cap paths run with no
  // gateBase and rely on spendGate alone; refusing here would break them while only
  // LOOKING safer. Requiring a gate when buying is enabled is a config-time check —
  // the process should fail to boot, not fail per-candidate at pay time.
  ok(authorizeOrigin({ target: "https://anything.example/x" }));
});

test("with no gate, a stated allowlist is the whole boundary", () => {
  // The hosted fleet case: the cloud names its tenant set and has no single gate.
  ok(authorizeOrigin({ target: "https://inneraxiom.com/x", allowDomains: ["inneraxiom.com"] }));
});
