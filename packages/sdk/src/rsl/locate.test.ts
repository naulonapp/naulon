import { test } from "node:test";
import assert from "node:assert/strict";
import type { Fetcher } from "../crawl/types.ts";
import {
  inlineRslFromHtml,
  licenseUrlFromHtml,
  licenseUrlFromLinkHeader,
  licenseUrlFromRobots,
  locateLicence,
} from "./locate.ts";

const DOC = `<rsl xmlns="https://rslstandard.org/rsl"><content url="/">
  <license><permits type="usage">ai-input</permits>
  <payment type="crawl"><amount currency="USD">0.01</amount></payment></license></content></rsl>`;

/** A fake origin-scoped fetcher factory. Records every (origin, url) it was asked for. */
function fakeNet(routes: Record<string, { status?: number; body?: string; headers?: Record<string, string> }>) {
  const asked: { origin: string; url: string }[] = [];
  const fetcherFor = (origin: string): Fetcher => async (url) => {
    asked.push({ origin, url });
    const r = routes[url];
    if (!r) return { ok: false, status: 404, async text() { return ""; }, async json() { return null; } };
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: r.headers ?? {},
      async text() { return r.body ?? ""; },
      async json() { return JSON.parse(r.body ?? "null") as unknown; },
    };
  };
  return { fetcherFor, asked };
}

test("robots.txt License: is followed and parsed", async () => {
  const net = fakeNet({
    "https://pub.example/robots.txt": { body: "User-agent: *\nAllow: /\n\nLicense: https://pub.example/license.xml\n" },
    "https://pub.example/license.xml": { body: DOC },
  });
  const found = await locateLicence("https://pub.example/articles/x", { fetcherFor: net.fetcherFor });
  assert.equal(found?.source, "robots");
  assert.equal(found?.documentUrl, "https://pub.example/license.xml");
  assert.equal(found?.doc.contents[0]?.url, "/");
});

test("a relative License: URI resolves against the origin", () => {
  assert.equal(licenseUrlFromRobots("License: /terms/license.xml"), "/terms/license.xml");
});

test("robots precedence: an agent's own group beats `*`, which beats a global line", () => {
  const robots = [
    "License: https://x.example/global.xml",
    "User-agent: *",
    "License: https://x.example/star.xml",
    "User-agent: naulon-wayfarer",
    "License: https://x.example/ours.xml",
  ].join("\n");
  assert.equal(licenseUrlFromRobots(robots, "naulon-wayfarer/0.3"), "https://x.example/ours.xml");
  assert.equal(licenseUrlFromRobots(robots, "some-other-bot"), "https://x.example/star.xml");
  assert.equal(licenseUrlFromRobots("License: https://x.example/global.xml"), "https://x.example/global.xml");
});

test("consecutive User-agent lines are ONE group", () => {
  const robots = "User-agent: a\nUser-agent: b\nLicense: https://x.example/ab.xml";
  assert.equal(licenseUrlFromRobots(robots, "b"), "https://x.example/ab.xml");
});

test("a commented-out or empty License line is not a licence", () => {
  assert.equal(licenseUrlFromRobots("# License: https://x.example/l.xml"), null);
  assert.equal(licenseUrlFromRobots("License:"), null);
  assert.equal(licenseUrlFromRobots("Sitemap: https://x.example/sitemap.xml"), null);
});

test("the Link header channel requires the RSL media type", () => {
  assert.equal(
    licenseUrlFromLinkHeader('</l.xml>; rel="license"; type="application/rsl+xml"'),
    "/l.xml",
  );
  // The pre-RSL convention — a link to a human-readable licence page. Following it would fetch
  // HTML and report the publisher's terms as malformed.
  assert.equal(licenseUrlFromLinkHeader('<https://creativecommons.org/licenses/by/4.0/>; rel="license"'), null);
  assert.equal(licenseUrlFromLinkHeader(undefined), null);
});

test("a multi-value Link header picks the licence, not the first entry", () => {
  const h = '<https://x.example/style.css>; rel=preload, </l.xml>; rel="license"; type="application/rsl+xml"';
  assert.equal(licenseUrlFromLinkHeader(h), "/l.xml");
});

test("the HTML link channel accepts attributes in any order and either quote style", () => {
  assert.equal(
    licenseUrlFromHtml(`<link type='application/rsl+xml' href="/a.xml" rel=license>`),
    "/a.xml",
  );
  assert.equal(licenseUrlFromHtml(`<link rel="alternate" href="/f.xml">`), null);
  assert.equal(licenseUrlFromHtml(`<link rel="license" href="/human.html">`), null, "no media type ⇒ not RSL");
});

