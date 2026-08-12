// src/webhooks/sender.ts — the outbound HTTP seam for webhook deliveries. Mirrors EmailSender:
// NoopWebhookSender ("off", the safe default — compute but never send) + HttpWebhookSender
// ("live"). The send path is single, with three type-conditional branches: transform (channel),
// sign (raw only), and target validation (CIDR SSRF guard for raw / host-allowlist for chat).
//
// Security (design §6): raw targets are SSRF-guarded — the host is resolved and any loopback /
// private / link-local IP (incl. the cloud metadata 169.254.169.254) is rejected; a blocked target
// is a NON-retryable failure. Chat targets must match a provider host allowlist (exact or dot-
// suffix), and are STILL resolve-checked (belt-and-braces against a poisoned DNS answer). The
// `allowPrivateTargets` knob only ever relaxes raw (local catchers in dev) — never chat.

import { lookup } from "node:dns/promises";
import { lookup as dnsLookupCb } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { signPayload } from "@naulon/sdk";
import { renderWire, type CanonicalEvent } from "./transform.ts";
import type { WebhookChannelType, WebhookEventType } from "./types.ts";

export interface SendResult {
  ok: boolean;
  statusCode?: number;
  body?: string;
  error?: string;
  /** A permanent, non-retryable reject (SSRF / disallowed host / non-https discovered at send). */
  blocked?: boolean;
  /** Parsed from a 429 Retry-After — the floor for the next attempt's delay. */
  retryAfterMs?: number;
}

export interface WebhookSender {
  readonly kind: string;
  send(
    channelType: WebhookChannelType,
    eventType: WebhookEventType | "ping",
    url: string,
    secret: string,
    deliveryId: string,
    canonical: CanonicalEvent,
    nowMs: number,
  ): Promise<SendResult>;
}

/* ── SSRF guard (raw) ─────────────────────────────────────────────────────────── */

function ipToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
}

// [networkInt, maskBits] — the private/loopback/link-local v4 ranges (design §6).
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

/** True if `host` is a literal IP in a blocked range. (DNS names are resolved by guardTarget.) */
export function isBlockedTarget(host: string): boolean {
  const v4 = ipToInt(host);
  if (v4 !== null) return isPrivateV4(v4);
  if (host.includes(":")) return isBlockedV6(host);
  return false; // a hostname — not a literal; resolved-and-checked in guardTarget
}

async function resolvePrivateCheck(
  host: string,
  allowPrivate: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (allowPrivate) return { ok: true };
  if (isBlockedTarget(host)) return { ok: false, error: `blocked target (private/loopback): ${host}` };
  // A hostname: resolve and reject if ANY answer is in a blocked range.
  if (ipToInt(host) === null && !host.includes(":")) {
    let addrs: { address: string }[];
    try {
      addrs = await lookup(host, { all: true });
    } catch {
      return { ok: false, error: `dns resolution failed: ${host}` };
    }
    for (const a of addrs) {
      if (isBlockedTarget(a.address)) return { ok: false, error: `resolves to a blocked address: ${a.address}` };
    }
  }
  return { ok: true };
}

/* ── chat host allowlist ──────────────────────────────────────────────────────── */

export const CHAT_HOST_ALLOWLIST: Record<Exclude<WebhookChannelType, "raw">, readonly string[]> = {
  slack: ["hooks.slack.com"],
  discord: ["discord.com", "discordapp.com"],
  teams: [".logic.azure.com"], // leading "." ⇒ dot-suffix match (subdomains only)
};

export function isAllowedChatHost(ct: WebhookChannelType, host: string): boolean {
  if (ct === "raw") return true;
  const h = host.toLowerCase();
  return CHAT_HOST_ALLOWLIST[ct].some((a) => (a.startsWith(".") ? h.endsWith(a) : h === a));
}

/** Validate a delivery target by channel: raw → https + SSRF CIDR; chat → https + host allowlist +
 *  (still) the private-IP resolve check. Returns ok or a reason. */
export async function guardTarget(
  ct: WebhookChannelType,
  url: string,
  allowPrivate: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "invalid url" };
  }
  if (parsed.protocol !== "https:") return { ok: false, error: "url must be https" };
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (ct !== "raw") {
    if (!isAllowedChatHost(ct, host)) return { ok: false, error: `host not allowed for ${ct}: ${host}` };
    // allowPrivate never relaxes chat — pass false (defense in depth).
    return resolvePrivateCheck(host, false);
  }
  return resolvePrivateCheck(host, allowPrivate);
}

/* ── Retry-After parsing ──────────────────────────────────────────────────────── */

function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  return undefined;
}

/* ── anti-DNS-rebinding: a connect-time guarded lookup (no TOCTOU) ─────────────── */

