/**
 * Signed statements about a work, by the issuer that reads works: "no open copy", "does not
 * resolve", and "this registry lists this notice".
 *
 * A statement attributes; it does not assert. It says "Crossref lists notice X for Y as of this
 * hour", never "Y is retracted", because the issuer read a registry and the registry is the
 * authority. Every statement is true as of the hour it names and says nothing about later.
 *
 * It is its own token type (`typ: naulon-statement+jwt`). `verifyLicense` pins `typ: JWT`, so a
 * statement can never pass as a licence, and this verifier pins its own `typ`, so a licence can
 * never pass as a statement.
 */
import { signCompact, verifyCompact } from "./jws.ts";
import type { JwkSet, SigningKey } from "./license.ts";

export const STATEMENT_TYP = "naulon-statement+jwt";

export type StatementSays = "no_open_copy" | "does_not_resolve" | "notice_listed";
export type NoticeType = "retraction" | "correction" | "concern" | "withdrawal";

export interface StatementBody {
  v: 1;
  /** The work key the statement is about: `doi:…`, `arxiv:…`. */
  about: string;
  says: StatementSays;
  /** Which index or registry the issuer read: `crossref`, `openalex`, `unpaywall`, `arxiv`. */
  source: string;
  /** Only on `notice_listed`: the notice's own DOI and type, as the registry gave them. */
  noticeDoi?: string;
  noticeType?: NoticeType;
  /** The hour the source was read, as `YYYY-MM-DDTHH:00:00Z`. */
  asOf: string;
}

export interface StatementClaims {
  iss: string;
  jti: string;
  iat: number;
  naulonStatement: StatementBody;
}

export type StatementInput = Omit<StatementClaims, "iat">;

const SAYS = new Set<string>(["no_open_copy", "does_not_resolve", "notice_listed"]);
const NOTICE_TYPES = new Set<string>(["retraction", "correction", "concern", "withdrawal"]);
const BODY_KEYS = new Set(["v", "about", "says", "source", "noticeDoi", "noticeType", "asOf"]);
const ON_THE_HOUR = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/;
const WORK_KEY = /^[a-z]+:\S{1,400}$/;
const DOI = /^10\.\d{4,9}(?:\.\d+)*\/\S{1,300}$/;

/** Why `b` is not a valid statement body, or null when it is. */
function bodyError(b: unknown): string | null {
  if (!b || typeof b !== "object" || Array.isArray(b)) return "statement body is not an object";
  const s = b as Record<string, unknown>;
  if (Object.keys(s).some((k) => !BODY_KEYS.has(k))) return "unknown statement field";
  if (s.v !== 1) return "unsupported statement version";
  if (typeof s.about !== "string" || !WORK_KEY.test(s.about)) return "about is not a work key";
  if (typeof s.says !== "string" || !SAYS.has(s.says)) return "unknown says";
  if (typeof s.source !== "string" || !/^[a-z][a-z0-9-]{1,31}$/.test(s.source)) return "bad source";
  if (typeof s.asOf !== "string" || !ON_THE_HOUR.test(s.asOf)) return "asOf is not an hour";
  const isNotice = s.says === "notice_listed";
  const hasNotice = s.noticeDoi !== undefined || s.noticeType !== undefined;
  if (!isNotice && hasNotice) return "notice fields on a statement that lists no notice";
  if (isNotice) {
    if (typeof s.noticeDoi !== "string" || !DOI.test(s.noticeDoi)) return "notice_listed needs the notice DOI";
    if (typeof s.noticeType !== "string" || !NOTICE_TYPES.has(s.noticeType)) return "notice_listed needs a notice type";
  }
  return null;
}

/** Sign a statement. Throws on a malformed one rather than signing something a verifier would refuse. */
export function mintStatement(input: StatementInput, key: SigningKey, now: number): string {
  const err = bodyError(input.naulonStatement);
  if (err) throw new Error(`mintStatement: ${err}`);
  if (typeof input.iss !== "string" || input.iss.length === 0) throw new Error("mintStatement: missing iss");
  if (typeof input.jti !== "string" || input.jti.length === 0) throw new Error("mintStatement: missing jti");
  const claims: StatementClaims = { iss: input.iss, jti: input.jti, iat: Math.floor(now / 1000), naulonStatement: input.naulonStatement };
  return signCompact(STATEMENT_TYP, claims, key);
}

export type StatementVerifyResult = { ok: true; claims: StatementClaims } | { ok: false; error: string };

/** Check a statement's signature, type, issuer and shape. It never expires: it states one hour. */
export function verifyStatement(jws: string, opts: { jwks: JwkSet; issuer: string }): StatementVerifyResult {
  const checked = verifyCompact(jws, STATEMENT_TYP, opts.jwks);
  if (!checked.ok) return checked;
  const c = checked.payload as Partial<StatementClaims> | null;
  if (!c || typeof c !== "object") return { ok: false, error: "undecodable payload" };
  if (c.iss !== opts.issuer) return { ok: false, error: "issuer mismatch" };
  if (typeof c.jti !== "string" || c.jti.length === 0) return { ok: false, error: "missing jti" };
  if (!Number.isSafeInteger(c.iat)) return { ok: false, error: "missing iat" };
  const err = bodyError(c.naulonStatement);
  if (err) return { ok: false, error: err };
  return { ok: true, claims: c as StatementClaims };
}