test("an inline <script type=application/rsl+xml> is the document itself", async () => {
  const html = `<html><head><script type="application/rsl+xml">${DOC}</script></head></html>`;
  assert.ok(inlineRslFromHtml(html)?.startsWith("<rsl"));
  const net = fakeNet({});
  const found = await locateLicence("https://pub.example/page", {
    fetcherFor: net.fetcherFor,
    observed: { body: html },
  });
  assert.equal(found?.source, "html-inline");
  assert.equal(found?.documentUrl, undefined);
  // The association path is what makes an empty `content@url` in this document mean THIS page.
  assert.equal(found?.associationPath, "/page");
});

test("a response already in hand beats robots — the page-level declaration wins", async () => {
  // The one-directional failure this protects: a site-wide "free" would otherwise mask a
  // page-level price and the publisher would be read for nothing.
  const pageDoc = DOC.replace("0.01", "0.99");
  const net = fakeNet({
    "https://pub.example/robots.txt": { body: "License: https://pub.example/site.xml" },
    "https://pub.example/site.xml": { body: DOC },
    "https://pub.example/page.xml": { body: pageDoc },
  });
  const found = await locateLicence("https://pub.example/p", {
    fetcherFor: net.fetcherFor,
    observed: { headers: { link: '</page.xml>; rel="license"; type="application/rsl+xml"' } },
  });
  assert.equal(found?.source, "link-header");
  assert.equal(found?.doc.contents[0]?.licenses[0]?.payment?.amount?.value, 0.99);
  assert.ok(!net.asked.some((a) => a.url.endsWith("/robots.txt")), "robots must not be fetched at all");
});

test("an off-origin licence URL is fetched through a fetcher built for ITS origin", async () => {
  // The SSRF guard is per-origin, so the licence host must get its own guarded fetcher — not the
  // publisher's. A `License:` directive is publisher-controlled input naming an arbitrary URI.
  const net = fakeNet({
    "https://pub.example/robots.txt": { body: "License: https://collective.example/terms.xml" },
    "https://collective.example/terms.xml": { body: DOC },
  });
  const found = await locateLicence("https://pub.example/x", { fetcherFor: net.fetcherFor });
  assert.equal(found?.source, "robots");
  const docFetch = net.asked.find((a) => a.url === "https://collective.example/terms.xml");
  assert.equal(docFetch?.origin, "https://collective.example");
});

test("a non-http licence URI is refused rather than opened", async () => {
  const net = fakeNet({ "https://pub.example/robots.txt": { body: "License: file:///etc/passwd" } });
  assert.equal(await locateLicence("https://pub.example/x", { fetcherFor: net.fetcherFor }), null);
  assert.ok(!net.asked.some((a) => a.url.startsWith("file:")));
});

test("the target page is NOT fetched unless the caller opts in", async () => {
  const net = fakeNet({
    "https://pub.example/x": { body: `<link rel="license" type="application/rsl+xml" href="/l.xml">` },
    "https://pub.example/l.xml": { body: DOC },
  });
  assert.equal(await locateLicence("https://pub.example/x", { fetcherFor: net.fetcherFor }), null);
  assert.ok(!net.asked.some((a) => a.url === "https://pub.example/x"), "no speculative GET");

  const found = await locateLicence("https://pub.example/x", { fetcherFor: net.fetcherFor, fetchPage: true });
  assert.equal(found?.source, "html-link");
});

test("no licence anywhere is null — never an empty document that reads as no restrictions", async () => {
  const net = fakeNet({ "https://pub.example/robots.txt": { body: "User-agent: *\nDisallow:" } });
  assert.equal(await locateLicence("https://pub.example/x", { fetcherFor: net.fetcherFor }), null);
});

test("a licence URL that 404s, throws, or returns non-RSL yields null, not a crash", async () => {
  const thrower = (): Fetcher => async () => {
    throw new Error("connection refused");
  };
  assert.equal(await locateLicence("https://pub.example/x", { fetcherFor: thrower }), null);

  const net = fakeNet({
    "https://pub.example/robots.txt": { body: "License: https://pub.example/l.xml" },
    "https://pub.example/l.xml": { body: "<html>not a licence</html>" },
  });
  assert.equal(await locateLicence("https://pub.example/x", { fetcherFor: net.fetcherFor }), null);
});

test("a malformed target url is null before anything is fetched", async () => {
  const net = fakeNet({});
  assert.equal(await locateLicence("not a url", { fetcherFor: net.fetcherFor }), null);
  assert.equal(net.asked.length, 0);
});
