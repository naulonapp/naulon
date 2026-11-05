/**
 * The runtime's half of connect: send the site's owner to their gate to approve, prove the site is
 * running this code, and keep the credential that comes back.
 *
 *   const connect = naulonConnect({ clientName: "My blog", site: "https://blog.example.com", store });
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
  /** Whose connect this is, when the caller said (see `start`). */
  binding?: string;
  expiresAt: number;
}

/**
 * Where pending connects wait for the owner to come back. `take` must be atomic: of two requests
 * taking one state, exactly one gets it. That is what keeps a refreshed return page, or two workers,
 * from exchanging one code twice, which the gate answers by revoking the credential the first
 * exchange got. A database store does it with `DELETE ... RETURNING`.
 */
export interface ConnectStore {
  put(state: string, pending: PendingConnect): Promise<void>;
  get(state: string): Promise<PendingConnect | null>;
  take(state: string): Promise<PendingConnect | null>;
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
    async take(state) {
      const p = rows.get(state);
      rows.delete(state);
      return p && p.expiresAt > now() ? p : null;
    },
  };
}

type Requester = typeof guardedRequest;

const mayBePrivate = (gate: string, localGate: string | null | undefined): boolean =>
  !!localGate && gate === localGate && isLoopbackHostname(new URL(gate).hostname);

export type DiscoverResult = { ok: true; doc: NaulonDiscovery } | { ok: false; error: string };

/** One discovery per gate, kept for five minutes. `localGate` is the one gate allowed on loopback:
 *  the one the developer configured. A gate that arrives at runtime (a writer's, on a platform) never
 *  reaches a private address, or a writer could aim the platform's server at its own internals. */
export function discoverer(opts: { request?: Requester; now?: () => number; localGate?: string | null } = {}): (gate: string) => Promise<DiscoverResult> {
  const request = opts.request ?? guardedRequest;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; doc: NaulonDiscovery }>();
  return async (gate) => {
    const origin = originOf(gate);
    if (!origin) return { ok: false, error: `${gate} is not an https URL` };
    const hit = cache.get(origin);
    if (hit && now() - hit.at < 300_000) return { ok: true, doc: hit.doc };
    const res = await request(`${origin}/.well-known/naulon`, { timeoutMs: 5_000, allowPrivate: mayBePrivate(origin, opts.localGate) });
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
  /**
   * When set, `handle` also finishes the owner's return at `${site}${returnPath}` and reports it
   * here, so an app needs no route of its own. `naulon connect` uses it: the app stores the
   * credential and tells the waiting command how the connect ended.
   */
  onFinish?: (state: string, result: FinishResult) => Promise<void>;
  /**
   * The one site this runtime connects. `start` for any other is refused. A site's own app, or
   * `naulon connect` beside it, sets this.
   */
  site?: string;
  /**
   * A platform serving many sites: may the account `binding` connect `site`? Approving a connect
   * proves the domain for the account's naulon site, and this runtime answers the gate's challenge
   * for every site it serves, so this check is what stops one account connecting another's site.
   * It is the platform's to make, against its own record of who owns which site. With it set, every
   * `start` must carry a `binding`.
   */
  authorizeSite?: (site: string, binding: string) => boolean | Promise<boolean>;
}

export type StartResult = { ok: true; url: string } | { ok: false; error: string };
export type FinishResult =
  | { ok: true; site: string; gate: string; credential: string }
  | { ok: false; error: "denied" | "expired" | "refused" | "invalid" | "not_yours"; message: string };

export interface NaulonConnect {
  /**
   * `returnTo` defaults to the first of `redirectUris(site)` and must be one of them.
   *
   * `binding` ties the connect to whoever started it: a platform passes the signed-in account's id
   * (or a session id), and `finish` with any other binding is refused. Without it, someone who
   * started a connect could send its return link to another account holder, and a platform that
   * saves the result under the current account would save the sender's site there.
   */
  start(o: { site: string; gate?: string; returnTo?: string; binding?: string }): Promise<StartResult>;
  // `start` refuses unless the options name the one `site`, or an `authorizeSite` check says yes.
  /** `binding` must be what `start` was given, when it was given one. */
  finish(query: URLSearchParams, o?: { binding?: string }): Promise<FinishResult>;
  /** Answers the two connect paths on the site itself, or null for every other request. */
  wellKnown(req: Request): Promise<Response | null>;
  /** `wellKnown`, and with `onFinish` set, the return page too. Null for every other request. */
  handle(req: Request): Promise<Response | null>;
}

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The page the owner lands on after approving: plain, self-contained, never cached. */
function returnPage(r: FinishResult): Response {
  const [title, body] = r.ok
    ? ["Connected", `${escapeHtml(new URL(r.site).host)} now tolls through ${escapeHtml(new URL(r.gate).host)}. You can close this tab.`]
    : [r.error === "denied" ? "Not connected" : "Connect did not finish", escapeHtml(r.message)];
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
      `<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem"><h1 style="font-size:1.4rem">${title}</h1><p>${body}</p></body></html>`,
    { status: r.ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } },
  );
}

