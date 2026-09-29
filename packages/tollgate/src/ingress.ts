/**
 * Crawler-route ingress: a publisher's own CDN proxies AI-crawler requests to one shared gate
 * host, naming the site it is acting for.
 *
 * The publisher keeps their site where it is. A rule at their CDN matches crawler traffic and
 * fetches it from the ingress host server-side, so the crawler only ever sees the publisher's
 * URL. The request names the site in an RFC 7239 `Forwarded: host=` element and authenticates with
 * a per-site edge secret in `X-Naulon-Edge-Auth`.
 *
 * Three properties hold everywhere in this file:
 *
 * - A tenant is resolved from the NAMED host, and only then is the presented secret compared
 *   against that tenant's own secrets. A secret never selects a tenant, so tenant A's secret cannot
 *   be presented under tenant B's host to read or charge as B.
 * - Every refusal (no `Forwarded`, unknown host, missing or wrong secret) is the same response the
 *   gate gives an unknown Host, so the ingress cannot be used to learn which sites are tenants.
 *   The CDN rule fails open on any refusal, so a revoked secret degrades to "crawlers read free".
 * - An admitted request is rewritten into the request it stands for (`https://<site><path>`,
 *   `Host: <site>`), so every identity downstream (the signed x402 resource, the licence, the
 *   event, Web Bot Auth's `@authority`) names the publisher's site without being told to.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { isBareHostname, type PublisherConfig } from "@naulon/shared";

/** The request header carrying the per-site edge secret. Stripped before anything is forwarded. */
export const EDGE_AUTH_HEADER = "x-naulon-edge-auth";

/** Our RFC 8586 `CDN-Loop` token. Appended to the rewritten request, so it rides the origin fetch. */
export const CDN_LOOP_TOKEN = "naulon";

/** What an ingress resolver returns for a named site. */
export interface IngressTenant {
  config: PublisherConfig;
  /** Hex SHA-256 digests of the live edge secrets for this site. Two during a rotation. */
  edgeSecretDigests: readonly string[];
}

export interface IngressOptions {
  /** The shared ingress hostname, e.g. `ingress.naulon.app`. Compared case-insensitively. */
  host: string;
  /**
   * Resolve the site a request names. Must answer only for a host the tenant has PROVEN it owns,
   * and must not route: a crawler-route site is not in any routing set.
   */
  resolve(siteHost: string): Promise<IngressTenant | undefined>;
}

export interface ForwardedElement {
  host?: string;
  for?: string;
  proto?: string;
}

/**
 * The LAST element of an RFC 7239 `Forwarded` header (§4): the one added by the proxy nearest to
 * us, which is the publisher's CDN. A crawler can send its own `Forwarded`, and a CDN that appends
 * rather than replaces leaves it in front, so an earlier element is never trusted.
 */
export function lastForwardedElement(header: string | null | undefined): ForwardedElement | undefined {
  if (!header) return undefined;
  const elements = splitOutsideQuotes(header, ",");
  const last = elements[elements.length - 1];
  if (!last || !last.trim()) return undefined;
  const out: ForwardedElement = {};
  for (const pair of splitOutsideQuotes(last, ";")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim().toLowerCase();
    const value = unquote(pair.slice(eq + 1).trim());
    if (name === "host" || name === "for" || name === "proto") out[name] = value;
  }
  return out;
}

function splitOutsideQuotes(s: string, sep: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"' && s[i - 1] !== "\\") quoted = !quoted;
    if (ch === sep && !quoted) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\(.)/g, "$1");
  return v;
}


/**
 * A `Forwarded: host=` value reduced to a bare lowercase hostname, or undefined when it is not one.
 * A port is dropped (the site is named, not addressed); an IP literal or a single label is refused,
 * because no tenant's site is either.
 */
export function siteHostOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const bare = normalizeHost(value);
  return isBareHostname(bare) ? bare : undefined;
}

/** A Host as compared everywhere in this file: lowercase, no port, no trailing root dot. */
function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

/** `for=` reduced to an address the rate limiter can key on. IPv6 arrives as `"[::1]:port"`. */
/** The site a crawler-route request names in its last `Forwarded` element, if it names one. Used to
 *  key the refusal budget per site: the sender is a CDN's egress, which many publishers share. */
export function namedSiteOf(raw: Request): string | undefined {
  return siteHostOf(lastForwardedElement(raw.headers.get("forwarded"))?.host);
}

export function clientAddressOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (!v || v.startsWith("_") || v.toLowerCase() === "unknown") return undefined;
  const v6 = /^\[([0-9a-f:.]+)\](?::\d+)?$/i.exec(v);
  if (v6 && isIP(v6[1]!) === 6) return v6[1]!.toLowerCase();
  // RFC 7239 §6 requires IPv6 bracketed and quoted, but a Cloudflare Worker's `cf-connecting-ip`
  // is bare, so a recipe that forgets the brackets must still key per crawler.
  // A bare IPv6 carries no port, so accepting it is unambiguous.
  if (isIP(v) === 6) return v.toLowerCase();
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(v);
  return v4 && isIP(v4[1]!) === 4 ? v4[1] : undefined;
}

