/**
 * The runtime's half of connect: send the site's owner to their gate to approve, prove the site is
 * running this code, and keep the credential that comes back.
 *
 *   const connect = naulonConnect({ clientName: "My blog", store });
 *   // In the site's settings, a button:
 *   const { url } = await connect.start({ site: "https://blog.example.com" });
 *   // At `${site}${returnPath}`, where the gate sends the owner back:
 *   const r = await connect.finish(new URL(req.url).searchParams);
 *   if (r.ok) saveCredential(r.site, r.gate, r.credential);
 *   // In front of every request, before the toll:
 *   const answered = await connect.wellKnown(req); if (answered) return answered;
 *
 * `wellKnown` answers two paths on the site itself: the client's metadata document (who is asking,
 * where it may return to) and the challenge for a connect this process started. A gate fetches both
 * before the owner sees Approve. Nothing else is ever answered there.
 *
 * Pending connects live in a `ConnectStore`. The default keeps them in memory, which is right for one
 * process; a site served by several processes, or a platform, passes one backed by its own database,
 * because the process that answers the gate's challenge may not be the one that started the connect.
 */
import {
  authorizationUrl,
  CHALLENGE_PATH,
  CLIENT_METADATA_PATH,
  codeChallengeOf,
  DEFAULT_GATE,
  isSiteCredential,
  isState,
  newState,
  newVerifier,
  originOf,
  parseDiscovery,
  siteOriginOf,
  SITE_SCOPE,
  type NaulonDiscovery,
} from "@naulon/shared";
import { guardedRequest, isLoopbackHostname } from "@naulon/sdk/net";

export interface PendingConnect {
  site: string;
  gate: string;
  verifier: string;
  challenge: string;
  redirectUri: string;
  expiresAt: number;
}

export interface ConnectStore {
  put(state: string, pending: PendingConnect): Promise<void>;
  get(state: string): Promise<PendingConnect | null>;
  delete(state: string): Promise<void>;
}

/** The gate's code lives 10 minutes; a pending connect lives as long as the owner might take to read
 *  the page, sign in, and come back. */
export const PENDING_TTL_MS = 15 * 60_000;
const MAX_PENDING = 1_000;

export function memoryConnectStore(now: () => number = Date.now): ConnectStore {
  const rows = new Map<string, PendingConnect>();
  return {
    async put(state, pending) {
      for (const [k, v] of rows) if (v.expiresAt <= now()) rows.delete(k);
      while (rows.size >= MAX_PENDING) rows.delete(rows.keys().next().value as string);
      rows.set(state, pending);
    },
    async get(state) {
      const p = rows.get(state);
      if (!p) return null;
      if (p.expiresAt <= now()) {
        rows.delete(state);
        return null;
      }
      return p;
    },
    async delete(state) {
      rows.delete(state);
    },
  };
}

type Requester = typeof guardedRequest;

export type DiscoverResult = { ok: true; doc: NaulonDiscovery } | { ok: false; error: string };

/** One discovery per gate, kept for five minutes. */
export function discoverer(opts: { request?: Requester; now?: () => number } = {}): (gate: string) => Promise<DiscoverResult> {
  const request = opts.request ?? guardedRequest;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; doc: NaulonDiscovery }>();
  return async (gate) => {
    const origin = originOf(gate);
    if (!origin) return { ok: false, error: `${gate} is not an https URL` };
    const hit = cache.get(origin);
    if (hit && now() - hit.at < 300_000) return { ok: true, doc: hit.doc };
    const res = await request(`${origin}/.well-known/naulon`, { timeoutMs: 5_000, allowPrivate: isLoopbackHostname(new URL(origin).hostname) });
    if (!res.ok) return { ok: false, error: `${origin} could not be reached: ${res.detail}` };
    if (res.status !== 200) return { ok: false, error: `${origin} is not a naulon gate (it answered ${res.status})` };
    let body: unknown;
    try {
      body = JSON.parse(res.body);
    } catch {
      return { ok: false, error: `${origin} is not a naulon gate` };
    }
    const parsed = parseDiscovery(body, origin);
    if (!parsed.ok) return parsed;
    cache.set(origin, { at: now(), doc: parsed.doc });
    if (cache.size > 1_000) cache.delete(cache.keys().next().value as string);
    return parsed;
  };
}

export interface NaulonConnectOptions {
  /** What the owner reads on the approve page as the name of the thing asking. */
  clientName: string;
  /** The gate to connect to when `start` names none. Default: the hosted naulon gate. */
  gate?: string;
  store?: ConnectStore;
  /** Where the client's metadata is served, when not on the site being connected (a platform
   *  serving many sites from one domain). Default: `${site}/.well-known/naulon-client`. */
  clientId?: (site: string) => string;
  /** Where the gate sends the owner back on the site. Default `/naulon/connect/return`. */
  returnPath?: string;
  /** Every redirect this client may return to. Default: `${site}${returnPath}`, derived rather than
   *  remembered, so any process serving the site gives the gate the same answer. A platform that
   *  returns owners to one settings page on its own domain lists that page here. */
  redirectUris?: (site: string) => string[];
  request?: Requester;
  now?: () => number;
}

export type StartResult = { ok: true; url: string } | { ok: false; error: string };
export type FinishResult =
  | { ok: true; site: string; gate: string; credential: string }
  | { ok: false; error: "denied" | "expired" | "refused" | "invalid"; message: string };

