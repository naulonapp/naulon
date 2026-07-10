/**
 * Web Bot Auth — RFC 9421 HTTP Message Signatures verifier, scoped to the
 * web-bot-auth profile (draft-meunier-webbotauth-httpsig-protocol-00 +
 * Cloudflare's deployed operational profile).
 *
 * Hand-rolled minimal structured-field subset by design: the full RFC 8941
 * grammar is far more than the three headers need, and the one candidate npm
 * package (web-bot-auth@0.1.x) is a 4-package unaudited tree. This module is
 * self-contained on node:crypto.
 */

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { isIP } from "node:net";

/** One covered component in the signature input: a name plus optional ;key=. */
export interface CoveredComponent {
  name: string;
  key?: string;
  /**
   * The component identifier exactly as the signer serialized it (quoted name
   * + params). Base lines reuse it verbatim so the base is byte-exact.
   */
  raw: string;
}

export interface SignatureInputEntry {
  label: string;
  components: CoveredComponent[];
  params: {
    created?: number;
    expires?: number;
    keyid?: string;
    tag?: string;
    alg?: string;
    nonce?: string;
  };
  /**
   * The member's verbatim SF text (everything after `label=`). Reused as the
   * `@signature-params` serialization so the base is byte-exact with what the
   * signer signed — no canonical re-serialization bugs.
   */
  rawMemberText: string;
}

/* ------------------------------------------------------------------ *
 * Minimal RFC 8941 structured-field tokenizer — just the productions
 * the three web-bot-auth headers use.
 * ------------------------------------------------------------------ */

class Cursor {
  i = 0;
  constructor(readonly s: string) {}
  eof(): boolean {
    return this.i >= this.s.length;
  }
  peek(): string {
    return this.s[this.i] ?? "";
  }
  skipSp(): void {
    while (this.s[this.i] === " " || this.s[this.i] === "\t") this.i++;
  }
}

/** sf-key: lcalpha/'*' then lcalpha DIGIT '_' '-' '.' '*'. */
function parseKey(c: Cursor): string | null {
  const start = c.i;
  if (!/[a-z*]/.test(c.peek())) return null;
  c.i++;
  while (/[a-z0-9_\-.*]/.test(c.peek())) c.i++;
  return c.s.slice(start, c.i);
}

/** sf-string: DQUOTE with \\ and \" escapes. */
function parseQuotedString(c: Cursor): string | null {
  if (c.peek() !== '"') return null;
  c.i++;
  let out = "";
  while (!c.eof()) {
    const ch = c.peek();
    if (ch === '"') {
      c.i++;
      return out;
    }
    if (ch === "\\") {
      c.i++;
      const esc = c.peek();
      if (esc !== '"' && esc !== "\\") return null;
      out += esc;
      c.i++;
      continue;
    }
    out += ch;
    c.i++;
  }
  return null; // unterminated
}

type BareItem = string | number | boolean;

