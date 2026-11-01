/**
 * Auth for a self-hosted gate's in-app enforce API.
 *
 * Two credentials, both presented as `Authorization: Bearer <key>`:
 *  - the operator key (`NAULON_ENFORCE_KEY`), which acts for every host the gate's resolver knows.
 *    It belongs on servers the operator runs, never on a site someone else controls;
 *  - a site key, whose SHA-256 a platform puts on that site's record (`enforceKeySha256`). It acts
 *    for that publisher's hosts only, so the publisher is decided by the credential, not by the
 *    host the caller names.
 *
 * Keys are compared as SHA-256 digests with `timingSafeEqual`, so neither length nor content leaks
 * through timing. A caller with no bearer token never reaches the resolver; a caller presenting a
 * key that is not the operator's learns nothing about which hosts exist (every refusal is a 401).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { PublisherResolver } from "@naulon/shared";
import type { EnforceAuth } from "./index.ts";

/** The shortest operator key accepted. Matches the gate's `NAULON_ENFORCE_KEY` validation. */
export const MIN_ENFORCE_KEY_LENGTH = 32;

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
const UNAUTHORIZED = { ok: false, status: 401, error: "unauthorized" } as const;

export function sharedKeyAuth(key: string, resolver: PublisherResolver): EnforceAuth {
  if (key.length < MIN_ENFORCE_KEY_LENGTH) {
    throw new Error(`the enforce key must be at least ${MIN_ENFORCE_KEY_LENGTH} characters`);
  }
  const operator = digest(key);
  return async (c, host) => {
    const header = c.req.header("authorization") ?? "";
    if (!header.startsWith("Bearer ")) return UNAUTHORIZED;
    const presented = digest(header.slice("Bearer ".length));
    const isOperator = timingSafeEqual(presented, operator);
    if (host === null) return isOperator ? { ok: true, publisherId: "", selfHosted: true } : UNAUTHORIZED;

    const publisher = await resolver.resolve(host);
    if (!publisher) return isOperator ? { ok: false, status: 403, error: "resource not owned by this key" } : UNAUTHORIZED;
    if (isOperator) return { ok: true, publisherId: publisher.id, selfHosted: true };
    const siteDigest = publisher.enforceKeySha256 ? Buffer.from(publisher.enforceKeySha256, "hex") : undefined;
    if (siteDigest && siteDigest.length === presented.length && timingSafeEqual(presented, siteDigest)) {
      return { ok: true, publisherId: publisher.id, selfHosted: true };
    }
    return UNAUTHORIZED;
  };
}
