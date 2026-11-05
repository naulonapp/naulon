/**
 * crawl/net.ts — THE SSRF guard. One owner, every outbound seam.
 *
 * Two places in this tree point a socket at a host someone else chose: the crawler
 * fetches whatever URL an adapter derives from a publisher's origin (feed paths,
 * `/wp-json`, sitemap `<loc>`s), and the webhook sender POSTs to a customer-supplied
 * endpoint. Both are pointable-at-anything footguns — a hostile or misconfigured value
 * could name `http://169.254.169.254` (cloud metadata) or `http://10.0.0.5` (an internal
 * service). So every connection is CIDR-checked against the private/loopback/link-local
 * ranges, and — because a plain check-then-connect leaves a DNS-rebind window — the
 * socket connects through `guardedLookup`, which validates the ACTUAL resolved IP.
 *
 * It lives here, in the zero-dependency bottom package, and is reached through the
 * `@naulon/sdk/net` subpath. Until 2026-08-17 `@naulon/shared`'s webhook sender carried a
 * byte-identical copy (written when it could not depend on this package; it can now).
 * Two copies of a blocklist is one blocklist plus a hole waiting for the next range
 * somebody adds to only one of them.
 */
import { lookup as dnsLookupCb } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, isIPv4, isIPv6, type LookupFunction } from "node:net";

/**
 * Every range no public host has, in one table: private, loopback, link-local, carrier NAT,
 * documentation, benchmarking, multicast, reserved, and the IPv6 forms that carry an IPv4 address
 * inside them (IPv4-compatible `::/96`, NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`, 6to4
 * `2002::/16`, Teredo `2001::/32`). Python's `naulon.ip.BLOCKED` is the same table, and
 * `test-fixtures/blocked-target-cases.json` holds both runtimes to the same answer for each address.
 */
export const BLOCKED_RANGES: readonly string[] = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
  "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24",
  "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
  "::/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/32", "2001:db8::/32", "2002::/16",
  "fc00::/7", "fe80::/10", "ff00::/8",
];

// `BlockList` compares addresses, not spellings: `[::ffff:127.0.0.1]` reaches a caller as
// `::ffff:7f00:1` once the URL parser has had it, and an IPv4-mapped address is checked against the
// IPv4 rules. A regex over the text missed exactly that form.
const BLOCKED = (() => {
  const list = new BlockList();
  for (const range of BLOCKED_RANGES) {
    const [addr, bits] = range.split("/") as [string, string];
    list.addSubnet(addr, Number(bits), addr.includes(":") ? "ipv6" : "ipv4");
  }
  return list;
})();

const LOOPBACK = (() => {
  const list = new BlockList();
  list.addSubnet("127.0.0.0", 8, "ipv4");
  list.addAddress("::1", "ipv6");
  return list;
})();

/** The literal inside a host as a URL spells it: no brackets, no IPv6 zone. */
const literalOf = (host: string): string => host.replace(/^\[(.*)\]$/, "$1").split("%")[0]!;

/** True if `host` is a literal IP in a blocked range. A DNS name is NOT blocked here —
 *  it has no literal to check; `guardedLookup` validates the resolved IP at connect time. */
export function isBlockedTarget(host: string): boolean {
  const ip = literalOf(host);
  if (isIPv4(ip)) return BLOCKED.check(ip, "ipv4");
  if (isIPv6(ip)) return BLOCKED.check(ip, "ipv6");
  return false;
}

/** True when `host` is an IP LITERAL (v4 or v6) rather than a DNS name. `isBlockedTarget`
 *  answers "is this literal blocked" and returns false for a name, which is the right
 *  answer but not a way to tell the two apart — a caller that must resolve-then-check
 *  needs to know whether there is anything to resolve. */
export function isIpLiteral(host: string): boolean {
  return isIP(literalOf(host)) !== 0;
}

/**
 * A `lookup` implementation for `http(s).request` that rejects any resolved address in a
 * blocked range. Passing this as the request's `lookup` closes the check/connect rebind
 * window: the IP the socket connects to is the one that passed the guard. `allowPrivate`
 * (a dev-only knob for local fixture origins) relaxes it.
 */
export function guardedLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookupCb(hostname, { all: true, family: options.family ?? 0 }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      for (const a of addresses) {
        if (!allowPrivate && isBlockedTarget(a.address)) {
          return callback(new Error(`blocked target (private/loopback): ${a.address}`), "", 0);
        }
      }
      if (options.all) return callback(null, addresses);
      const first = addresses[0];
      if (!first) return callback(new Error("dns resolution returned no address"), "", 0);
      callback(null, first.address, first.family);
    });
  };
}

