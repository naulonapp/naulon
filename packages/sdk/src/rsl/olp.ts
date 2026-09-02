/**
 * The Open Licensing Protocol — obtaining a licence from an RSL licence server.
 *
 * RSL's `<content server="…">` is not a hint. The spec: *"clients MUST obtain a license from this
 * server for the specified asset before access, even if the license type is `free`."* So a scope
 * with a server is one where the inline terms are advertising, not authority: paying the price
 * printed on the page moves money and licenses nothing.
 *
 * `terms.ts` reports that obligation; this module is how it is discharged. Three endpoints are
 * defined (§5.2) — `/token`, `/introspect`, `/key`. Only `/token` is implemented, because it is the
 * one a buying agent needs: `/introspect` is the RESOURCE server's side of the handshake, and
 * `/key` belongs to the Encrypted Media Standard, which naulon neither publishes nor consumes.
 *
 * ## The wire, exactly
 *
 *   POST {server}/token
 *   Authorization: Basic base64(client_id:client_secret)
 *   Content-Type: application/x-www-form-urlencoded
 *   grant_type=client_credentials&license=<url-encoded <license> XML>&resource=<content@url>
 *
 * → `{ access_token, token_type: "License", expires_in }`, where `expires_in: 0` means the token
 * does not expire. The token is then presented to the ORIGIN as `Authorization: License <token>`
 * (the Crawler Authorization Protocol), which is the wayfarer's job, not this module's.
 *
 * ## Why every failure has a code
 *
 * A licence server refusing us is not one condition. `invalid_client` is our credentials — an
 * operator has to fix it. `invalid_resource` is this publisher not being managed by the server they
 * named — nothing anyone here can do, and it must not read as "our key is wrong". `server_error` is
 * worth retrying and the others are not. Collapsing them into "the licence server said no" is how a
 * fleet spends a week debugging a typo in a secret.
 */
import { makeGuardedFetcher } from "../crawl/fetcher.ts";
import type { Fetcher } from "../crawl/types.ts";

/** The client credentials an operator holds for ONE licence server. */
export interface OlpCredentials {
  clientId: string;
  clientSecret: string;
}

export interface OlpToken {
  accessToken: string;
  /** Always `License` per the spec; carried so a server that answers otherwise is visible. */
  tokenType: string;
  /** Seconds. `0` = the token does not expire. */
  expiresIn: number;
  /** Epoch ms this token stops being usable, or null when it never does. */
  expiresAt: number | null;
}

/** Every way this can fail, kept apart because they call for different actions. */
export type OlpFailureCode =
  /** The four the spec defines with 400. */
  | "invalid_request"
  | "invalid_license"
  | "invalid_resource"
  | "unsupported_grant_type"
  /** The two it defines with 401 — both mean an operator must look at the credentials. */
  | "invalid_client"
  | "unauthorized_client"
  /** 500. Worth retrying; the others are not. */
  | "server_error"
  /** Ours, not the spec's: we never reached it, or what came back was not OLP. */
  | "unreachable"
  | "malformed";

export interface OlpFailure {
  code: OlpFailureCode;
  /** HTTP status, or 0 when no response was received. */
  status: number;
  /** The server's own `error_description`, when it sent one. Never invented. */
  description?: string;
}

export type OlpResult = { ok: true; token: OlpToken } | { ok: false; failure: OlpFailure };

/** Spec error codes, so a server inventing one is reported as `malformed` rather than trusted. */
const CODES = new Set<string>([
  "invalid_request",
  "invalid_license",
  "invalid_resource",
  "unsupported_grant_type",
  "invalid_client",
  "unauthorized_client",
  "server_error",
]);

/**
 * The `/token` URL for a server.
 *
 * `server` may already carry a path (`https://example-server.org/api`), so the endpoint is JOINED
 * rather than substituted — `new URL("/token", base)` would silently discard `/api` and POST our
 * credentials at the wrong path.
 */