export function naulonConnect(opts: NaulonConnectOptions): NaulonConnect {
  const store = opts.store ?? memoryConnectStore(opts.now);
  const now = opts.now ?? Date.now;
  const request = opts.request ?? guardedRequest;
  const configured = originOf(opts.gate ?? DEFAULT_GATE);
  const discover = discoverer({ request, now, localGate: configured });
  const clientIdFor = opts.clientId ?? ((site: string) => `${site}${CLIENT_METADATA_PATH}`);
  const returnPath = opts.returnPath ?? "/naulon/connect/return";
  if (!returnPath.startsWith("/")) throw new Error("returnPath must start with /");
  const redirectsFor = opts.redirectUris ?? ((site: string) => [`${site}${returnPath}`]);

  const challengeResponse = (body: string, status = 200) =>
    new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

  type Exchanged = { ok: true; site: string; gate: string; credential: string } | { ok: false; error: "refused"; message: string; transient: boolean };

  const exchange = async (pending: PendingConnect, code: string): Promise<Exchanged> => {
    const refused = (message: string, transient = false): Exchanged => ({ ok: false, error: "refused", message, transient });
    const d = await discover(pending.gate);
    if (!d.ok) return refused(d.error, true);
    const res = await request(d.doc.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri, client_id: clientIdFor(pending.site) }).toString(),
      timeoutMs: 10_000,
      allowPrivate: mayBePrivate(pending.gate, configured),
    });
    if (!res.ok) return refused(`the gate could not be reached: ${res.detail}`, true);
    if (res.status >= 500) return refused(`the gate answered ${res.status}`, true);
    let body: { access_token?: unknown; scope?: unknown; site?: unknown; error_description?: unknown };
    try {
      body = JSON.parse(res.body) as typeof body;
    } catch {
      return refused(`the gate answered ${res.status} with no JSON`);
    }
    if (res.status !== 200) return refused(String(body.error_description ?? `the gate answered ${res.status}`));
    if (typeof body.access_token !== "string" || !isSiteCredential(body.access_token)) return refused("the gate returned no site credential");
    if (body.scope !== SITE_SCOPE || body.site !== pending.site) return refused("the gate returned a credential for something else");
    return { ok: true, site: pending.site, gate: pending.gate, credential: body.access_token };
  };

  const self: NaulonConnect = {
    async start({ site: rawSite, returnTo, gate: rawGate, binding }) {
      const site = siteOriginOf(rawSite);
      if (!site) return { ok: false, error: `${rawSite} is not a site origin, e.g. https://example.com` };
      // Approving proves the domain, so who may start a connect for which site is decided here.
      if (opts.site !== undefined) {
        if (siteOriginOf(opts.site) !== site) return { ok: false, error: `this runtime connects ${opts.site} only` };
      } else if (opts.authorizeSite) {
        if (binding === undefined) return { ok: false, error: "a platform's start must carry the account's binding" };
        if (!(await opts.authorizeSite(site, binding))) return { ok: false, error: `this account may not connect ${site}` };
      } else {
        return { ok: false, error: "naulonConnect needs `site` (one site) or `authorizeSite` (a platform) before it can start a connect" };
      }
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
      await store.put(state, { site, gate, verifier, challenge, redirectUri: back, ...(binding !== undefined ? { binding } : {}), expiresAt: now() + PENDING_TTL_MS });
      const url = authorizationUrl(d.doc.authorization_endpoint, { clientId: clientIdFor(site), redirectUri: back, site, state, codeChallenge: challenge });
      return { ok: true, url };
    },

    async finish(query, o = {}) {
      const state = query.get("state") ?? "";
      if (!isState(state)) return { ok: false, error: "invalid", message: "this return carries no connect to finish" };
      const peek = await store.get(state);
      if (!peek) return { ok: false, error: "expired", message: "this connect has expired or was already finished. Start it again." };
      // Checked before anything is taken, so a return that is not this one's can neither finish the
      // connect nor cancel it.
      if (peek.binding !== undefined && peek.binding !== o.binding) return { ok: false, error: "not_yours", message: "this connect was started by someone else. Start it again from your own settings." };
      // RFC 9207: the response names its gate. A different name means a gate other than the one this
      // connect started with is trying to hand over a code (a mix-up), so nothing is exchanged.
      if (query.get("iss") !== peek.gate) return { ok: false, error: "refused", message: "the response did not come from the gate this connect started with" };
      if (query.get("error") === "access_denied") {
        await store.take(state);
        return { ok: false, error: "denied", message: "the gate's owner did not approve this site" };
      }
      const code = query.get("code");
      if (!code) return { ok: false, error: "invalid", message: `the gate returned ${query.get("error") ?? "no code"}` };
      // One exchange per code: whoever takes the pending connect exchanges it, everyone else stops.
      const pending = await store.take(state);
      if (!pending) return { ok: false, error: "expired", message: "this connect is already being finished." };
      const result = await exchange(pending, code);
      // A gate that could not be reached decided nothing: the owner may simply try the link again.
      if (!result.ok && result.transient) await store.put(state, pending);
      return result.ok ? result : { ok: false, error: result.error, message: result.message };
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

    async handle(req) {
      const answered = await self.wellKnown(req);
      if (answered || !opts.onFinish) return answered;
      const url = new URL(req.url);
      if (req.method !== "GET" || url.pathname !== returnPath) return null;
      // Reported only for a connect this site started: anyone can request the return path with any
      // state, and a report per request would let them fill the disk the report is kept on.
      const state = url.searchParams.get("state") ?? "";
      const ours = isState(state) && (await store.get(state)) !== null;
      const result = await self.finish(url.searchParams);
      if (ours) await opts.onFinish(state, result);
      return returnPage(result);
    },
  };
  return self;
}
