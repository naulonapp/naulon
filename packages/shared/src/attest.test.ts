import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReadAttestation, type ReadAttestation } from "./attest.ts";

const ATTEST: ReadAttestation = {
  v: 1,
  work: "doi:10.1093/nar/gkab1112",
  copyUrl: "https://academic.oup.com/nar/article/50/D1/D439/6430488",
  finalUrl: "https://academic.oup.com/nar/article/50/D1/D439/6430488",
  bodySha256: "a".repeat(64),
  textSha256: "b".repeat(64),
  textRoot: "c".repeat(64),
  leaves: 412,
  extractor: "@naulon/extract@0.2.0",
  licenceRaw: "https://creativecommons.org/licenses/by/4.0/",
  ladder: 2,
  fetchedAt: "2026-10-14T09:00:00Z",
};

test("a well-formed attestation parses, and fetchedAt must sit on the hour", () => {
  assert.deepEqual(parseReadAttestation(ATTEST), ATTEST);
  assert.deepEqual(parseReadAttestation({ ...ATTEST, dropped: 120, licenceRaw: null }), { ...ATTEST, dropped: 120, licenceRaw: null });
  assert.equal(parseReadAttestation({ ...ATTEST, fetchedAt: "2026-10-14T09:13:00Z" }), null);
});

test("anything malformed is refused, never repaired", () => {
  const bad: unknown[] = [
    null,
    [],
    {},
    { ...ATTEST, v: 2 },
    { ...ATTEST, work: "10.1093/nar/gkab1112" },
    { ...ATTEST, bodySha256: "xyz" },
    { ...ATTEST, textRoot: "C".repeat(64) },
    { ...ATTEST, leaves: -1 },
    { ...ATTEST, leaves: 1.5 },
    { ...ATTEST, copyUrl: "http://x.org/a" },
    { ...ATTEST, finalUrl: "not a url" },
    { ...ATTEST, extractor: "" },
    { ...ATTEST, extractor: "@naulon/extract@latest" },
    { ...ATTEST, licenceRaw: "x".repeat(301) },
    { ...ATTEST, dropped: -3 },
    { ...ATTEST, extra: 1 },
  ];
  for (const b of bad) assert.equal(parseReadAttestation(b), null, JSON.stringify(b));
});
