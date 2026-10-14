import assert from "node:assert/strict";
import { test } from "node:test";
import { jwksOf, loadSigningKey, verifyLicense } from "./license.ts";
import { mintStatement, verifyStatement, type StatementInput } from "./statement.ts";

const KEY = loadSigningKey();
const JWKS = jwksOf([KEY]);
const ISS = "naulon:papers.example";
const NOW = Date.parse("2026-10-14T09:30:00Z");

const notice: StatementInput = {
  iss: ISS,
  jti: "st_1",
  naulonStatement: {
    v: 1,
    about: "doi:10.1016/s0140-6736(97)11096-0",
    says: "notice_listed",
    source: "crossref",
    noticeDoi: "10.1016/s0140-6736(04)15715-2",
    noticeType: "retraction",
    asOf: "2026-10-14T09:00:00Z",
  },
};

test("a statement verifies against the issuer's keys and says exactly what it attributes", () => {
  const r = verifyStatement(mintStatement(notice, KEY, NOW), { jwks: JWKS, issuer: ISS });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.claims.naulonStatement, notice.naulonStatement);
  assert.equal(r.claims.iat, Math.floor(NOW / 1000));
});

test("the negatives carry no notice fields", () => {
  for (const says of ["no_open_copy", "does_not_resolve"] as const) {
    const input: StatementInput = { iss: ISS, jti: `st_${says}`, naulonStatement: { v: 1, about: "arxiv:1706.03762", says, source: "openalex", asOf: "2026-10-14T09:00:00Z" } };
    const r = verifyStatement(mintStatement(input, KEY, NOW), { jwks: JWKS, issuer: ISS });
    assert.ok(r.ok, says);
    assert.throws(() => mintStatement({ ...input, naulonStatement: { ...input.naulonStatement, noticeDoi: "10.1/x" } }, KEY, NOW), says);
  }
});

test("a statement is never accepted as a licence, and the wrong issuer is refused", () => {
  const st = mintStatement(notice, KEY, NOW);
  const asLicence = verifyLicense(st, { now: NOW, expectedIssuer: ISS, expectedAudience: ISS, jwks: JWKS });
  assert.deepEqual(asLicence, { ok: false, error: "unexpected typ" });
  assert.deepEqual(verifyStatement(st, { jwks: JWKS, issuer: "naulon:other" }), { ok: false, error: "issuer mismatch" });
});

test("a licence is never accepted as a statement", () => {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: KEY.kid })).toString("base64url");
  const forged = `${header}.${mintStatement(notice, KEY, NOW).split(".").slice(1).join(".")}`;
  assert.equal(verifyStatement(forged, { jwks: JWKS, issuer: ISS }).ok, false);
});

test("malformed statements are refused at mint, and a tampered payload at verify", () => {
  const bad = (patch: Record<string, unknown>) => ({ ...notice, naulonStatement: { ...notice.naulonStatement, ...patch } }) as StatementInput;
  for (const patch of [{ asOf: "2026-10-14T09:31:00Z" }, { says: "retracted" }, { about: "10.1/x" }, { noticeDoi: undefined }, { noticeType: "erratum" }, { source: "" }]) {
    assert.throws(() => mintStatement(bad(patch), KEY, NOW), JSON.stringify(patch));
  }
  const [h, , s] = mintStatement(notice, KEY, NOW).split(".");
  const evil = Buffer.from(JSON.stringify({ ...notice, iat: 1, naulonStatement: { ...notice.naulonStatement, says: "no_open_copy" } })).toString("base64url");
  assert.deepEqual(verifyStatement(`${h}.${evil}.${s}`, { jwks: JWKS, issuer: ISS }), { ok: false, error: "invalid signature" });
});
