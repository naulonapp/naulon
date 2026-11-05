/**
 * Connect, end to end, over real sockets: a gate, its console and a site are three servers on
 * loopback, sharing nothing but the gate's state store (which the gate and its console share in
 * production too). The browser is played by following redirects by hand.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { clientResolver, memoryStateStore, type PublisherConfig } from "@naulon/shared";
import { mountGateConnect } from "../../../tollgate/src/connect/routes.ts";
import { siteCredentialAuth } from "../../../tollgate/src/connect/auth.ts";
import { mountConnectApprove } from "../../../dashboard/src/connect-approve.ts";
import { naulonConnect } from "./connect.ts";

async function listen(app: Hono): Promise<{ origin: string; server: ServerType }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve({ origin: `http://127.0.0.1:${info.port}`, server }));
  });
}
const close = (s: ServerType) => new Promise<void>((r) => s.close(() => r()));

async function world() {
  const state = memoryStateStore();
  const consoleApp = new Hono();
  consoleApp.use("*", async (c, next) => {
    c.set("naulonPrincipal" as never, { kind: "session", username: "owner", userId: "u1", role: "admin", mustChangePassword: false } as never);
    await next();
  });
  mountConnectApprove(consoleApp, { state, clients: clientResolver({ allowPrivate: true }), allowPrivate: true, gateLabel: "the test gate" });
  const consoleSrv = await listen(consoleApp);

  const gateApp = new Hono();
  mountGateConnect(gateApp, { state, authorizeUrl: `${consoleSrv.origin}/connect/authorize`, trustProxy: false, proxyHops: 1 });
  const gateSrv = await listen(gateApp);

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
  connect = naulonConnect({ clientName: "Test blog", gate: gateSrv.origin });

  return {
    state,
    connect,
    saved,
    origins: { console: consoleSrv.origin, gate: gateSrv.origin, site: siteSrv.origin },
    close: async () => Promise.all([close(consoleSrv.server), close(gateSrv.server), close(siteSrv.server)]),
  };
}

/** The owner's browser: open the approve page, press a button, follow the redirect home. */
async function owner(url: string, decision: "approve" | "deny") {
  const page = await fetch(url);
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
    const page = await fetch(started.url);
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
