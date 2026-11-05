/**
 * Who is asking to connect, and is the site really running it.
 *
 * Client identity is a Client ID Metadata Document: the `client_id` is an https URL, and the JSON
 * served there names the client and the redirects it may use. A gate needs no registration with any
 * runtime it has never seen. Each runtime serves its own document from its own origin
 * (`CLIENT_METADATA_PATH`), so a WordPress site, a Django app and a blog platform are each their own
 * client, and their redirect lives on the origin that served the document.
 *
 * The one exception is a command-line client, which has no origin of its own and may only redirect
 * to loopback. Its document is built in (`CLI_CLIENT`), so no gate ever fetches it: a self-hosted
 * gate must work with naulon.app unreachable. The same document is published at `CLI_CLIENT_ID` for
 * clients that read it there.
 *
 * Everything a client declares is untrusted. Its name is shown beside the origin that served it,
 * never alone, and nothing else it declares (logos, links) is shown at all.
 */
import { z } from "zod";
import { guardedRequest, isLoopbackHostname } from "@naulon/sdk/net";
import { originOf } from "./discovery.ts";
import { challengeUrl, redirectMatches } from "./flow.ts";

export const CLIENT_METADATA_PATH = "/.well-known/naulon-client";
export const CLI_CLIENT_ID = "https://naulon.app/clients/cli.json";
export const CLI_CLIENT_METADATA = {
  client_id: CLI_CLIENT_ID,
  client_name: "naulon command line",
  redirect_uris: ["http://127.0.0.1/callback", "http://localhost/callback"],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code"],
} as const;

export interface ConnectClient {
  clientId: string;
  /** The origin that served the document. This, not the declared name, is what the owner trusts. */
  origin: string;
  name: string;
  redirectUris: string[];
}

const DOC = z.object({
  client_id: z.string(),
  client_name: z.string().trim().min(1).max(80),
  redirect_uris: z.array(z.string()).min(1).max(10),
  token_endpoint_auth_method: z.literal("none").optional(),
  grant_types: z.array(z.string()).optional(),
});

export type ClientResult = { ok: true; client: ConnectClient } | { ok: false; error: string };

/** A redirect a document may declare: on its own origin, or loopback http for a command line. */
function allowedRedirect(clientOrigin: string, uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "http:" && isLoopbackHostname(u.hostname)) return true;
  return u.protocol === "https:" && u.origin === clientOrigin;
}

export function parseClientMetadata(body: unknown, clientId: string): ClientResult {
  const origin = originOf(clientId);
  if (!origin) return { ok: false, error: "client_id must be an https URL" };
  const parsed = DOC.safeParse(body);
  if (!parsed.success) return { ok: false, error: `the client's metadata is malformed at ${parsed.error.issues[0]?.path.join(".") || "body"}` };
  const d = parsed.data;
  if (d.client_id !== clientId) return { ok: false, error: "the metadata names a different client_id" };
  if (d.grant_types && !d.grant_types.includes("authorization_code")) return { ok: false, error: "the client does not use authorization_code" };
  const bad = d.redirect_uris.find((r) => !allowedRedirect(origin, r));
  if (bad) return { ok: false, error: `redirect ${bad} is not on ${origin}` };
  return { ok: true, client: { clientId, origin, name: d.client_name, redirectUris: d.redirect_uris } };
}

/** Answered from code: the one client whose document no gate fetches. */
const CLI_CLIENT = (() => {
  const r = parseClientMetadata(CLI_CLIENT_METADATA, CLI_CLIENT_ID);
  if (!r.ok) throw new Error(`the built-in command-line client is invalid: ${r.error}`);
  return r;
})();

/** Whether `presented` is one of the client's redirects. */
export function redirectAllowed(client: ConnectClient, presented: string): boolean {
  return client.redirectUris.some((r) => redirectMatches(r, presented));
}

export interface ClientResolver {
  resolve(clientId: string): Promise<ClientResult>;
}

/** Fetches each document through the guard and keeps it for its max-age, 5 minutes to 1 day. */
export function clientResolver(opts: { allowPrivate?: boolean; now?: () => number; fetch?: typeof guardedRequest } = {}): ClientResolver {
  const get = opts.fetch ?? guardedRequest;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; ttl: number; result: ClientResult & { ok: true } }>();
  return {
    async resolve(clientId) {
      if (clientId === CLI_CLIENT_ID) return CLI_CLIENT;
      const hit = cache.get(clientId);
      if (hit && now() - hit.at < hit.ttl) return hit.result;
      const res = await get(clientId, { maxBytes: 16 * 1024, timeoutMs: 5_000, headers: { accept: "application/json" }, ...(opts.allowPrivate ? { allowPrivate: true } : {}) });
      if (!res.ok) return { ok: false, error: `the client's metadata could not be fetched: ${res.detail}` };
      if (res.status !== 200) return { ok: false, error: `the client's metadata answered ${res.status}` };
      let body: unknown;
      try {
        body = JSON.parse(res.body);
      } catch {
        return { ok: false, error: "the client's metadata is not JSON" };
      }
      const result = parseClientMetadata(body, clientId);
      if (result.ok) {
        const age = Number(/max-age=(\d+)/.exec(res.headers["cache-control"] ?? "")?.[1] ?? 0);
        cache.set(clientId, { at: now(), ttl: Math.min(Math.max(age, 300), 86_400) * 1000, result });
        if (cache.size > 1000) cache.delete(cache.keys().next().value as string);
      }
      return result;
    },
  };
}

export type ChallengeResult = { ok: true } | { ok: false; reason: string };

/**
 * Ask the site to prove it is running the client that started this connect: it must answer the
 * state's path with the request's code challenge. Only a runtime holding that pending connect knows
 * to answer, so a connect started for somebody else's site fails here.
 */
export async function checkChallenge(
  site: string,
  state: string,
  codeChallenge: string,
  opts: { allowPrivate?: boolean; fetch?: typeof guardedRequest } = {},
): Promise<ChallengeResult> {
  const get = opts.fetch ?? guardedRequest;
  const res = await get(challengeUrl(site, state), { maxBytes: 256, timeoutMs: 5_000, headers: { accept: "text/plain" }, ...(opts.allowPrivate ? { allowPrivate: true } : {}) });
  if (!res.ok) return { ok: false, reason: `${site} could not be reached: ${res.detail}` };
  if (res.status !== 200) return { ok: false, reason: `${site} answered ${res.status}: is naulon installed and switched on there?` };
  if (res.body.trim() !== codeChallenge) return { ok: false, reason: `${site} did not answer this connect. Start it again from the site.` };
  return { ok: true };
}