// guardTarget resolves-and-checks the host, but a plain fetch then RE-RESOLVES at connect — a
// malicious customer domain can rebind between the two (return a public IP to the check, a private
// IP to the connect). The fix: make the lookup the socket ACTUALLY uses the one that enforces the
// guard. node http(s).request honors a `lookup` option, so the validated IP is the connected IP —
// the check/connect window is closed. allowPrivate (raw-only dev knob) relaxes it; chat passes false.
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

const MAX_BODY = 2048;

interface RawResponse {
  status: number;
  retryAfter: string | null;
  body: string;
}

/** POST via node http(s) with the connect-time guarded lookup (the TOCTOU-safe real path). The URL
 *  stays hostname-based so TLS SNI/cert validation is unaffected; only the resolved-and-validated IP
 *  is connected to. node never auto-follows redirects, so a 3xx is returned, not chased. */
function postViaNode(
  urlStr: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  allowPrivate: boolean,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(urlStr);
    } catch {
      return reject(new Error("invalid url"));
    }
    const transport = u.protocol === "http:" ? http : https;
    const req = transport.request(
      urlStr,
      { method: "POST", headers, lookup: guardedLookup(allowPrivate) },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          if (data.length < MAX_BODY) data += c;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            retryAfter: (res.headers["retry-after"] as string | undefined) ?? null,
            body: data.slice(0, MAX_BODY),
          }),
        );
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end(body);
  });
}

/* ── senders ──────────────────────────────────────────────────────────────────── */

export class NoopWebhookSender implements WebhookSender {
  readonly kind = "off";
  async send(
    _channelType: WebhookChannelType,
    _eventType: WebhookEventType | "ping",
    _url: string,
    _secret: string,
    _deliveryId: string,
    _canonical: CanonicalEvent,
    _nowMs: number,
  ): Promise<SendResult> {
    return { ok: false, error: "webhook backend off" };
  }
}

export class HttpWebhookSender implements WebhookSender {
  readonly kind = "live";
  constructor(
    private readonly opts: { timeoutMs: number; allowPrivateTargets: boolean; fetchImpl?: typeof fetch },
  ) {}

  async send(
    channelType: WebhookChannelType,
    eventType: WebhookEventType | "ping",
    url: string,
    secret: string,
    deliveryId: string,
    canonical: CanonicalEvent,
    nowMs: number,
  ): Promise<SendResult> {
    const g = await guardTarget(channelType, url, this.opts.allowPrivateTargets);
    if (!g.ok) return { ok: false, error: g.error, blocked: true };

    const { body } = renderWire(channelType, eventType, canonical);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "naulon-webhooks/1",
    };
    if (channelType === "raw") {
      headers["Naulon-Signature"] = signPayload(secret, body, Math.floor(nowMs / 1000));
      headers["Naulon-Id"] = deliveryId;
      headers["Naulon-Event"] = eventType;
    }

    // Injected fetch (tests/fakes) keeps the fetch path — TOCTOU is irrelevant for a stubbed impl.
    // The REAL path (no fetchImpl) goes through postViaNode with the connect-time guarded lookup so a
    // DNS rebind between guardTarget's check and the actual connect cannot reach a private IP.
    if (this.opts.fetchImpl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      try {
        const res = await this.opts.fetchImpl(url, {
          method: "POST",
          headers,
          body,
          redirect: "manual",
          signal: controller.signal,
        });
        const text = (await res.text().catch(() => "")).slice(0, MAX_BODY);
        if (res.status === 429) {
          return {
            ok: false,
            statusCode: 429,
            body: text,
            error: "rate limited (429)",
            retryAfterMs: parseRetryAfter(res.headers.get("retry-after"), nowMs),
          };
        }
        if (res.status >= 200 && res.status < 300) {
          return { ok: true, statusCode: res.status, body: text };
        }
        return { ok: false, statusCode: res.status, body: text, error: `non-2xx: ${res.status}` };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: controller.signal.aborted ? `timeout after ${this.opts.timeoutMs}ms` : msg };
      } finally {
        clearTimeout(timer);
      }
    }

    try {
      const r = await postViaNode(url, headers, body, this.opts.timeoutMs, this.opts.allowPrivateTargets);
      if (r.status === 429) {
        return { ok: false, statusCode: 429, body: r.body, error: "rate limited (429)", retryAfterMs: parseRetryAfter(r.retryAfter, nowMs) };
      }
      if (r.status >= 200 && r.status < 300) return { ok: true, statusCode: r.status, body: r.body };
      return { ok: false, statusCode: r.status, body: r.body, error: `non-2xx: ${r.status}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // A connect-time guarded-lookup rejection (the rebind race) is a permanent, non-retryable block.
      const blocked = msg.includes("blocked target (private/loopback)");
      return blocked ? { ok: false, error: msg, blocked: true } : { ok: false, error: msg };
    }
  }
}
