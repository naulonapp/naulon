/**
 * What a reader saw when it read a document it did not buy: which copy, the bytes it got, the text it
 * extracted, and the rights stated on that copy at that hour.
 *
 * It rides on the event row because a citation record is replayed from the row, so the record can
 * state it permanently and two fetches of one record stay byte-identical.
 */
export interface ReadAttestation {
  v: 1;
  /** The work the read was for, as a scheme-prefixed key: `doi:10.1093/nar/gkab1112`, `arxiv:1706.03762`. */
  work: string;
  /** The copy the reader was pointed at. */
  copyUrl: string;
  /** Where the last redirect landed. */
  finalUrl: string;
  /** SHA-256 hex of the bytes as fetched. */
  bodySha256: string;
  /** SHA-256 hex of the normalized extracted text. */
  textSha256: string;
  /** Merkle root over the sentence leaves of that text (`@naulon/extract`). */
  textRoot: string;
  /** How many sentence leaves the root covers. A quote proof needs it. */
  leaves: number;
  /** `@naulon/extract@<version>`: the version pins normalization and sentence segmentation. */
  extractor: string;
  /** The licence statement on the copy, as its source gave it. Null when none was stated. */
  licenceRaw: string | null;
  /** The version of the licence rules that classified the copy. */
  ladder: number;
  /** Truncated to the hour, so a record cannot be matched to a payment by its timestamp. */
  fetchedAt: string;
  /** Characters of invisible text (white, under 1pt, off-page) dropped before extraction. */
  dropped?: number;
}

const HEX64 = /^[0-9a-f]{64}$/;
const ON_THE_HOUR = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/;
const WORK_KEY = /^[a-z]+:\S{1,400}$/;
const EXTRACTOR = /^@naulon\/extract@\d+\.\d+\.\d+$/;
const KEYS = new Set([
  "v", "work", "copyUrl", "finalUrl", "bodySha256", "textSha256", "textRoot", "leaves",
  "extractor", "licenceRaw", "ladder", "fetchedAt", "dropped",
]);

function isHttpsUrl(s: unknown): s is string {
  if (typeof s !== "string" || s.length > 2048) return false;
  try {
    return new URL(s).protocol === "https:";
  } catch {
    return false;
  }
}

const isCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const isHex64 = (s: unknown): s is string => typeof s === "string" && HEX64.test(s);

/** The attestation, or null when `x` is not exactly a v1 attestation. A field is never repaired. */
export function parseReadAttestation(x: unknown): ReadAttestation | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const a = x as Record<string, unknown>;
  if (Object.keys(a).some((k) => !KEYS.has(k))) return null;
  if (a.v !== 1) return null;
  if (typeof a.work !== "string" || !WORK_KEY.test(a.work)) return null;
  if (!isHttpsUrl(a.copyUrl) || !isHttpsUrl(a.finalUrl)) return null;
  if (!isHex64(a.bodySha256) || !isHex64(a.textSha256) || !isHex64(a.textRoot)) return null;
  if (!isCount(a.leaves) || !isCount(a.ladder)) return null;
  if (typeof a.extractor !== "string" || !EXTRACTOR.test(a.extractor)) return null;
  if (a.licenceRaw !== null && (typeof a.licenceRaw !== "string" || a.licenceRaw.length > 300)) return null;
  if (typeof a.fetchedAt !== "string" || !ON_THE_HOUR.test(a.fetchedAt)) return null;
  if (a.dropped !== undefined && !isCount(a.dropped)) return null;
  return a as unknown as ReadAttestation;
}
