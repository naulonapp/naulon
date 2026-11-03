/**
 * The ownership step every enforce route shares: authenticate, then resolve the host to the caller's
 * own publisher or refuse. A host that resolves to another publisher is a 403 with no detail, because
 * answering for it would tell the caller that the host is a customer and what it charges.
 */
import type { Context } from "hono";
import type { OpenAPIHono } from "@hono/zod-openapi";
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
  const publisher = await ownedPublisher(deps, auth.publisherId, host);
  if (!publisher) return { ok: false, response: c.json(body("resource not owned by this key"), 403) };
  return { ok: true, publisher, host, path: target.path, selfHosted: auth.selfHosted };
}

/**
 * `host`'s publisher when it is `publisherId`'s own, else undefined (and the refusal is reported).
 * A host the resolver does not route is asked of `resolveByOwner`; a host that resolves to another
 * publisher is never re-asked, because that is a real cross-publisher call.
 */
export async function ownedPublisher(deps: EnforceApiDeps, publisherId: string, host: string): Promise<PublisherConfig | undefined> {
  let publisher = await deps.resolver.resolve(host);
  if (!publisher && deps.hooks?.resolveByOwner) publisher = await deps.hooks.resolveByOwner(publisherId, host);
  if (publisher && publisher.id === publisherId) return publisher;
  deps.hooks?.reportUnownedHost?.(publisherId, host);
  return undefined;
}

/**
 * Authenticate a JSON POST route before its body validator runs, so an unauthenticated caller always
 * gets 401 and never a validation 400. The host offered to `auth` is the first report's `resource`.
 */
export function authBeforeValidation(
  app: OpenAPIHono,
  path: string,
  deps: EnforceApiDeps,
  body: ErrorBody = plain,
  /** The body for an authenticated request that is not JSON at all. Without it the validator answers
   *  with its own text, which on a verdict route carries no verdict. */
  unreadable?: () => Record<string, unknown>,
): void {
  app.use(path, async (c, next) => {
    if (c.req.method !== "POST") return next();
    const NOT_JSON = Symbol("not json");
    const raw: unknown = await c.req.json().catch(() => NOT_JSON);
    const first: unknown = Array.isArray(raw) ? raw[0] : raw;
    const resource = typeof first === "object" && first !== null ? (first as { resource?: unknown }).resource : undefined;
    const target = targetOf(typeof resource === "string" ? resource : undefined);
    const auth = await deps.auth(c, "host" in target ? target.host : null);
    if (!auth.ok) return "response" in auth ? auth.response : c.json(body(auth.error), auth.status);
    if (raw === NOT_JSON && unreadable) return c.json(unreadable(), 400);
    return next();
  });
}

/**
 * The route validator's hook for the two routes that answer with a verdict. Without it the validator
 * answers a body it cannot read with its own error shape, which carries no verdict, and a runtime
 * serves the page on no verdict. The key was authenticated before validation, so the body is an
 * answer about this request: refused.
 */
export function refuseUnreadable(body: () => Record<string, unknown>) {
  return (result: { success: boolean }, c: Context): never => (result.success ? undefined : c.json(body(), 400)) as never;
}
