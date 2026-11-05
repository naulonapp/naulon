/**
 * Connect, end to end, over real sockets: a gate, its console and a site are three servers on
 * loopback, sharing nothing but the gate's state store (which the gate and its console share in
 * production too). The browser is played by following redirects by hand.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import type { PublisherConfig } from "@naulon/shared";
import { siteCredentialAuth } from "../../../tollgate/src/connect/auth.ts";
import { startConnectWorld } from "../../../../conformance/connect-world.ts";
import { memoryConnectStore, naulonConnect } from "./connect.ts";
import { guardedRequest } from "@naulon/sdk/net";

async function listen(app: Hono): Promise<{ origin: string; server: ServerType }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve({ origin: `http://127.0.0.1:${info.port}`, server }));
  });
}
const close = (s: ServerType) => new Promise<void>((r) => s.close(() => r()));

async function world() {
  const gate = await startConnectWorld();
  const { state } = gate;
  const consoleSrv = { origin: gate.origins.console };
  const gateSrv = { origin: gate.origins.gate };

  // The site: the connect client in front, a settings button and the return page behind it.
  let connect!: ReturnType<typeof naulonConnect>;
  const siteApp = new Hono();
  siteApp.use("*", async (c, next) => {
    const answered = await connect.wellKnown(c.req.raw);
    if (answered) return answered;
    await next();
  });
  const saved: { site?: string; gate?: string; credential?: string; error?: string } = {};
  siteApp.get("/naulon/connect/return", async (c) => {
    const r = await connect.finish(new URL(c.req.url).searchParams);
    if (r.ok) Object.assign(saved, { site: r.site, gate: r.gate, credential: r.credential });
    else saved.error = r.error;
    return c.text(r.ok ? "connected" : r.message);
  });
  const siteSrv = await listen(siteApp);
  const store = memoryConnectStore();
  connect = naulonConnect({ clientName: "Test blog", gate: gateSrv.origin, store });

  return {
    state,
    store,
    connect,
    saved,
    origins: { console: consoleSrv.origin, gate: gateSrv.origin, site: siteSrv.origin },
    close: async () => Promise.all([gate.close(), close(siteSrv.server)]),
  };
}

/** The owner's browser: open the approve page, press a button, follow the redirect home. */
async function owner(url: string, decision: "approve" | "deny") {
  // The console's own Continue: a local console fetches nothing for a cross-site arrival.
  const page = await fetch(url, { headers: { "sec-fetch-site": "same-origin" } });
  const html = await page.text();
  const fields = new URLSearchParams();
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields.set(m[1]!, m[2]!.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
  }
  fields.set("decision", decision);
  const posted = await fetch(new URL("/connect/authorize", url), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
    body: fields.toString(),
  });
  return { page, html, posted, home: posted.headers.get("location") };
}

const resolver = { resolve: async () => ({ id: "default" }) as PublisherConfig };
const asked = (credential: string) => ({ req: { header: (n: string) => (n === "authorization" ? `Bearer ${credential}` : undefined) } }) as never;

test("a site connects to a self-hosted gate, and its credential works on that site alone", async () => {
  const w = await world();
  try {
    const started = await w.connect.start({ site: w.origins.site });
    assert.equal(started.ok, true);
    const url = (started as { url: string }).url;
    assert.ok(url.startsWith(`${w.origins.console}/connect/authorize?`), url);

    const o = await owner(url, "approve");
    assert.equal(o.page.status, 200, o.html);
    assert.match(o.html, /answered this request just now/);
    assert.match(o.html, /Test blog/);
    assert.equal(o.posted.status, 303);
    assert.ok(o.home?.startsWith(`${w.origins.site}/naulon/connect/return?`), String(o.home));

    const back = await fetch(o.home!);
    assert.equal(await back.text(), "connected");
    assert.equal(w.saved.site, w.origins.site);
    assert.equal(w.saved.gate, w.origins.gate);
    assert.match(w.saved.credential!, /^nln_site_[0-9A-Za-z]{43}$/);

    const auth = siteCredentialAuth({ state: w.state, resolver });
    const host = new URL(w.origins.site).host;
    assert.deepEqual(await auth(asked(w.saved.credential!), host), { ok: true, publisherId: "default", selfHosted: true });
    assert.equal((await auth(asked(w.saved.credential!), "somebody-else.example.com")).ok, false);

    // The return link is spent: replaying it connects nothing a second time.
    assert.match(await (await fetch(o.home!)).text(), /expired or was already finished/);
  } finally {
    await w.close();
  }
});

test("Deny brings the owner home with nothing issued", async () => {
  const w = await world();
  try {
    const started = (await w.connect.start({ site: w.origins.site })) as { url: string };
    const o = await owner(started.url, "deny");
    assert.equal(o.posted.status, 303);
    await fetch(o.home!);
    assert.equal(w.saved.error, "denied");
    assert.deepEqual(await w.state.list("credential:"), []);
  } finally {
    await w.close();
  }
});

