/**
 * The gate's half of connect: the discovery document, the token endpoint that turns an approved
 * code into a site credential, and revocation. The owner's half (signing in and pressing Approve)
 * is the console's, which writes the code into the same state store this reads.
 *
 *   GET  /.well-known/naulon          discovery (RFC 8414 shape)
 *   POST /_naulon/connect/token        authorization_code + PKCE, form-encoded (RFC 6749 §4.1.3)
 *   POST /_naulon/connect/revoke       RFC 7009; 200 whether or not the credential existed
 *
 * Every token response carries `Cache-Control: no-store`. No route reads a cookie.
 */
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  buildDiscovery,
  DISCOVERY_PATH,
  credentialDigest,
  issueCredential,
  originOf,
  recordIssue,
  redeemCode,
  revokeCredential,
  revokeCredentialById,
  SITE_SCOPE,
  type GateStateStore,
  type SiteTokenResponse,
} from "@naulon/shared";

export const TOKEN_PATH = "/_naulon/connect/token";
export const REVOKE_PATH = "/_naulon/connect/revoke";
const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" } as const;

export interface GateConnectOptions {
  state: GateStateStore;
  /** This gate's issuer (`connectIssuer`), or null when it has none: discovery then says how to fix it. */
  issuer: string | null;
  /** Where the owner approves: the console's `/connect/authorize`. */
  authorizeUrl: string;
  networkMember?: () => boolean;
}

type TokenError = "invalid_request" | "invalid_grant" | "invalid_client" | "unsupported_grant_type";

function tokenError(c: Context, error: TokenError, description: string, status: 400 | 401 = 400): Response {
  return c.json({ error, error_description: description }, status, NO_STORE);
}

async function formOf(c: Context): Promise<URLSearchParams | null> {
  if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
  return new URLSearchParams(await c.req.text());
}

export function mountGateConnect(app: Hono, o: GateConnectOptions): void {
  app.get(DISCOVERY_PATH, (c) => {
    const issuer = o.issuer;
    if (!issuer) return c.json({ error: "this gate cannot name its own origin; set NAULON_PUBLIC_URL" }, 503);
    const doc = buildDiscovery({ issuer, authorizationEndpoint: o.authorizeUrl, networkMember: o.networkMember?.() ?? false });
    return c.json(doc, 200, { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" });
  });

  app.post(TOKEN_PATH, bodyLimit({ maxSize: 8 * 1024, onError: (c) => tokenError(c, "invalid_request", "request too large") }), async (c) => {
    const form = await formOf(c);
    if (!form) return tokenError(c, "invalid_request", "send application/x-www-form-urlencoded");
    if (form.get("grant_type") !== "authorization_code") return tokenError(c, "unsupported_grant_type", "only authorization_code is supported");
    const code = form.get("code");
    const codeVerifier = form.get("code_verifier");
    const redirectUri = form.get("redirect_uri");
    const clientId = form.get("client_id");
    if (!code || !codeVerifier || !redirectUri || !clientId) return tokenError(c, "invalid_request", "code, code_verifier, redirect_uri and client_id are required");
    const r = await redeemCode(o.state, { code, codeVerifier, redirectUri, clientId });
    if (!r.ok) {
      // A code redeemed twice leaked somewhere. The first redemption may have been the thief's, so
      // what it was exchanged for is revoked too, and the site connects again from clean.
      if (r.replayOf) await revokeCredentialById(o.state, r.replayOf);
      return tokenError(c, r.error, r.reason, r.error === "invalid_client" ? 401 : 400);
    }
    const credential = await issueCredential(o.state, {
      site: r.code.site,
      clientId: r.code.clientId,
      clientName: r.code.clientName,
      approvedBy: r.code.approvedBy,
    });
    await recordIssue(o.state, r, credentialDigest(credential));
    const body: SiteTokenResponse = { access_token: credential, token_type: "Bearer", scope: SITE_SCOPE, site: r.code.site };
    return c.json(body, 200, NO_STORE);
  });

  app.post(REVOKE_PATH, bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.body(null, 413) }), async (c) => {
    const form = await formOf(c);
    const token = form?.get("token");
    if (!token) return c.json({ error: "invalid_request", error_description: "token is required" }, 400, NO_STORE);
    await revokeCredential(o.state, token);
    return c.body(null, 200, NO_STORE);
  });
}
