/**
 * Address and prefix math for the crawler identity check. BigInt for both families so one code
 * path serves IPv4 and IPv6; an IPv4-mapped IPv6 address (::ffff:a.b.c.d) is normalised to IPv4,
 * because the same caller can reach a runtime in either spelling.
 */

export type IpFamily = 4 | 6;
export interface ParsedIp {
  readonly family: IpFamily;
  readonly value: bigint;
}
export interface Cidr {
  readonly family: IpFamily;
  readonly start: bigint;
  readonly end: bigint;
}

/** A prefix broader than this cannot be one crawler's address space; it is a broken or hostile file. */
export const MIN_PREFIX_V4 = 12;
export const MIN_PREFIX_V6 = 28;

const BITS: Record<IpFamily, bigint> = { 4: 32n, 6: 128n };
const LOW32 = 0xffffffffn;

function parseV4(s: string): bigint | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let v = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = (v << 8n) | BigInt(n);
  }
  return v;
}

function parseV6(input: string): bigint | null {
  let s = input;
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  let tail: bigint | null = null;
  if (s.includes(".")) {
    const lastColon = s.lastIndexOf(":");
    if (lastColon < 0) return null;
    tail = parseV4(s.slice(lastColon + 1));
    if (tail === null) return null;
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups: string[];
  if (halves.length === 2) {
    if (head.length + rest.length > 7) return null;
    groups = [...head, ...new Array<string>(8 - head.length - rest.length).fill("0"), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  if (tail !== null) v = (v & ~LOW32) | tail;
  return v;
}

function parseRaw(input: string): ParsedIp | null {
  let s = input.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (s.length === 0) return null;
  if (s.includes(":")) {
    const v = parseV6(s);
    return v === null ? null : { family: 6, value: v };
  }
  const v = parseV4(s);
  return v === null ? null : { family: 4, value: v };
}

function isMapped(ip: ParsedIp): boolean {
  return ip.family === 6 && ip.value >> 32n === 0xffffn;
}

export function parseIp(s: string): ParsedIp | null {
  const ip = parseRaw(s);
  if (ip && isMapped(ip)) return { family: 4, value: ip.value & LOW32 };
  return ip;
}

/**
 * A caller's address as a header carries it, which is looser than an address: RFC 7239 quotes it,
 * brackets an IPv6, and lets either carry a port, and some platforms (Azure's X-Forwarded-For) send
 * `a.b.c.d:port` bare. The port names the caller's socket, not a different caller, so it is dropped.
 */
export function parseClientAddress(s: string): ParsedIp | null {
  let v = s.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).trim();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(v);
  if (bracketed) return parseIp(bracketed[1]!);
  const v4Port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(v);
  if (v4Port) return parseIp(v4Port[1]!);
  return parseIp(v);
}

export function parseCidr(s: string, opts?: { minV4?: number; minV6?: number }): Cidr | null {
  const slash = s.indexOf("/");
  if (slash < 0) return null;
  const lenStr = s.slice(slash + 1).trim();
  if (!/^\d{1,3}$/.test(lenStr)) return null;
  let bits = Number(lenStr);
  let ip = parseRaw(s.slice(0, slash));
  if (!ip) return null;
  if (isMapped(ip) && bits >= 96) {
    ip = { family: 4, value: ip.value & LOW32 };
    bits -= 96;
  }
  const total = BITS[ip.family];
  if (bits > Number(total)) return null;
  const min = ip.family === 4 ? (opts?.minV4 ?? MIN_PREFIX_V4) : (opts?.minV6 ?? MIN_PREFIX_V6);
  if (bits < min) return null;
  const host = (1n << (total - BigInt(bits))) - 1n;
  const start = ip.value & ~host & ((1n << total) - 1n);
  return { family: ip.family, start, end: start | host };
}

type Interval = readonly [bigint, bigint];

function merge(list: Interval[]): Interval[] {
  list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out: Array<[bigint, bigint]> = [];
  for (const [s, e] of list) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1n) {
      if (e > last[1]) last[1] = e;
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

function search(list: readonly Interval[], v: bigint): boolean {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const iv = list[mid]!;
    if (v < iv[0]) hi = mid - 1;
    else if (v > iv[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

export class RangeSet {
  private readonly v4: readonly Interval[];
  private readonly v6: readonly Interval[];

  constructor(cidrs: Iterable<Cidr>) {
    const a: Interval[] = [];
    const b: Interval[] = [];
    for (const c of cidrs) (c.family === 4 ? a : b).push([c.start, c.end]);
    this.v4 = merge(a);
    this.v6 = merge(b);
  }

  get size(): number {
    return this.v4.length + this.v6.length;
  }

  has(ip: ParsedIp): boolean {
    return search(ip.family === 4 ? this.v4 : this.v6, ip.value);
  }

  static fromStrings(list: readonly string[], opts?: { minV4?: number; minV6?: number }): { set: RangeSet; rejected: number } {
    const ok: Cidr[] = [];
    let rejected = 0;
    for (const s of list) {
      const c = parseCidr(s, opts);
      if (c) ok.push(c);
      else rejected++;
    }
    return { set: new RangeSet(ok), rejected };
  }
}

/** Never a caller's own address: loopback, private, CGNAT, link-local, documentation, multicast, reserved. */
const RESERVED = RangeSet.fromStrings(
  [
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
    "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24",
    "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
    "::/128", "::1/128", "64:ff9b::/96", "100::/64", "2001:db8::/32", "fc00::/7", "fe80::/10", "ff00::/8",
  ],
  { minV4: 0, minV6: 0 },
).set;

/**
 * True when `ip` can be a caller's own public address. A proxy's address is not: `proxies` holds
 * the ranges of CDNs and proxies, and an address inside one is the proxy speaking, not the caller.
 */
export function isUsablePublicIp(ip: ParsedIp, proxies: readonly RangeSet[] = []): boolean {
  if (RESERVED.has(ip)) return false;
  return !proxies.some((r) => r.has(ip));
}

function formatV4(v: bigint): string {
  return [24n, 16n, 8n, 0n].map((s) => String((v >> s) & 0xffn)).join(".");
}

/** The /24 or /48 an address sits in: enough to tell operators apart, not enough to name a host. */
export function truncateIp(ip: ParsedIp): string {
  if (ip.family === 4) return `${formatV4(ip.value & ~0xffn & LOW32)}/24`;
  const top = ip.value >> 80n;
  const groups = [32n, 16n, 0n].map((s) => ((top >> s) & 0xffffn).toString(16));
  return `${groups.join(":")}::/48`;
}
