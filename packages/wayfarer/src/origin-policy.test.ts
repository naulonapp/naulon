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

// ── allowlist: the ONE way to widen ──────────────────────────────────────────

test("an allowlisted host is authorized even though it is not the gate", () => {
  ok(authorizeOrigin({ target: "https://inneraxiom.com/articles/x", gate: GATE, allowDomains: ["inneraxiom.com"] }));
});

test("an allowlist still refuses a host that is not on it", () => {
  assert.match(
    refusal(authorizeOrigin({ target: "https://evil.example/x", gate: GATE, allowDomains: ["inneraxiom.com"] })),
    /evil\.example/,
  );
});

test("setting an allowlist does not silently drop the gate itself", () => {
  ok(authorizeOrigin({ target: `${GATE}/x`, gate: GATE, allowDomains: ["inneraxiom.com"] }));
});

test("the allowlist matches HOSTNAME, ignoring port — it names domains, not endpoints", () => {
  // decide.ts:103-104: "an allow/deny list names domains ('evil.example'), never host:port".
  ok(authorizeOrigin({ target: "https://inneraxiom.com:8443/x", gate: GATE, allowDomains: ["inneraxiom.com"] }));
});

test("allowlist entries are matched case-insensitively", () => {
  ok(authorizeOrigin({ target: "https://InnerAxiom.com/x", gate: GATE, allowDomains: ["INNERAXIOM.COM"] }));
});

test("an allowlist entry does NOT imply its subdomains", () => {
  assert.match(
    refusal(authorizeOrigin({ target: "https://evil.inneraxiom.com/x", gate: GATE, allowDomains: ["inneraxiom.com"] })),
    /evil\.inneraxiom\.com/,
  );
});

test("an EMPTY allowlist fails closed — it is not read as 'no policy'", () => {
  // The dangerous misreading: `allowDomains: []` meaning "unrestricted". An operator who
  // computed an empty tenant set must get refusals, not an open wallet.
  assert.match(refusal(authorizeOrigin({ target: "https://inneraxiom.com/x", gate: GATE, allowDomains: [] })), /inneraxiom\.com/);
});

test("with an empty allowlist the gate itself is still authorized", () => {
  ok(authorizeOrigin({ target: `${GATE}/x`, gate: GATE, allowDomains: [] }));
});

// ── no gate configured ───────────────────────────────────────────────────────

test("with no gate and no allowlist, everything is refused — fail closed", () => {
  assert.match(refusal(authorizeOrigin({ target: "https://anything.example/x" })), /no configured gate/);
});

test("with no gate, an allowlisted host is still authorized", () => {
  // The hosted fleet case: the cloud names its tenant set and has no single gate.
  ok(authorizeOrigin({ target: "https://inneraxiom.com/x", allowDomains: ["inneraxiom.com"] }));
});