/** `localhost`, any of 127.0.0.0/8, or `::1`: an address that can only mean this machine. */
export function isLoopbackHostname(hostname: string): boolean {
  const h = literalOf(hostname.toLowerCase());
  if (h === "localhost") return true;
  if (isIPv4(h)) return LOOPBACK.check(h, "ipv4");
  return isIPv6(h) && LOOPBACK.check(h, "ipv6");
}

export type GuardedRefusal = "bad_url" | "not_https" | "blocked" | "too_large" | "timeout" | "unreachable";

export type GuardedResponse =
  | { ok: true; status: number; body: string; headers: Record<string, string> }
  | { ok: false; refusal: GuardedRefusal; detail: string };

export interface GuardedRequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** A body over `maxBytes` is cut there ("truncate") or refused outright ("refuse", the default). */
  overflow?: "truncate" | "refuse";
  /** Permit private and loopback targets, and plain http to them. A local walk or a fixture only. */
  allowPrivate?: boolean;
}

/**
 * The one way this project sends a request to a URL somebody else chose: a publisher's origin
 * being crawled, a webhook endpoint, a client's metadata document, a gate a writer typed in.
 *
 *   https only, unless `allowPrivate`;
 *   an IP literal in a blocked range is refused before connecting, and a name is checked at connect
 *   time by `guardedLookup`, so it cannot pass as a public address and then connect to a private one;
 *   a redirect is returned as its status and never followed;
 *   the body is capped and the exchange has a deadline.
 *
 * It never throws. Every refusal is data, so a caller decides what a refusal means for it.
 */
export function guardedRequest(rawUrl: string, opts: GuardedRequestOptions = {}): Promise<GuardedResponse> {
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const allowPrivate = opts.allowPrivate === true;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return Promise.resolve({ ok: false, refusal: "bad_url", detail: "not a URL" });
  }
  if (u.username || u.password) return Promise.resolve({ ok: false, refusal: "bad_url", detail: "credentials in a URL are refused" });
  if (u.protocol !== "https:" && !(u.protocol === "http:" && allowPrivate)) {
    return Promise.resolve({ ok: false, refusal: "not_https", detail: `${u.protocol} is refused, https only` });
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!allowPrivate && isIpLiteral(host) && isBlockedTarget(host)) {
    return Promise.resolve({ ok: false, refusal: "blocked", detail: `blocked target (private/loopback): ${host}` });
  }
  const transport = u.protocol === "http:" ? http : https;
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: GuardedResponse) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const req = transport.request(u, { method: opts.method ?? "GET", headers: opts.headers ?? {}, lookup: guardedLookup(allowPrivate) }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        if (size >= maxBytes) return;
        size += chunk.length;
        if (size > maxBytes && opts.overflow !== "truncate") {
          req.destroy();
          return done({ ok: false, refusal: "too_large", detail: `more than ${maxBytes} bytes` });
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
        done({ ok: true, status: res.statusCode ?? 0, body: Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8"), headers });
      });
      res.on("error", (err) => done({ ok: false, refusal: "unreachable", detail: err.message }));
    });
    // One deadline for the whole exchange, DNS through the last byte. `req.setTimeout` would only
    // bound idle gaps, so a server dripping a byte a second could hold the request open for hours.
    const deadline = setTimeout(() => {
      done({ ok: false, refusal: "timeout", detail: `timeout after ${timeoutMs}ms` });
      req.destroy();
    }, timeoutMs);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", (err) => done({ ok: false, refusal: err.message.startsWith("blocked target") ? "blocked" : "unreachable", detail: err.message }));
    req.end(opts.body);
  });
}

/**
 * `guardedRequest` behind the `fetch` signature, for code that already speaks fetch. A refusal
 * throws, as a network failure does, so a caller's existing failure path handles it unchanged.
 */
export function guardedFetch(defaults: Pick<GuardedRequestOptions, "timeoutMs" | "maxBytes" | "allowPrivate"> = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const method = req.method.toUpperCase();
    if (method !== "GET" && method !== "POST") throw new TypeError(`guardedFetch sends GET and POST only, not ${method}`);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    const r = await guardedRequest(req.url, {
      method,
      headers,
      ...(method === "POST" ? { body: await req.text() } : {}),
      timeoutMs: defaults.timeoutMs ?? 10_000,
      maxBytes: defaults.maxBytes ?? 1024 * 1024,
      ...(defaults.allowPrivate ? { allowPrivate: true } : {}),
    });
    if (!r.ok) throw new TypeError(`request to ${new URL(req.url).origin} refused (${r.refusal}): ${r.detail}`);
    const out = new Headers();
    for (const [k, v] of Object.entries(r.headers)) if (k !== "set-cookie") out.set(k, v);
    return new Response(r.status === 204 || r.status === 304 ? null : r.body, { status: r.status, headers: out });
  }) as typeof fetch;
}
