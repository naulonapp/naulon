/**
 * The caller's address as the console should RECORD it: the same proxy-aware answer the
 * failed-sign-in budget meters by (`resolveClientIdentity`), never the raw X-Forwarded-For.
 *
 * The audit log used to take the header's first entry. A direct caller writes that header
 * themselves, so a fail2ban rule reading the log could be steered into banning any address an
 * attacker named, the operator's included; and a caller with no header was recorded with no
 * address at all. Config is read per call so importing this module reads nothing.
 */
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { getConfig, resolveClientIdentity } from "@naulon/shared";

export function clientAddress(c: Context): string | undefined {
  let peer: string | undefined;
  try {
    peer = getConnInfo(c).remote.address;
  } catch {
    peer = undefined; // no socket: serverless, or app.request in a test
  }
  const cfg = getConfig();
  const who = resolveClientIdentity({
    xff: c.req.header("x-forwarded-for"),
    peer,
    trustProxy: cfg.TRUST_PROXY,
    hops: cfg.TRUST_PROXY_HOPS,
  });
  return who.ok ? who.key : undefined;
}
