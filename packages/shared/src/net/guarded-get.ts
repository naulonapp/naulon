/**
 * One GET to a URL somebody else chose: a client's metadata document, or the challenge a site
 * serves to prove it is running the code that asked to connect.
 *
 * Every refusal happens before a byte of the response is trusted:
 *   https only, unless the caller is itself on loopback (a local walk);
 *   the address is resolved and checked at connect time (`guardedLookup`), so a name cannot pass
 *   the check as a public address and then connect to a private one;
 *   a redirect is returned as a refusal, never followed;
 *   the body is capped and the whole exchange has a deadline.
 */
import http from "node:http";
import https from "node:https";
import { guardedLookup, isBlockedTarget, isIpLiteral } from "@naulon/sdk/net";
import { isLoopbackHost } from "../connect/discovery.ts";

export type GuardedGetRefusal = "bad_url" | "not_https" | "blocked" | "redirect" | "too_large" | "timeout" | "unreachable";

export type GuardedGet =
  | { ok: true; status: number; body: string; contentType: string; cacheControl: string | null }
  | { ok: false; refusal: GuardedGetRefusal; detail: string };

export interface GuardedGetOptions {
  maxBytes?: number;
  timeoutMs?: number;
  /** Allow a loopback target over plain http. Pass true only when this process is itself a local walk. */
  allowLoopback?: boolean;
  accept?: string;
}

export function guardedGet(rawUrl: string, opts: GuardedGetOptions = {}): Promise<GuardedGet> {
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return Promise.resolve({ ok: false, refusal: "bad_url", detail: "not a URL" });
  }
  if (u.username || u.password) return Promise.resolve({ ok: false, refusal: "bad_url", detail: "credentials in a URL are refused" });
  const loopback = isLoopbackHost(u.hostname);
  const local = loopback && opts.allowLoopback === true;
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    return Promise.resolve({ ok: false, refusal: "not_https", detail: `${u.protocol} is refused, https only` });
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!local && isIpLiteral(host) && isBlockedTarget(host)) {
    return Promise.resolve({ ok: false, refusal: "blocked", detail: "a private or reserved address" });
  }
  const transport = u.protocol === "http:" ? http : https;
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: GuardedGet) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const req = transport.request(
      u,
      {
        method: "GET",
        headers: { accept: opts.accept ?? "application/json", "user-agent": "naulon-connect/1" },
        lookup: guardedLookup(local),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return done({ ok: false, refusal: "redirect", detail: `answered ${status}; redirects are not followed` });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy();
            return done({ ok: false, refusal: "too_large", detail: `more than ${maxBytes} bytes` });
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          done({
            ok: true,
            status,
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: String(res.headers["content-type"] ?? ""),
            cacheControl: (res.headers["cache-control"] as string | undefined) ?? null,
          }),
        );
        res.on("error", (err) => done({ ok: false, refusal: "unreachable", detail: err.message }));
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done({ ok: false, refusal: "timeout", detail: `no answer within ${timeoutMs} ms` });
    });
    req.on("error", (err) => {
      const blocked = /blocked|private|reserved/i.test(err.message);
      done({ ok: false, refusal: blocked ? "blocked" : "unreachable", detail: err.message });
    });
    req.end();
  });
}