/** Hex SHA-256 of an edge secret: what a resolver stores and compares. */
export function edgeSecretDigest(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Constant-time: does `presented` match any of `digests`? Every digest is compared, whatever the
 * outcome of the earlier ones, and comparisons run over equal-length SHA-256 buffers, so timing
 * says nothing about which secret or how much of it matched.
 */
export function edgeSecretMatches(presented: string | null | undefined, digests: readonly string[]): boolean {
  if (!presented) return false;
  const got = Buffer.from(edgeSecretDigest(presented), "hex");
  let ok = false;
  for (const d of digests) {
    const want = Buffer.from(d, "hex");
    if (want.length !== got.length) continue;
    if (timingSafeEqual(want, got)) ok = true;
  }
  return ok;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** Is this a request to the ingress host? Port, case and a trailing root dot are ignored. */
export function isIngressHost(host: string, ingress: Pick<IngressOptions, "host"> | undefined): boolean {
  if (!ingress) return false;
  return normalizeHost(host) === normalizeHost(ingress.host);
}

export type IngressAdmission =
  | { kind: "miss" }
  | { kind: "loop" }
  | { kind: "admitted"; request: Request; siteHost: string; clientIp: string | undefined; config: PublisherConfig };

/**
 * Admit, refuse or loop-stop one ingress request.
 *
 * A loop is our own origin fetch coming back: the gate fetched the publisher's origin through
 * their CDN, and the CDN's crawler rule routed that fetch to the ingress again. Two independent
 * tells, either sufficient: the request carries the site's origin-auth secret (only the gate ever
 * sets it), or its `CDN-Loop` already names us. Checked after the site is authenticated, because
 * the origin secret is per site and an unauthenticated request learns nothing either way.
 */
export async function admitIngress(raw: Request, ingress: IngressOptions): Promise<IngressAdmission> {
  const fwd = lastForwardedElement(raw.headers.get("forwarded"));
  const siteHost = siteHostOf(fwd?.host);
  const presented = raw.headers.get(EDGE_AUTH_HEADER);
  // No secret at all is a miss before any lookup: the sender already knows it sent none, so
  // answering early discloses nothing, and a secretless flood costs the resolver nothing.
  if (!siteHost || isIngressHost(siteHost, ingress) || !presented) return { kind: "miss" };

  const tenant = await ingress.resolve(siteHost);
  // Compare even when the tenant is unknown, so a miss on an unknown host costs the same as a
  // miss on a wrong secret.
  const matched = edgeSecretMatches(presented, tenant?.edgeSecretDigests ?? []);
  if (!tenant || !matched) return { kind: "miss" };

  const originAuth = raw.headers.get("x-naulon-origin-auth");
  const secret = tenant.config.originAuthSecret;
  if (originAuth && secret && constantTimeEqual(originAuth, secret)) return { kind: "loop" };
  const cdnLoop = raw.headers.get("cdn-loop");
  if (cdnLoop && cdnLoopNamesUs(cdnLoop)) return { kind: "loop" };

  const inbound = new URL(raw.url);
  const url = `https://${siteHost}${inbound.pathname}${inbound.search}`;
  const headers = new Headers(raw.headers);
  headers.delete("forwarded");
  headers.delete(EDGE_AUTH_HEADER);
  // The rewritten URL is https and authoritative. A proxy-supplied scheme would otherwise override
  // it when the gate trusts proxy headers, and a CDN's own x-forwarded-* describe its hop, not ours.
  headers.delete("x-forwarded-proto");
  headers.delete("x-forwarded-host");
  headers.delete("x-forwarded-for");
  headers.set("host", siteHost);
  headers.set("cdn-loop", cdnLoop ? `${cdnLoop}, ${CDN_LOOP_TOKEN}` : CDN_LOOP_TOKEN);
  // The body is handed over as a stream, never read here: admission is followed by the per-site
  // rate limit, and buffering first would let an over-limit caller make the gate hold its upload.
  const hasBody = raw.method !== "GET" && raw.method !== "HEAD" && raw.body !== null;
  const request = new Request(url, {
    method: raw.method,
    headers,
    ...(hasBody ? { body: raw.body, duplex: "half" } : {}),
  } as RequestInit);
  return { kind: "admitted", request, siteHost, clientIp: clientAddressOf(fwd?.for), config: tenant.config };
}

function cdnLoopNamesUs(header: string): boolean {
  return header
    .split(",")
    .some((entry) => entry.trim().split(";")[0]!.trim().toLowerCase() === CDN_LOOP_TOKEN);
}

/**
 * The ingress is ONE hostname for every site, so any cache in front of the gate keys
 * `ingress/<path>` identically for all of them. A response that is not already `no-store` becomes
 * `private`, which forbids every shared cache (RFC 9111 §5.2.2.7) while leaving a crawler's own
 * cache free to keep it.
 */
export function privateToIngress(res: Response): Response {
  const cc = res.headers.get("cache-control") ?? "";
  const directives = cc
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  if (directives.some((d) => d.toLowerCase() === "no-store")) return res;
  const kept = directives.filter((d) => {
    const name = d.split("=")[0]!.trim().toLowerCase();
    return name !== "public" && name !== "s-maxage" && name !== "private" && name !== "proxy-revalidate";
  });
  res.headers.set("Cache-Control", ["private", ...kept].join(", "));
  return res;
}
