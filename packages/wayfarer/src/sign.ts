/**
 * Web Bot Auth request signing (WBA slice 3) — the wayfarer as a signing agent.
 *
 * When the operator configures a signing identity (BOT_AUTH_SIGNING_KEY) and a
 * directory host to advertise (BOT_AUTH_SIGNATURE_AGENT), every outbound
 * wayfarer request carries the three RFC 9421 headers, so ANY Web-Bot-Auth
 * verifier — our own gate, or a Cloudflare-fronted publisher — can prove who
 * is calling instead of trusting the UA string. Unconfigured, `agentFetch` is
 * a plain fetch: byte-identical headers, the same regression bar the gate's
 * verifier holds for unsigned traffic.
 */
import { botAuthKeyFromSeed, getConfig, signBotAuth, type BotAuthKey } from "@naulon/shared";
import { forgetLicenseToken, licenseTokenFor } from "./license-token.ts";

interface AgentIdentity {
  key: BotAuthKey;
  agent: string;
}

/** Lazily resolved once per process; `undefined` = not yet looked at,
 *  `null` = signing not configured. */
let identity: AgentIdentity | null | undefined;

function resolveIdentity(): AgentIdentity | null {
  if (identity !== undefined) return identity;
  const cfg = getConfig();
  identity =
    cfg.BOT_AUTH_SIGNING_KEY && cfg.BOT_AUTH_SIGNATURE_AGENT
      ? { key: botAuthKeyFromSeed(cfg.BOT_AUTH_SIGNING_KEY), agent: cfg.BOT_AUTH_SIGNATURE_AGENT }
      : null;
  return identity;
}

/** Test seam: forget the cached identity (pairs with shared's resetConfig). */
export function resetAgentIdentity(): void {
  identity = undefined;
}

/** The three Web Bot Auth headers for a request to `url`, or null when the
 *  signing identity isn't configured. Signed per call — the ~1-minute validity
 *  window means a signature is never reusable across a slow run. */
export function botAuthHeadersFor(url: string, opts: { coverPath?: boolean } = {}): Record<string, string> | null {
  const id = resolveIdentity();
  if (!id) return null;
  const u = new URL(url);
  // Covering the path makes the signature a witness of THIS request: it cannot be lifted onto
  // another URL of the same host. Required whenever the signature is what a charge rests on.
  // `@path` is the path alone (RFC 9421), which is how the verifier rebuilds it.
  const path = opts.coverPath ? u.pathname : undefined;
  return {
    ...signBotAuth({ key: id.key, authority: u.host, tag: "web-bot-auth", agent: id.agent, ...(path !== undefined ? { path } : {}) }),
  };
}

/**
 * fetch with the wayfarer's Web Bot Auth identity attached (when configured).
 * Caller headers win on collision — not that anything else sets these — and an
 * unconfigured agent falls through to the exact fetch it always made.
 */
export async function agentFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetchHop(url, init, 0);
}

/** Redirects a licensed read follows, re-signing each hop: fetch's own limit. */
const MAX_LICENCE_HOPS = 20;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
let warnedUnsigned = false;

/** A refusal that says the token itself is unusable, from the hosted gate or a self-hosted site. */
function refusedAsInvalid(res: Response): boolean {
  if (/error="invalid_token"/.test(res.headers.get("www-authenticate") ?? "")) return true;
  return /licence refused \(invalid_token\)/.test(res.headers.get("x-naulon-verdict") ?? "");
}

async function fetchHop(url: string, init: RequestInit | undefined, hop: number): Promise<Response> {
  // An OLP licence token, if we hold one for this URL. Attached HERE because every request the
  // agent makes passes through this function, and four separate places in buyer.ts build headers of
  // their own — a token remembered at each is a token forgotten at one. A caller that set its own
  // `authorization` wins: it knows something we do not.
  const licenseToken = licenseTokenFor(url);
  const caller = (init?.headers as Record<string, string> | undefined) ?? {};
  const hasOwnAuth = Object.keys(caller).some((k) => k.toLowerCase() === "authorization");
  const presenting = Boolean(licenseToken && !hasOwnAuth);
  const license = presenting ? { authorization: `License ${licenseToken}` } : {};
  // A licence read can be charged on the strength of this signature, so it covers the path too.
  const signed = botAuthHeadersFor(url, { coverPath: presenting });
  if (presenting && !signed && !warnedUnsigned) {
    warnedUnsigned = true;
    console.warn(
      "[wayfarer] presenting an RSL licence unsigned: a site that serves its own pages charges a licence only on a Web Bot Auth signature, so set BOT_AUTH_SIGNING_KEY and BOT_AUTH_SIGNATURE_AGENT",
    );
  }
  if (!signed && !licenseToken) return fetch(url, init);
  const headers = { ...signed, ...license, ...caller };
  if (!presenting) return fetch(url, { ...init, headers });

  // The signature covers this URL's path, so a redirect is followed here and signed again: fetch
  // would carry this signature onto the next path, where it witnesses nothing. The caller's own
  // redirect mode and fetch's method rules are kept, so this reads like the fetch it replaces.
  const res = await fetch(url, { ...init, headers, redirect: "manual" });
  if (licenseToken && refusedAsInvalid(res)) forgetLicenseToken(url, licenseToken);
  const mode = init?.redirect ?? "follow";
  const location = res.headers.get("location");
  if (!REDIRECTS.has(res.status) || !location || mode === "manual") return res;
  await res.body?.cancel().catch(() => {});
  if (mode === "error") throw new TypeError(`fetch failed: redirect from ${url} was not allowed`);
  if (hop >= MAX_LICENCE_HOPS) throw new TypeError(`fetch failed: more than ${MAX_LICENCE_HOPS} redirects from ${url}`);
  const method = (init?.method ?? "GET").toUpperCase();
  const toGet = (res.status === 303 && method !== "HEAD") || ((res.status === 301 || res.status === 302) && method === "POST");
  const next = new URL(location, url).toString();
  // Another origin gets its own token, if any, and its own signature: `fetchHop` looks both up again.
  return fetchHop(next, toGet ? { ...init, method: "GET", body: undefined } : init, hop + 1);
}
