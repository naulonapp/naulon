/**
 * With NAULON_PLATFORM_URL and NAULON_PLATFORM_KEY set, a gate with no injected resolver asks the
 * platform which publisher each Host is.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = "platform-enforce-key-0123456789abcdef0123";
process.env.EVENTS_PATH = join(tmpdir(), `naulon-platform-${process.pid}.jsonl`);
process.env.OBSERVATIONS_BACKEND = "jsonl";
process.env.OBSERVATIONS_PATH = join(tmpdir(), `naulon-platform-obs-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";
process.env.NAULON_ENFORCE_KEY = KEY;
process.env.NAULON_PLATFORM_URL = "https://platform.example/naulon/publisher";
process.env.NAULON_PLATFORM_KEY = "platform-secret";

const { createApp } = await import("./app.ts");
const app = createApp();

const asked: string[] = [];
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://platform.example/")) {
      asked.push(`${url} ${new Headers(init?.headers).get("authorization")}`);
      const host = new URL(url).searchParams.get("host");
      if (host !== "blog-one.example") return new Response("", { status: 404 });
      return Response.json({ id: "blog-1", hosts: ["blog-one.example"], originUrl: "https://blog-one.example", articlePrefixes: [], priceMicro: 5000, defaultPayoutAddress: "0x00000000000000000000000000000000000000a1" });
    }
    return new Response("<html>origin</html>", { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });

const config = (host: string) =>
  app.request(`/_naulon/enforce-config?resource=${encodeURIComponent(`https://${host}/hello/`)}`, { headers: { host, authorization: `Bearer ${KEY}` } });

test("with NAULON_PLATFORM_URL and NAULON_PLATFORM_KEY set the gate resolves hosts over HTTP", async () => {
  const res = await config("blog-one.example");
  assert.equal(res.status, 200);
  assert.ok(asked.some((a) => a === "https://platform.example/naulon/publisher?host=blog-one.example Bearer platform-secret"));
});

test("a host the platform does not toll is refused, never answered with another blog's config", async () => {
  const res = await config("blog-two.example");
  assert.equal(res.status, 403);
  assert.ok(!(await res.text()).includes("blog-1"));
});
