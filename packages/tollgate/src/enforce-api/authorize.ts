/**
 * The ownership step every enforce route shares: authenticate, then resolve the host to the caller's
 * own publisher or refuse. A host that resolves to another publisher is a 403 with no detail, because
 * answering for it would tell the caller that the host is a customer and what it charges.
 */
import type { Context } from "hono";
import type { PublisherConfig } from "@naulon/shared";
import type { EnforceApiDeps } from "./index.ts";

export type Authorized =
  | { ok: true; publisher: PublisherConfig; host: string; path: string; selfHosted: boolean }
  | { ok: false; response: Response };

/** Where a request points: a host, or why it names none. The two refusals keep distinct messages
 *  because runtimes already branch on them. */
export type Target = { host: string; path: string } | { error: "bad request" | "bad resource" };

export function targetOf(resource: string | undefined | null): Target {
  if (!resource) return { error: "bad request" };
  try {
    const url = new URL(resource);
    return url.host ? { host: url.host.toLowerCase(), path: url.pathname } : { error: "bad resource" };
  } catch {
    return { error: "bad resource" };
  }
}

/** The body a refusal carries. Most routes answer `{ error }`; `/verify` answers `{ ok: false, error }`. */
export type ErrorBody = (error: string) => Record<string, unknown>;
const plain: ErrorBody = (error) => ({ error });

export async function authorize(c: Context, deps: EnforceApiDeps, target: Target, body: ErrorBody = plain): Promise<Authorized> {
  const auth = await deps.auth(c, "host" in target ? target.host : null);
  if (!auth.ok) return { ok: false, response: "response" in auth ? auth.response : c.json(body(auth.error), auth.status) };
  if (!("host" in target)) return { ok: false, response: c.json(body(target.error), 400) };
  const { host } = target;

  let publisher = await deps.resolver.resolve(host);
  if (!publisher && deps.hooks?.resolveByOwner) {
    publisher = await deps.hooks.resolveByOwner(auth.publisherId, host);
  }
  if (!publisher || publisher.id !== auth.publisherId) {
    deps.hooks?.reportUnownedHost?.(auth.publisherId, host);
    return { ok: false, response: c.json(body("resource not owned by this key"), 403) };
  }
  return { ok: true, publisher, host, path: target.path, selfHosted: auth.selfHosted };
}
