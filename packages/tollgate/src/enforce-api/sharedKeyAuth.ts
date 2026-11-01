/**
 * Auth for a self-hosted gate: one shared key, set by the operator, that every in-app runtime of the
 * gate's publishers presents as `Authorization: Bearer <key>`.
 *
 * The key is compared as SHA-256 digests with `timingSafeEqual`, so neither its length nor its
 * content leaks through timing. A host is accepted only when the gate's own resolver knows it, so a
 * gate backed by a platform resolver never answers for a site the platform does not toll.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { PublisherResolver } from "@naulon/shared";
import type { EnforceAuth } from "./index.ts";

/** The shortest shared key accepted. Matches the gate's `NAULON_ENFORCE_KEY` validation. */
export const MIN_ENFORCE_KEY_LENGTH = 32;

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

export function sharedKeyAuth(key: string, resolver: PublisherResolver): EnforceAuth {
  if (key.length < MIN_ENFORCE_KEY_LENGTH) {
    throw new Error(`the enforce key must be at least ${MIN_ENFORCE_KEY_LENGTH} characters`);
  }
  const expected = digest(key);
  return async (c, host) => {
    const header = c.req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    if (presented === null || !timingSafeEqual(digest(presented), expected)) {
      return { ok: false, status: 401, error: "unauthorized" };
    }
    if (host === null) return { ok: true, publisherId: "", selfHosted: true };
    const publisher = await resolver.resolve(host);
    if (!publisher) return { ok: false, status: 403, error: "resource not owned by this key" };
    return { ok: true, publisherId: publisher.id, selfHosted: true };
  };
}