export interface NaulonConnect {
  /** `returnTo` defaults to the first of `redirectUris(site)` and must be one of them. */
  start(o: { site: string; gate?: string; returnTo?: string }): Promise<StartResult>;
  finish(query: URLSearchParams): Promise<FinishResult>;
  /** Answers the two connect paths on the site itself, or null for every other request. */
  wellKnown(req: Request): Promise<Response | null>;
}

export function naulonConnect(opts: NaulonConnectOptions): NaulonConnect {
  const store = opts.store ?? memoryConnectStore(opts.now);
  const now = opts.now ?? Date.now;
  const request = opts.request ?? guardedRequest;
  const discover = discoverer({ request, now });
  const clientIdFor = opts.clientId ?? ((site: string) => `${site}${CLIENT_METADATA_PATH}`);
  const returnPath = opts.returnPath ?? "/naulon/connect/return";
  if (!returnPath.startsWith("/")) throw new Error("returnPath must start with /");
  const redirectsFor = opts.redirectUris ?? ((site: string) => [`${site}${returnPath}`]);

  const challengeResponse = (body: string, status = 200) =>
    new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

  return {
    async start({ site: rawSite, returnTo, gate: rawGate }) {
      const site = siteOriginOf(rawSite);
      if (!site) return { ok: false, error: `${rawSite} is not a site origin, e.g. https://example.com` };
      const gate = originOf(rawGate ?? opts.gate ?? DEFAULT_GATE);
      if (!gate) return { ok: false, error: "the gate must be an https URL" };
      const allowed = redirectsFor(site);
      const back = returnTo ?? allowed[0];
      if (!back || !allowed.includes(back)) return { ok: false, error: `returnTo must be one of ${allowed.join(", ")}` };
      const d = await discover(gate);
      if (!d.ok) return d;
      const verifier = newVerifier();
      const state = newState();
      const challenge = codeChallengeOf(verifier);
      await store.put(state, { site, gate, verifier, challenge, redirectUri: back, expiresAt: now() + PENDING_TTL_MS });
      const url = authorizationUrl(d.doc.authorization_endpoint, { clientId: clientIdFor(site), redirectUri: back, site, state, codeChallenge: challenge });
      return { ok: true, url };
    },

    async finish(query) {
      const state = query.get("state") ?? "";
      if (!isState(state)) return { ok: false, error: "invalid", message: "this return carries no connect to finish" };
      const pending = await store.get(state);
      if (!pending) return { ok: false, error: "expired", message: "this connect has expired or was already finished. Start it again." };
      await store.delete(state);
      if (query.get("error") === "access_denied") return { ok: false, error: "denied", message: "the gate's owner did not approve this site" };
      const code = query.get("code");
      if (!code) return { ok: false, error: "invalid", message: `the gate returned ${query.get("error") ?? "no code"}` };
      const d = await discover(pending.gate);
      if (!d.ok) return { ok: false, error: "refused", message: d.error };
      const res = await request(d.doc.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri, client_id: clientIdFor(pending.site) }).toString(),
        timeoutMs: 10_000,
        allowPrivate: isLoopbackHostname(new URL(pending.gate).hostname),
      });
      if (!res.ok) return { ok: false, error: "refused", message: `the gate could not be reached: ${res.detail}` };
      let body: { access_token?: unknown; scope?: unknown; site?: unknown; error_description?: unknown };
      try {
        body = JSON.parse(res.body) as typeof body;
      } catch {
        return { ok: false, error: "refused", message: `the gate answered ${res.status} with no JSON` };
      }
      if (res.status !== 200) return { ok: false, error: "refused", message: String(body.error_description ?? `the gate answered ${res.status}`) };
      if (typeof body.access_token !== "string" || !isSiteCredential(body.access_token)) return { ok: false, error: "refused", message: "the gate returned no site credential" };
      if (body.scope !== SITE_SCOPE || body.site !== pending.site) return { ok: false, error: "refused", message: "the gate returned a credential for something else" };
      return { ok: true, site: pending.site, gate: pending.gate, credential: body.access_token };
    },

    async wellKnown(req) {
      const url = new URL(req.url);
      if (req.method !== "GET" && req.method !== "HEAD") return null;
      if (url.pathname.startsWith(CHALLENGE_PATH)) {
        const state = url.pathname.slice(CHALLENGE_PATH.length);
        const pending = isState(state) ? await store.get(state) : null;
        // A state this process never started is answered exactly like a page that does not exist.
        if (!pending || new URL(pending.site).host !== url.host) return challengeResponse("not found\n", 404);
        return challengeResponse(`${pending.challenge}\n`);
      }
      if (url.pathname === CLIENT_METADATA_PATH) {
        const site = siteOriginOf(url.origin);
        // Answer only when this URL really is this client's id; a platform whose id lives elsewhere
        // serves its document there.
        if (!site || clientIdFor(site) !== `${url.origin}${CLIENT_METADATA_PATH}`) return null;
        const redirects = redirectsFor(site);
        return new Response(
          JSON.stringify({ client_id: clientIdFor(site), client_name: opts.clientName, redirect_uris: redirects, token_endpoint_auth_method: "none", grant_types: ["authorization_code"] }),
          { status: 200, headers: { "content-type": "application/json", "cache-control": "max-age=300" } },
        );
      }
      return null;
    },
  };
}
