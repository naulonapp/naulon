/**
 * The connect flow's wire shapes: the authorization request a runtime sends its owner to, the token
 * exchange that follows, and the site credential it delivers.
 *
 * It is OAuth 2.1 authorization code with PKCE (S256 only), plus one parameter: `site`, the origin
 * being connected. Before the owner can approve, the gate fetches
 * `${site}${CHALLENGE_PATH}${state}` and expects the request's `code_challenge`. A runtime answers
 * that path only for a state it started itself, so a connect for a host the caller does not run
 * proves nothing and is refused.
 *
 * The credential is long-lived, revocable and bound to its hosts. There is no refresh token: a
 * runtime is a server, often several workers sharing one stored value, and a rotated refresh token
 * raced across workers is how such an integration stops working without anyone noticing.
 */
import { createHash, randomBytes } from "node:crypto";
import { isLoopbackHostname } from "@naulon/sdk/net";
import { CHALLENGE_PATH, originOf } from "./discovery.ts";

export const SITE_CREDENTIAL_PREFIX = "nln_site_";
export const SITE_SCOPE = "site.enforce";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const CREDENTIAL_BODY = /^[0-9A-Za-z]{43}$/;
/** RFC 7636 §4.1: 43 to 128 characters from the unreserved set. */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
/** A state is a path segment the runtime serves, so it is held to the same safe alphabet. */
const STATE = /^[A-Za-z0-9\-_]{22,128}$/;

/** 43 base62 characters, about 256 bits, without modulo bias. */
export function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 248 && out.length < length) out += BASE62[byte % 62];
    }
  }
  return out;
}

export function mintSiteCredential(): string {
  return SITE_CREDENTIAL_PREFIX + randomBase62(43);
}

export function isSiteCredential(value: string): boolean {
  return value.startsWith(SITE_CREDENTIAL_PREFIX) && CREDENTIAL_BODY.test(value.slice(SITE_CREDENTIAL_PREFIX.length));
}

/** What a gate stores in place of a credential. */
export function credentialDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function newVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function newState(): string {
  return randomBytes(24).toString("base64url");
}

export function codeChallengeOf(verifier: string): string {
  if (!VERIFIER.test(verifier)) throw new Error("code_verifier must be 43 to 128 unreserved characters");
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function isState(value: string): boolean {
  return STATE.test(value);
}

/** The origin a site is connected as: scheme and host, port included, lowercase, nothing else. */
export function siteOriginOf(raw: string): string | null {
  const origin = originOf(raw);
  if (!origin) return null;
  const u = new URL(raw);
  return u.pathname === "/" && !u.search && !u.hash ? origin : null;
}

export function challengeUrl(site: string, state: string): string {
  return `${site}${CHALLENGE_PATH}${state}`;
}

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  site: string;
  state: string;
  codeChallenge: string;
}

/** The request as parameters, in one order. The URL and any form that carries the request forward
 *  are both built from this, so the two can never disagree about what a request contains. */
export function authorizationParams(r: AuthorizationRequest): [string, string][] {
  return [
    ["response_type", "code"],
    ["client_id", r.clientId],
    ["redirect_uri", r.redirectUri],
    ["scope", SITE_SCOPE],
    ["site", r.site],
    ["state", r.state],
    ["code_challenge", r.codeChallenge],
    ["code_challenge_method", "S256"],
  ];
}

export function authorizationUrl(endpoint: string, r: AuthorizationRequest): string {
  const u = new URL(endpoint);
  for (const [k, v] of authorizationParams(r)) u.searchParams.set(k, v);
  return u.toString();
}

/** Whether a presented redirect is the registered one: exactly. */
export function redirectMatches(registered: string, presented: string): boolean {
  return registered === presented;
}

export type ParsedAuthorization = { ok: true; request: AuthorizationRequest } | { ok: false; error: string };

/** The gate's half: refuse anything malformed before a page is rendered or a host is fetched. */
export function parseAuthorizationRequest(params: URLSearchParams): ParsedAuthorization {
  if (params.get("response_type") !== "code") return { ok: false, error: "unsupported_response_type" };
  if (params.get("code_challenge_method") !== "S256") return { ok: false, error: "code_challenge_method must be S256" };
  const scope = params.get("scope");
  if (scope !== null && scope !== SITE_SCOPE) return { ok: false, error: "invalid_scope" };
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const state = params.get("state") ?? "";
  const codeChallenge = params.get("code_challenge") ?? "";
  const site = siteOriginOf(params.get("site") ?? "");
  if (!originOf(clientId)) return { ok: false, error: "client_id must be an https URL" };
  if (!redirectUri) return { ok: false, error: "redirect_uri is required" };
  if (!site) return { ok: false, error: "site must be an origin, e.g. https://example.com" };
  if (!isState(state)) return { ok: false, error: "state must be 22 to 128 URL-safe characters" };
  if (!/^[A-Za-z0-9\-_]{43}$/.test(codeChallenge)) return { ok: false, error: "code_challenge must be an S256 challenge" };
  return { ok: true, request: { clientId, redirectUri, site, state, codeChallenge } };
}

/** The token endpoint's answer, a standard OAuth token response plus the site it is for. No
 *  `expires_in`: RFC 6749 §5.1 makes it optional, and this credential lasts until revoked. */
export interface SiteTokenResponse {
  access_token: string;
  token_type: "Bearer";
  scope: typeof SITE_SCOPE;
  site: string;
}