test("a connect started for someone else's site never reaches Approve", async () => {
  const w = await world();
  try {
    // A second runtime claims the first site's origin. That site's runtime never started this
    // connect, so it does not answer the challenge, and the console refuses.
    const intruder = naulonConnect({ clientName: "Not you", gate: w.origins.gate, clientId: () => `${w.origins.site}/.well-known/naulon-client` });
    const started = (await intruder.start({ site: w.origins.site })) as { url: string };
    const page = await fetch(started.url, { headers: { "sec-fetch-site": "same-origin" } });
    assert.equal(page.status, 409);
    assert.match(await page.text(), /<h1>[^<]+ did not answer<\/h1>/);
    assert.deepEqual(await w.state.list("connect.code:"), []);
  } finally {
    await w.close();
  }
});

test("a gate that is not a naulon gate is refused before the owner is sent anywhere", async () => {
  const notGate = await listen(new Hono().get("*", (c) => c.text("hello")));
  try {
    const c = naulonConnect({ clientName: "Test", gate: notGate.origin });
    const r = await c.start({ site: "https://blog.example.com" });
    assert.deepEqual(r, { ok: false, error: `${notGate.origin} is not a naulon gate` });
    const plain = await naulonConnect({ clientName: "Test", gate: "http://gate.example.com" }).start({ site: "https://blog.example.com" });
    assert.deepEqual(plain, { ok: false, error: "the gate must be an https URL" });
  } finally {
    await close(notGate.server);
  }
});

test("a gate named at runtime never reaches a private address, only the configured one may", async () => {
  const w = await world();
  try {
    // The configured gate is on loopback (a local walk): allowed.
    assert.equal((await w.connect.start({ site: w.origins.site })).ok, true);
    // The same loopback gate, but named by whoever called start() on a platform configured elsewhere.
    const platform = naulonConnect({ clientName: "Platform", gate: "https://gate.naulon.app" });
    const r = await platform.start({ site: w.origins.site, gate: w.origins.gate });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /could not be reached: (http: is refused|blocked target)/);
  } finally {
    await w.close();
  }
});

test("a return without this gate's iss is refused and leaves the connect to finish", async () => {
  const w = await world();
  try {
    const started = (await w.connect.start({ site: w.origins.site })) as { url: string };
    const o = await owner(started.url, "approve");
    const home = new URL(o.home!);
    assert.equal(home.searchParams.get("iss"), w.origins.gate, "the console names its gate");

    // A mix-up: the same code, carried back under another gate's name, or under none.
    for (const iss of ["https://evil.example.com", null]) {
      const forged = new URLSearchParams(home.searchParams);
      if (iss === null) forged.delete("iss");
      else forged.set("iss", iss);
      const r = await w.connect.finish(forged);
      assert.deepEqual(r.ok ? "ok" : r.error, "refused", String(iss));
    }
    // Nothing was exchanged or cancelled: the genuine return still works.
    assert.equal(await (await fetch(o.home!)).text(), "connected");
  } finally {
    await w.close();
  }
});

test("a connect started for one account cannot be finished by another", async () => {
  const w = await world();
  try {
    const started = (await w.connect.start({ site: w.origins.site, binding: "account-a" })) as { url: string };
    const o = await owner(started.url, "approve");
    const query = new URL(o.home!).searchParams;
    const stranger = await w.connect.finish(query, { binding: "account-b" });
    assert.equal(stranger.ok ? "ok" : stranger.error, "not_yours");
    const anonymous = await w.connect.finish(query);
    assert.equal(anonymous.ok ? "ok" : anonymous.error, "not_yours");
    const owner_ = await w.connect.finish(query, { binding: "account-a" });
    assert.equal(owner_.ok, true, "the refusals cancelled nothing");
  } finally {
    await w.close();
  }
});

test("a return page opened twice at once exchanges its code once, and the credential survives", async () => {
  const w = await world();
  try {
    const started = (await w.connect.start({ site: w.origins.site })) as { url: string };
    const o = await owner(started.url, "approve");
    const query = new URL(o.home!).searchParams;
    const [a, b] = await Promise.all([w.connect.finish(query), w.connect.finish(query)]);
    const won = [a, b].filter((r) => r.ok);
    assert.equal(won.length, 1, "exactly one finish exchanges the code");
    const credential = (won[0] as { credential: string }).credential;
    // Had both exchanged, the gate would have seen a replay and revoked this credential.
    assert.equal((await w.state.list("credential:")).length, 1);
    const status = await fetch(`${w.origins.gate}/_naulon/enforce-status`, { headers: { authorization: `Bearer ${credential}` } });
    assert.equal(status.status, 200);
  } finally {
    await w.close();
  }
});

test("a gate that cannot be reached during the exchange leaves the connect to try again", async () => {
  const w = await world();
  try {
    const started = (await w.connect.start({ site: w.origins.site })) as { url: string };
    const o = await owner(started.url, "approve");
    const query = new URL(o.home!).searchParams;
    let down = true;
    const flaky = naulonConnect({
      clientName: "Test blog",
      gate: w.origins.gate,
      store: w.store,
      request: async (url, init) => (down && String(url).includes("/connect/token") ? { ok: false, refusal: "unreachable", detail: "connection refused" } : guardedRequest(url, init)),
    });
    const first = await flaky.finish(query);
    assert.equal(first.ok ? "ok" : first.error, "refused");
    down = false;
    const second = await flaky.finish(query);
    assert.equal(second.ok, true, "the pending connect was put back");
  } finally {
    await w.close();
  }
});