/** Bare item: sf-string | sf-integer | sf-boolean | sf-token (as string). */
function parseBareItem(c: Cursor): BareItem | null {
  const ch = c.peek();
  if (ch === '"') return parseQuotedString(c);
  if (ch === "?") {
    c.i++;
    const b = c.peek();
    if (b !== "0" && b !== "1") return null;
    c.i++;
    return b === "1";
  }
  if (/[\-0-9]/.test(ch)) {
    const start = c.i;
    if (ch === "-") c.i++;
    while (/[0-9]/.test(c.peek())) c.i++;
    const text = c.s.slice(start, c.i);
    if (!/[0-9]/.test(text[text.length - 1] ?? "")) return null;
    return Number(text);
  }
  if (/[A-Za-z*]/.test(ch)) {
    const start = c.i;
    c.i++;
    while (/[A-Za-z0-9!#$%&'*+\-.^_`|~:/]/.test(c.peek())) c.i++;
    return c.s.slice(start, c.i);
  }
  return null;
}

/** parameters: *( ";" OWS key [ "=" bare-item ] ). */
function parseParams(c: Cursor): Record<string, BareItem> | null {
  const out: Record<string, BareItem> = {};
  while (c.peek() === ";") {
    c.i++;
    c.skipSp();
    const key = parseKey(c);
    if (key === null) return null;
    if (c.peek() === "=") {
      c.i++;
      const v = parseBareItem(c);
      if (v === null) return null;
      out[key] = v;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function asString(v: BareItem | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asInt(v: BareItem | undefined): number | undefined {
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

/**
 * Parse a `Signature-Input` header: an SF dictionary whose members are inner
 * lists of covered components followed by the signature params. Returns null
 * on any grammar trouble — the caller treats that as an invalid signature.
 */
export function parseSignatureInput(value: string): SignatureInputEntry[] | null {
  const c = new Cursor(value);
  const entries: SignatureInputEntry[] = [];
  c.skipSp();
  if (c.eof()) return null;
  for (;;) {
    const label = parseKey(c);
    if (label === null || c.peek() !== "=") return null;
    c.i++;
    const memberStart = c.i;
    if (c.peek() !== "(") return null;
    c.i++;
    const components: CoveredComponent[] = [];
    for (;;) {
      c.skipSp();
      if (c.peek() === ")") {
        c.i++;
        break;
      }
      if (c.eof()) return null;
      const compStart = c.i;
      const name = parseQuotedString(c);
      if (name === null) return null;
      const itemParams = parseParams(c);
      if (itemParams === null) return null;
      const raw = value.slice(compStart, c.i);
      const key = asString(itemParams["key"]);
      components.push(key !== undefined ? { name, key, raw } : { name, raw });
    }
    const params = parseParams(c);
    if (params === null) return null;
    entries.push({
      label,
      components,
      params: {
        created: asInt(params["created"]),
        expires: asInt(params["expires"]),
        keyid: asString(params["keyid"]),
        tag: asString(params["tag"]),
        alg: asString(params["alg"]),
        nonce: asString(params["nonce"]),
      },
      rawMemberText: value.slice(memberStart, c.i),
    });
    c.skipSp();
    if (c.eof()) return entries;
    if (c.peek() !== ",") return null;
    c.i++;
    c.skipSp();
  }
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Parse a `Signature` header: an SF dictionary of byte sequences
 * (label=:base64:). Returns null on grammar trouble.
 */
export function parseSignatureHeader(value: string): Map<string, Uint8Array> | null {
  const c = new Cursor(value);
  const out = new Map<string, Uint8Array>();
  c.skipSp();
  if (c.eof()) return null;
  for (;;) {
    const label = parseKey(c);
    if (label === null || c.peek() !== "=") return null;
    c.i++;
    if (c.peek() !== ":") return null;
    c.i++;
    const end = c.s.indexOf(":", c.i);
    if (end < 0) return null;
    const b64 = c.s.slice(c.i, end);
    if (!BASE64_RE.test(b64) || b64.length % 4 !== 0) return null;
    out.set(label, new Uint8Array(Buffer.from(b64, "base64")));
    c.i = end + 1;
    c.skipSp();
    if (c.eof()) return out;
    if (c.peek() !== ",") return null;
    c.i++;
    c.skipSp();
  }
}

/**
 * Parse a `Signature-Agent` header into the directory URL.
 *
 * Accepts the CF operational profile's plain quoted string (what deployed
 * signers send — CF explicitly REJECTS the dictionary form), tolerates the
 * rev-00 dictionary form (first member wins), and normalizes a bare host to
 * https. Returns null when neither shape parses or the URL is unusable.
 */
export function parseSignatureAgent(value: string): string | null {
  const c = new Cursor(value);
  c.skipSp();
  if (c.eof()) return null;
  let raw: string | null = null;
  if (c.peek() === '"') {
    raw = parseQuotedString(c);
  } else {
    const label = parseKey(c);
    if (label !== null && c.peek() === "=") {
      c.i++;
      raw = parseQuotedString(c);
    }
  }
  if (raw === null || raw.length === 0) return null;
  const normalized = raw.includes("://") ? raw : `https://${raw}`;
  try {
    const url = new URL(normalized);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.hostname.length === 0) return null;
  } catch {
    return null;
  }
  return normalized;
}

/* ------------------------------------------------------------------ *
 * Signature base construction + Ed25519 primitives.
 * ------------------------------------------------------------------ */

/** The request facts the base builder serializes components from. */
export interface RequestFacts {
  /** Host the request targeted (the `Host` header / URL authority). */
  authority: string;
  method: string;
  path: string;
  targetUri: string;
  /** Lowercase header-name → raw value. */
  headers: Record<string, string>;
}

/**
 * Raw member text of dictionary member `key` in an SF dictionary header value
 * — RFC 9421's `;key=` serialization, byte-exact. Null when absent/unparsable.
 */
function dictMemberRaw(headerValue: string, key: string): string | null {
  const c = new Cursor(headerValue);
  c.skipSp();
  for (;;) {
    const label = parseKey(c);
    if (label === null) return null;
    if (c.peek() !== "=") return null; // boolean member — not a shape we cover
    c.i++;
    const memberStart = c.i;
    if (c.peek() === ":") {
      // byte sequence
      c.i++;
      const end = c.s.indexOf(":", c.i);
      if (end < 0) return null;
      c.i = end + 1;
    } else if (parseBareItem(c) === null) {
      return null;
    }
    if (parseParams(c) === null) return null;
    if (label === key) return c.s.slice(memberStart, c.i);
    c.skipSp();
    if (c.eof()) return null;
    if (c.peek() !== ",") return null;
    c.i++;
    c.skipSp();
  }
}

/**
 * Build the RFC 9421 signature base for one Signature-Input entry. Returns
 * null when a covered component is unsupported or unresolvable — the caller
 * treats that as an invalid signature. Supported: `@authority`, `@method`,
 * `@path`, `@target-uri`, plain headers, and dictionary members via `;key=` —
 * everything real web-bot-auth signers cover (CF profile minimum: @authority).
 */
export function buildSignatureBase(entry: SignatureInputEntry, facts: RequestFacts): string | null {
  const lines: string[] = [];
  for (const comp of entry.components) {
    let value: string;
    if (comp.name.startsWith("@")) {
      if (comp.key !== undefined) return null;
      switch (comp.name) {
        case "@authority":
          value = facts.authority.toLowerCase();
          break;
        case "@method":
          value = facts.method.toUpperCase();
          break;
        case "@path":
          value = facts.path;
          break;
        case "@target-uri":
          value = facts.targetUri;
          break;
        default:
          return null;
      }
    } else {
      const rawHeader = facts.headers[comp.name.toLowerCase()];
      if (rawHeader === undefined) return null;
      if (comp.key !== undefined) {
        const member = dictMemberRaw(rawHeader, comp.key);
        if (member === null) return null;
        value = member;
      } else {
        value = rawHeader.trim();
      }
    }
    lines.push(`${comp.raw}: ${value}`);
  }
  lines.push(`"@signature-params": ${entry.rawMemberText}`);
  return lines.join("\n");
}

/**
 * RFC 7638 JWK thumbprint of an Ed25519 public key (the profile's keyid).
 * Required members in lexicographic order: crv, kty, x.
 */
export function jwkThumbprint(x: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x }))
    .digest("base64url");
}

/** Ed25519-verify `sig` over the UTF-8 `base` with a raw JWK x. Never throws. */
export function verifyEd25519(base: string, sig: Uint8Array, x: string): boolean {
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
    return cryptoVerify(null, Buffer.from(base, "utf8"), key, Buffer.from(sig));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Key directory: SSRF-guarded fetch + LRU/TTL cache + single-flight.
 * ------------------------------------------------------------------ */

const WELL_KNOWN_PATH = "/.well-known/http-message-signatures-directory";
const DIRECTORY_CONTENT_TYPE = "application/http-message-signatures-directory+json";
const DIRECTORY_MAX_BYTES = 65536;
const DIRECTORY_FETCH_TIMEOUT_MS = 3000;
const DEFAULT_POS_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_NEG_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CACHE_CAP = 256;
const DEFAULT_SKEW_SEC = 10;

/** keyid (RFC 7638 thumbprint) → raw Ed25519 JWK x, for one directory. */
export type DirectoryKeys = Map<string, string>;

/**
 * LRU + TTL cache of fetched key directories. `null` is a NEGATIVE entry
 * (directory unreachable/unusable) with its own shorter TTL, so a broken
 * operator doesn't get hammered but recovers quickly. One fetch per operator
 * per TTL — verification cost amortizes to zero on the hot path.
 */
export class DirectoryCache {
  private readonly entries = new Map<string, { keys: DirectoryKeys | null; at: number }>();
  private readonly posTtlMs: number;
  private readonly negTtlMs: number;
  private readonly cap: number;
  private readonly now: () => number;

  constructor(opts: { posTtlMs?: number; negTtlMs?: number; cap?: number; now?: () => number } = {}) {
    this.posTtlMs = opts.posTtlMs ?? DEFAULT_POS_TTL_MS;
    this.negTtlMs = opts.negTtlMs ?? DEFAULT_NEG_TTL_MS;
    this.cap = opts.cap ?? DEFAULT_CACHE_CAP;
    this.now = opts.now ?? Date.now;
  }

  /** undefined = no usable entry; null = cached negative; Map = cached keys. */
  get(url: string): DirectoryKeys | null | undefined {
    const e = this.entries.get(url);
    if (!e) return undefined;
    const ttl = e.keys === null ? this.negTtlMs : this.posTtlMs;
    if (this.now() - e.at > ttl) {
      this.entries.delete(url);
      return undefined;
    }
    this.entries.delete(url); // LRU refresh
    this.entries.set(url, e);
    return e.keys;
  }

  set(url: string, keys: DirectoryKeys | null): void {
    this.entries.delete(url);
    this.entries.set(url, { keys, at: this.now() });
    while (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export interface BotAuthOptions {
  fetchFn?: typeof fetch;
  cache?: DirectoryCache;
  /** epoch ms clock, injectable for tests. */
  now?: () => number;
  /**
   * Permit http:// + localhost directories — LOCAL TEST FIXTURES ONLY (the
   * signer walk serves its directory from a loopback port). Never in prod.
   */
  allowInsecureHttp?: boolean;
  clockSkewSec?: number;
}

export interface VerifiedAgent {
  /** The operator's directory host — the identity policy fragments match on. */
  agent: string;
  keyid: string;
}

export type BotAuthOutcome =
  /** No web-bot-auth signature on the request (or signed for another protocol). */
  | { status: "absent" }
  | { status: "verified"; agent: VerifiedAgent }
  /** A signature was presented and is WRONG — masquerade telemetry. */
  | { status: "invalid"; reason: string }
  /** Verifier/network trouble — fail open, treat as unsigned. */
  | { status: "unverified"; reason: string };

/**
 * Resolve + SSRF-guard the directory URL for a Signature-Agent value. The
 * agent URL is attacker-supplied: HTTPS only, no IP literals, no loopback —
 * except under the explicit local-fixture flag. Null = refused.
 */
function directoryUrlFor(agentUrl: string, allowInsecureHttp: boolean): { url: string; agentHost: string } | null {
  let u: URL;
  try {
    u = new URL(agentUrl);
  } catch {
    return null;
  }
  const hostname = u.hostname.toLowerCase();
  const bare = hostname.replace(/^\[|\]$/g, "");
  const isLoopback =
    hostname === "localhost" || hostname.endsWith(".localhost") || bare === "127.0.0.1" || bare === "::1";
  if (allowInsecureHttp && isLoopback) {
    return { url: `${u.protocol}//${u.host}${WELL_KNOWN_PATH}`, agentHost: hostname };
  }
  if (u.protocol !== "https:") return null;
  if (isLoopback || isIP(bare) !== 0) return null;
  return { url: `https://${u.host}${WELL_KNOWN_PATH}`, agentHost: hostname };
}

/** Read a response body with a hard byte cap. Null = over cap / unreadable. */
async function readCapped(res: Response, cap: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    return Buffer.byteLength(text) > cap ? null : text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Verify the directory's own signature (tag="http-message-signatures-directory")
 * with the keys it carries — the spec's binding of keys to host. Verified when
 * present; when absent we accept on the strength of the direct-TLS fetch to the
 * well-known host (early operators don't all sign yet — interop over rigor here,
 * revisit when signer coverage telemetry says the fleet signs).
 */
function directorySignatureOk(res: Response, dirUrl: string, keys: DirectoryKeys): boolean {
  const sigInputRaw = res.headers.get("signature-input");
  const sigRaw = res.headers.get("signature");
  if (sigInputRaw === null || sigRaw === null) return true; // absent → TLS-bound
  const entries = parseSignatureInput(sigInputRaw);
  const entry = entries?.find((e) => e.params.tag === "http-message-signatures-directory");
  if (!entry) return false;
  const sig = parseSignatureHeader(sigRaw)?.get(entry.label);
  if (!sig) return false;
  const x = entry.params.keyid !== undefined ? keys.get(entry.params.keyid) : undefined;
  if (x === undefined) return false;
  const u = new URL(dirUrl);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  const base = buildSignatureBase(entry, {
    authority: u.host.toLowerCase(),
    method: "GET",
    path: WELL_KNOWN_PATH,
    targetUri: dirUrl,
    headers,
  });
  if (base === null) return false;
  return verifyEd25519(base, sig, x);
}

/** Fetch + validate one key directory. Null = unusable (negative-cacheable). */
async function fetchDirectory(dirUrl: string, opts: BotAuthOptions): Promise<DirectoryKeys | null> {
  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const res = await fetchFn(dirUrl, {
      redirect: "manual", // the URL is attacker-supplied — never follow
      signal: AbortSignal.timeout(DIRECTORY_FETCH_TIMEOUT_MS),
      headers: { accept: DIRECTORY_CONTENT_TYPE },
    });
    if (res.status !== 200) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("http-message-signatures-directory+json")) return null;
    const body = await readCapped(res, DIRECTORY_MAX_BYTES);
    if (body === null) return null;
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return null;
    const rawKeys = (parsed as { keys?: unknown }).keys;
    if (!Array.isArray(rawKeys)) return null;
    const keys: DirectoryKeys = new Map();
    for (const k of rawKeys) {
      if (typeof k !== "object" || k === null) continue;
      const jwk = k as { kty?: unknown; crv?: unknown; x?: unknown };
      if (jwk.kty === "OKP" && jwk.crv === "Ed25519" && typeof jwk.x === "string") {
        keys.set(jwkThumbprint(jwk.x), jwk.x);
      }
    }
    if (keys.size === 0) return null;
    if (!directorySignatureOk(res, dirUrl, keys)) return null;
    return keys;
  } catch {
    return null;
  }
}

const defaultCache = new DirectoryCache();
/** Single-flight per directory URL — a burst of signed requests fetches once. */
const inflight = new Map<string, Promise<DirectoryKeys | null>>();

async function loadDirectory(dirUrl: string, cache: DirectoryCache, opts: BotAuthOptions): Promise<DirectoryKeys | null> {
  const running = inflight.get(dirUrl);
  if (running) return running;
  const p = fetchDirectory(dirUrl, opts)
    .then((keys) => {
      cache.set(dirUrl, keys);
      return keys;
    })
    .finally(() => {
      inflight.delete(dirUrl);
    });
  inflight.set(dirUrl, p);
  return p;
}

/**
 * Verify a request's Web Bot Auth signature, end to end.
 *
 * Outcome discipline (the product decision, not just plumbing):
 *  - absent     → no signature / not this protocol: the UA path proceeds as if
 *                 this module didn't exist (byte-identical regression bar).
 *  - verified   → cryptographic identity: classify() gets `verifiedAgent`.
 *  - invalid    → a PRESENTED signature failed: still served via the UA path
 *                 (fail-open), but flagged `sigInvalid` — masquerade telemetry.
 *  - unverified → OUR side couldn't verify (directory down, network): fail
 *                 open with no flag; a verifier outage must never block traffic.
 *
 * No nonce/replay cache in slice 1: the created/expires window (CF profile
 * ~1 minute) bounds replay; a replayed signature buys the same 402 quote.
 */
export async function verifyBotAuth(facts: RequestFacts, opts: BotAuthOptions = {}): Promise<BotAuthOutcome> {
  const h = facts.headers;
  const sigInputRaw = h["signature-input"];
  const sigRaw = h["signature"];
  const agentRaw = h["signature-agent"];
  if (sigInputRaw === undefined || sigRaw === undefined || agentRaw === undefined) {
    return { status: "absent" };
  }

  const entries = parseSignatureInput(sigInputRaw);
  if (entries === null) return { status: "invalid", reason: "unparsable Signature-Input" };
  const entry = entries.find((e) => e.params.tag === "web-bot-auth");
  if (!entry) return { status: "absent" }; // signed, but for some other protocol

  const { created, expires, keyid } = entry.params;
  if (created === undefined || expires === undefined || keyid === undefined) {
    return { status: "invalid", reason: "missing created/expires/keyid" };
  }
  const nowSec = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const skew = opts.clockSkewSec ?? DEFAULT_SKEW_SEC;
  if (expires < nowSec - skew) return { status: "invalid", reason: "signature expired" };
  if (created > nowSec + skew) return { status: "invalid", reason: "created in the future" };
  // Replay bound: the draft recommends a 24h max validity; CF's operational
  // profile uses ~1 minute. Without a cap, one captured signed request replays
  // for as long as the signer chose — cap acceptance at the spec's max.
  if (expires - created > 86_400) {
    return { status: "invalid", reason: "validity window exceeds the 24h max" };
  }

  if (!entry.components.some((c) => c.name === "@authority" || c.name === "@target-uri")) {
    return { status: "invalid", reason: "neither @authority nor @target-uri covered" };
  }

  const sig = parseSignatureHeader(sigRaw)?.get(entry.label);
  if (!sig) return { status: "invalid", reason: "no signature bytes for the signed label" };

  const agentUrl = parseSignatureAgent(agentRaw);
  if (agentUrl === null) return { status: "invalid", reason: "unparsable Signature-Agent" };
  const dir = directoryUrlFor(agentUrl, opts.allowInsecureHttp ?? false);
  if (dir === null) return { status: "invalid", reason: "refused directory host (scheme/IP-literal/loopback)" };

  const base = buildSignatureBase(entry, facts);
  if (base === null) return { status: "invalid", reason: "unresolvable covered component" };

  const cache = opts.cache ?? defaultCache;
  let keys = cache.get(dir.url);
  const wasCached = keys !== undefined;
  if (keys === undefined) keys = await loadDirectory(dir.url, cache, opts);
  if (keys === null) return { status: "unverified", reason: "key directory unavailable" };

  let x = keys.get(keyid);
  if (x === undefined && wasCached) {
    // Rotation grace: the cached directory may predate a new key — refetch once.
    keys = await loadDirectory(dir.url, cache, opts);
    if (keys === null) return { status: "unverified", reason: "key directory unavailable" };
    x = keys.get(keyid);
  }
  if (x === undefined) return { status: "invalid", reason: "keyid not in the operator's directory" };

  if (!verifyEd25519(base, sig, x)) return { status: "invalid", reason: "signature verification failed" };
  return { status: "verified", agent: { agent: dir.agentHost, keyid } };
}
