import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { guardedFetch, guardedRequest, isBlockedTarget, isLoopbackHostname } from "./net.ts";

test("isBlockedTarget blocks loopback v4", () => {
  assert.equal(isBlockedTarget("127.0.0.1"), true);
  assert.equal(isBlockedTarget("127.5.6.7"), true);
});

test("isBlockedTarget blocks the RFC1918 private ranges", () => {
  assert.equal(isBlockedTarget("10.0.0.1"), true);
  assert.equal(isBlockedTarget("172.16.0.1"), true);
  assert.equal(isBlockedTarget("172.31.255.255"), true);
  assert.equal(isBlockedTarget("192.168.1.1"), true);
});

test("isBlockedTarget blocks 172.x OUTSIDE the /12 as public", () => {
  // 172.15 and 172.32 are public — the mask must be /12, not a naive /16.
  assert.equal(isBlockedTarget("172.15.0.1"), false);
  assert.equal(isBlockedTarget("172.32.0.1"), false);
});

test("isBlockedTarget blocks link-local incl. the cloud metadata IP", () => {
  assert.equal(isBlockedTarget("169.254.0.1"), true);
  assert.equal(isBlockedTarget("169.254.169.254"), true); // AWS/GCP metadata
});

test("isBlockedTarget blocks the 'this' network and CGNAT", () => {
  assert.equal(isBlockedTarget("0.0.0.0"), true);
  assert.equal(isBlockedTarget("100.64.0.1"), true);
  assert.equal(isBlockedTarget("100.127.255.255"), true);
  assert.equal(isBlockedTarget("100.63.255.255"), false); // just below CGNAT
});

test("isBlockedTarget passes ordinary public v4", () => {
  assert.equal(isBlockedTarget("8.8.8.8"), false);
  assert.equal(isBlockedTarget("1.1.1.1"), false);
});

test("isBlockedTarget blocks v6 loopback / unspecified / link-local / ULA", () => {
  assert.equal(isBlockedTarget("::1"), true);
  assert.equal(isBlockedTarget("::"), true);
  assert.equal(isBlockedTarget("fe80::1"), true);
  assert.equal(isBlockedTarget("fc00::1"), true);
  assert.equal(isBlockedTarget("fd12:3456::1"), true);
});

test("isBlockedTarget unwraps IPv4-mapped v6 and checks as v4", () => {
  assert.equal(isBlockedTarget("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedTarget("::ffff:8.8.8.8"), false);
});

test("isBlockedTarget returns false for a hostname (resolved elsewhere)", () => {
  // A DNS name is not a literal IP — the connect-time guarded lookup checks it.
  assert.equal(isBlockedTarget("example.com"), false);
  assert.equal(isBlockedTarget("localhost"), false);
});

test("isLoopbackHostname: this machine and nothing else", () => {
  for (const h of ["localhost", "LOCALHOST", "127.0.0.1", "127.8.9.10", "::1", "[::1]"]) assert.equal(isLoopbackHostname(h), true, h);
  for (const h of ["10.0.0.1", "128.0.0.1", "localhost.example.com", "example.com", "::2", "0.0.0.0"]) assert.equal(isLoopbackHostname(h), false, h);
});

async function fixture() {
  const server = createServer((req, res) => {
    if (req.url === "/redirect") return res.writeHead(302, { location: "http://169.254.169.254/" }).end();
    if (req.url === "/big") return res.end("x".repeat(70_000));
    if (req.url === "/slow") return setTimeout(() => res.end("late"), 500);
    if (req.url === "/echo") {
      let body = "";
      req.on("data", (c) => (body += c));
      return req.on("end", () => res.writeHead(201, { "x-method": req.method ?? "" }).end(body));
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=60" }).end('{"a":1}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const refusal = (r: Awaited<ReturnType<typeof guardedRequest>>) => (r.ok ? `answered ${r.status}` : r.refusal);

test("guardedRequest refuses before connecting: plain http, a private literal, credentials in the URL", async () => {
  assert.equal(refusal(await guardedRequest("http://example.com/")), "not_https");
  assert.equal(refusal(await guardedRequest("https://127.0.0.1/")), "blocked");
  assert.equal(refusal(await guardedRequest("https://10.0.0.1/")), "blocked");
  assert.equal(refusal(await guardedRequest("https://[::1]/")), "blocked");
  assert.equal(refusal(await guardedRequest("https://u:p@example.com/")), "bad_url");
  assert.equal(refusal(await guardedRequest("not a url")), "bad_url");
});

test("guardedRequest: a redirect comes back as its status, a big body is refused or cut, a slow one times out", async () => {
  const s = await fixture();
  try {
    const ok = await guardedRequest(`${s.url}/`, { allowPrivate: true });
    assert.equal(ok.ok && ok.body, '{"a":1}');
    assert.equal(ok.ok && ok.headers["cache-control"], "max-age=60");
    const moved = await guardedRequest(`${s.url}/redirect`, { allowPrivate: true });
    assert.equal(moved.ok && moved.status, 302, "returned, never followed");
    assert.equal(refusal(await guardedRequest(`${s.url}/big`, { allowPrivate: true })), "too_large");
    const cut = await guardedRequest(`${s.url}/big`, { allowPrivate: true, maxBytes: 1000, overflow: "truncate" });
    assert.equal(cut.ok && cut.body.length, 1000);
    assert.equal(refusal(await guardedRequest(`${s.url}/slow`, { allowPrivate: true, timeoutMs: 100 })), "timeout");
    const posted = await guardedRequest(`${s.url}/echo`, { method: "POST", body: "a=1", allowPrivate: true });
    assert.equal(posted.ok && `${posted.status} ${posted.headers["x-method"]} ${posted.body}`, "201 POST a=1");
  } finally {
    await s.close();
  }
});

test("guardedFetch speaks fetch, and a refusal throws the way a network failure does", async () => {
  const s = await fixture();
  try {
    const f = guardedFetch({ allowPrivate: true });
    const res = await f(`${s.url}/echo`, { method: "POST", body: "hi" });
    assert.equal(res.status, 201);
    assert.equal(await res.text(), "hi");
    await assert.rejects(guardedFetch()(`${s.url}/`), /refused \(not_https\)/);
    await assert.rejects(f(`${s.url}/`, { method: "PUT" }), /GET and POST only/);
  } finally {
    await s.close();
  }
});
