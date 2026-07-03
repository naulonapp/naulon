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
export function botAuthHeadersFor(url: string): Record<string, string> | null {
  const id = resolveIdentity();
  if (!id) return null;
  const authority = new URL(url).host;
  return { ...signBotAuth({ key: id.key, authority, tag: "web-bot-auth", agent: id.agent }) };
}

/**
 * fetch with the wayfarer's Web Bot Auth identity attached (when configured).
 * Caller headers win on collision — not that anything else sets these — and an
 * unconfigured agent falls through to the exact fetch it always made.
 */
export async function agentFetch(url: string, init?: RequestInit): Promise<Response> {
  const signed = botAuthHeadersFor(url);
  if (!signed) return fetch(url, init);
  const headers = { ...signed, ...((init?.headers as Record<string, string> | undefined) ?? {}) };
  return fetch(url, { ...init, headers });
}
