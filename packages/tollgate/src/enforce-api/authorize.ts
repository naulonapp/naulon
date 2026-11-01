/**
 * The ownership step every enforce route shares: authenticate, then resolve the host to the caller's
 * own publisher or refuse. A host that resolves to another publisher is a 403 with no detail, because
 * answering for it would tell the caller that the host is a customer and what it charges.
 */
import type { Context } from "hono";
import type { PublisherConfig } from "@naulon/shared";
import type { EnforceApiDeps } from "./index.ts";

export type Authorized =
  | { ok: true; publisher: PublisherConfig; host: string; selfHosted: boolean }
  | { ok: false; response: Response };

/** The host of an absolute resource URL, or null when it is missing or not a URL. */
export function hostOfResource(resource: string | undefined | null): string | null {
  if (!resource) return null;
  try {
    return new URL(resource).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

export async function authorize(c: Context, deps: EnforceApiDeps, host: string | null): Promise<Authorized> {
  const auth = await deps.auth(c, host);
  if (!auth.ok) return { ok: false, response: c.json({ error: auth.error }, auth.status) };
  if (host === null) return { ok: false, response: c.json({ error: "bad request" }, 400) };

  let publisher = await deps.resolver.resolve(host);
  if (!publisher && deps.hooks?.resolveByOwner) {
    publisher = await deps.hooks.resolveByOwner(auth.publisherId, host);
  }
  if (!publisher || publisher.id !== auth.publisherId) {
    deps.hooks?.reportUnownedHost?.(auth.publisherId, host);
    return { ok: false, response: c.json({ error: "resource not owned by this key" }, 403) };
  }
  return { ok: true, publisher, host, selfHosted: auth.selfHosted };
}
