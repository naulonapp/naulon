import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { MiddlewareResult } from "./middleware.ts";
import { naulonNode } from "./node.ts";
import { sdkClientIp } from "./clientIp.ts";

async function serve(core: (req: Request) => Promise<MiddlewareResult>, opts = {}): Promise<{ url: string; seen: Request[]; server: Server }> {
  const seen: Request[] = [];
  const toll = naulonNode(async (req) => {
    seen.push(req);
    return core(req);
  }, opts);
  const server = createServer((req, res) =>
    toll(req, res, () => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => res.writeHead(200, { "content-type": "text/plain" }).end(`page ${req.method} ${body}`));
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

test("a refusal is answered with its status, headers and body; the page never runs", async () => {
  const s = await serve(async () => ({ response: new Response('{"x402":1}', { status: 402, headers: { "payment-required": "abc", "content-type": "application/json" } }) }));
  try {
    const res = await fetch(`${s.url}/essays/x`);
    assert.equal(res.status, 402);
    assert.equal(res.headers.get("payment-required"), "abc");
    assert.equal(await res.text(), '{"x402":1}');
  } finally {
    await close(s.server);
  }
});

test("a pass reaches the page with the receipt headers, and the body is left for the route", async () => {
  const s = await serve(async () => ({ response: null, setHeaders: { "payment-response": "paid" } }));
  try {
    const res = await fetch(`${s.url}/essays/x`, { method: "POST", body: "hello" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("payment-response"), "paid");
    assert.equal(await res.text(), "page POST hello");
  } finally {
    await close(s.server);
  }
});

test("the core sees the real URL, every header, and the socket's address, which no header can forge", async () => {
  const s = await serve(async () => ({ response: null }));
  try {
    await fetch(`${s.url}/essays/x?q=1`, { headers: { "user-agent": "GPTBot/1.0", "x-forwarded-for": "6.6.6.6" } });
    const req = s.seen[0]!;
    assert.equal(new URL(req.url).pathname + new URL(req.url).search, "/essays/x?q=1");
    assert.equal(req.headers.get("user-agent"), "GPTBot/1.0");
    assert.equal(sdkClientIp(req, undefined, {}), "127.0.0.1");
    assert.equal(sdkClientIp(req, "none", {}), null);
  } finally {
    await close(s.server);
  }
});

test("the scheme comes from X-Forwarded-Proto only when told to trust it", async () => {
  const plain = await serve(async () => ({ response: null }));
  const proxied = await serve(async () => ({ response: null }), { trustProxyScheme: true });
  try {
    await fetch(`${plain.url}/`, { headers: { "x-forwarded-proto": "https" } });
    await fetch(`${proxied.url}/`, { headers: { "x-forwarded-proto": "https" } });
    assert.equal(new URL(plain.seen[0]!.url).protocol, "http:");
    assert.equal(new URL(proxied.seen[0]!.url).protocol, "https:");
  } finally {
    await Promise.all([close(plain.server), close(proxied.server)]);
  }
});

test("a core that throws serves the page and says so", async () => {
  const original = console.error;
  const said: string[] = [];
  console.error = (m: string) => void said.push(m);
  const s = await serve(async () => {
    throw new Error("boom");
  });
  try {
    const res = await fetch(`${s.url}/essays/x`);
    assert.equal(res.status, 200);
    assert.match(said[0] ?? "", /the toll failed and the page was served: boom/);
  } finally {
    console.error = original;
    await close(s.server);
  }
});
