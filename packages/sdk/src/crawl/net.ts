/**
 * crawl/net.ts — the SSRF guard for the crawler's network seam.
 *
 * `naulon crawl` fetches whatever URL an adapter derives from a publisher's origin
 * (feed paths, `/wp-json`, sitemap `<loc>`s). Without a guard that is a pointable-at-
 * anything footgun: a hostile or misconfigured feed could name `http://169.254.169.254`
 * (cloud metadata) or `http://10.0.0.5` (an internal service) and the crawler would
 * happily fetch it. So every connection is CIDR-checked against the private/loopback/
 * link-local ranges, and — because a plain check-then-connect leaves a DNS-rebind window
 * — the socket connects through `guardedLookup`, which validates the ACTUAL resolved IP.
 *
 * This is a standalone port of the cloud webhook sender's SSRF machinery, with no cloud
 * dependencies, so the open-source gate carries the same threat model as the hosted one.
 */
import { lookup as dnsLookupCb } from "node:dns";
import type { LookupFunction } from "node:net";

/** Parse a dotted-quad IPv4 literal to its 32-bit int, or null if it isn't one. */
function ipToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
}

// [networkInt, maskBits] — the private/loopback/link-local v4 ranges.
const PRIVATE_V4: ReadonlyArray<[number, number]> = [
  [ipToInt("127.0.0.0")!, 8], // loopback
  [ipToInt("10.0.0.0")!, 8], // private
  [ipToInt("172.16.0.0")!, 12], // private
  [ipToInt("192.168.0.0")!, 16], // private
  [ipToInt("169.254.0.0")!, 16], // link-local (incl. 169.254.169.254 cloud metadata)
  [ipToInt("0.0.0.0")!, 8], // "this" network
  [ipToInt("100.64.0.0")!, 10], // CGNAT
];

function isPrivateV4(ipInt: number): boolean {
  return PRIVATE_V4.some(([net, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipInt & mask) === (net & mask);
  });
}

function isBlockedV6(ip: string): boolean {
  const h = ip.toLowerCase();
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  if (h.startsWith("fe80")) return true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique-local fc00::/7
  // IPv4-mapped (::ffff:a.b.c.d) — unwrap and check as v4.
  const mapped = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) {
    const v4 = ipToInt(mapped[1]!);
    return v4 !== null && isPrivateV4(v4);
  }
  return false;
}

/** True if `host` is a literal IP in a blocked range. A DNS name is NOT blocked here —
 *  it has no literal to check; `guardedLookup` validates the resolved IP at connect time. */
export function isBlockedTarget(host: string): boolean {
  const v4 = ipToInt(host);
  if (v4 !== null) return isPrivateV4(v4);
  if (host.includes(":")) return isBlockedV6(host);
  return false;
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