export function tokenEndpoint(server: string): string | null {
  let u: URL;
  try {
    u = new URL(server);
  } catch {
    return null;
  }
  // A licence server is an authorization endpoint carrying client secrets. http:// is refused
  // outright rather than downgraded-with-a-warning.
  if (u.protocol !== "https:") return null;
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/token`;
  u.search = "";
  u.hash = "";
  return u.toString();
}

const basic = (c: OlpCredentials): string =>
  `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`, "utf8").toString("base64")}`;

/**
 * Acquire a licence token for one resource.
 *
 * `licenseXml` is the `<license>` element the terms came from and `resource` is the `content@url`
 * it sat under — both are what the spec asks for, and both must come from the document we actually
 * read rather than being reconstructed, or the server is being asked about a licence nobody offered.
 */
export async function acquireLicenseToken(input: {
  server: string;
  licenseXml: string;
  resource: string;
  credentials: OlpCredentials;
  /** Per-origin guarded fetcher factory (SSRF + anti-rebind). Defaults to the SDK's own. */
  fetcherFor?: (origin: string) => Fetcher;
  /** Clock seam, so an expiry test does not have to sleep. */
  now?: () => number;
}): Promise<OlpResult> {
  const endpoint = tokenEndpoint(input.server);
  if (endpoint === null) {
    return { ok: false, failure: { code: "unreachable", status: 0, description: "server is not an https URL" } };
  }
  const fetcherFor = input.fetcherFor ?? ((origin: string) => makeGuardedFetcher({ origin, timeoutMs: 10_000 }));
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    license: input.licenseXml,
    resource: input.resource,
  }).toString();

  let res;
  try {
    res = await fetcherFor(new URL(endpoint).origin)(endpoint, {
      method: "POST",
      body,
      headers: {
        authorization: basic(input.credentials),
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
    });
  } catch (err) {
    return { ok: false, failure: { code: "unreachable", status: 0, description: (err as Error).message } };
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await res.json()) as Record<string, unknown>;
  } catch {
    // A licence server that answers with HTML is a licence server we cannot use; saying so is more
    // useful than a JSON parse error surfacing three layers up.
    return { ok: false, failure: { code: "malformed", status: res.status, description: "response was not JSON" } };
  }

  if (!res.ok) {
    const stated = typeof payload["error"] === "string" ? payload["error"] : "";
    const description = typeof payload["error_description"] === "string" ? payload["error_description"] : undefined;
    return {
      ok: false,
      failure: {
        code: CODES.has(stated) ? (stated as OlpFailureCode) : "malformed",
        status: res.status,
        ...(description ? { description } : {}),
      },
    };
  }

  const accessToken = payload["access_token"];
  const tokenType = payload["token_type"];
  const expiresIn = payload["expires_in"];
  if (typeof accessToken !== "string" || accessToken === "" || typeof tokenType !== "string") {
    return { ok: false, failure: { code: "malformed", status: res.status, description: "no access_token" } };
  }
  // `expires_in` absent is treated as non-expiring, like an explicit 0: a token we keep for a
  // shorter time than the server intended costs a round trip; one we keep too long is a 401 on the
  // asset, and only the server's own number can prevent that.
  const seconds = typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0 ? Math.floor(expiresIn) : 0;
  const now = input.now ?? Date.now;
  return {
    ok: true,
    token: {
      accessToken,
      tokenType,
      expiresIn: seconds,
      expiresAt: seconds === 0 ? null : now() + seconds * 1000,
    },
  };
}

/**
 * Is this failure worth trying again?
 *
 * Only `server_error` and `unreachable`. Retrying `invalid_client` hammers a stranger's
 * authorization endpoint with credentials it has already rejected, which is how an agent gets an
 * operator's whole fleet blocked.
 */
export function olpRetryable(failure: OlpFailure): boolean {
  return failure.code === "server_error" || failure.code === "unreachable";
}
