// The identity cases every runtime must agree on. The PHP plugin's suite reads the same file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileRanges, CRAWLER_PROOF, type CrawlerRangesDocument, type IdentityCheck } from "@naulon/shared";
import { classifyWithIdentity } from "./identity.ts";
import type { VerifiedAgent } from "./botAuth.ts";

interface Case {
  name: string;
  runtimes: string[];
  ua: string;
  accept: string;
  headers?: Record<string, string>;
  signedBy?: string;
  clientIp: string | null;
  ranges: { operators: { id: string; prefixes: string[]; fetchedAgoHours: number | null; forgedEligible?: boolean }[] } | null;
  armed: string[];
  mode: "auto" | "off";
  allow: string[];
  charge?: string[];
  expect: { kind: "human" | "agent"; identityCheck: IdentityCheck | null; forged?: boolean };
}

const NOW = Date.UTC(2026, 9, 1);
const path = fileURLToPath(new URL("../../shared/test-fixtures/identity-cases.json", import.meta.url));
const fixture = JSON.parse(readFileSync(path, "utf8")) as {
  operators: { id: string; operator: string; fragments: string[]; kind: string; forgedEligible: boolean }[];
  cases: Case[];
};
const cases = fixture.cases;

// The PHP runtime has no CRAWLER_PROOF to import, so it reads this copy. It must never drift.
test("fixture operators mirror CRAWLER_PROOF", () => {
  assert.deepEqual(
    fixture.operators,
    CRAWLER_PROOF.map((r) => ({ id: r.id, operator: r.operator, fragments: [...r.fragments], kind: r.kind, forgedEligible: r.forgedEligible })),
  );
});

function docFor(c: Case): CrawlerRangesDocument | null {
  if (!c.ranges) return null;
  const over = new Map(c.ranges.operators.map((o) => [o.id, o]));
  return {
    version: 1,
    generatedAt: new Date(NOW).toISOString(),
    proxies: { cloudflare: ["173.245.48.0/20"] },
    sources: [],
    operators: CRAWLER_PROOF.map((r) => {
      const o = over.get(r.id);
      return {
        id: r.id,
        operator: r.operator,
        fragments: [...r.fragments],
        kind: r.kind,
        forgedEligible: o?.forgedEligible ?? r.forgedEligible,
        fetchedAt: o && o.fetchedAgoHours !== null ? new Date(NOW - o.fetchedAgoHours * 3_600_000).toISOString() : null,
        prefixes: o?.prefixes ?? [],
      };
    }),
  };
}

const signed = (agent: string): VerifiedAgent => ({ agent, keyid: "k", covers: ["@authority"] }) as VerifiedAgent;

for (const c of cases.filter((x) => x.runtimes.includes("ts"))) {
  test(`fixture: ${c.name}`, () => {
    const doc = docFor(c);
    const out = classifyWithIdentity(
      {
        userAgent: c.ua,
        hasPaymentHeader: false,
        declaredAgentId: null,
        accept: c.accept,
        headers: c.headers ?? {},
        ...(c.signedBy ? { verifiedAgent: signed(c.signedBy) } : {}),
      },
      { seoAllowlist: c.allow, ...(c.charge ? { chargeList: c.charge } : {}) },
      c.mode,
      { ranges: doc ? compileRanges(doc) : null, clientIp: c.clientIp, now: NOW, isArmed: (op) => c.armed.includes(op) },
    );
    assert.equal(out.verdict.kind, c.expect.kind);
    assert.equal(out.identity?.check ?? null, c.expect.identityCheck);
    assert.equal(out.verdict.identity === "forged", c.expect.forged ?? false);
  });
}
