import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRsl } from "./parse.ts";
import { termsForUrl } from "./terms.ts";

const doc = (body: string) => parseRsl(`<rsl xmlns="https://rslstandard.org/rsl">${body}</rsl>`);

/** The real naulon shape: search free, reads priced, one scope. */
const NAULON = doc(`
  <content url="/articles/*">
    <license><permits type="usage">search</permits><payment type="free"/></license>
    <license>
      <permits type="usage">ai-input ai-index</permits>
      <payment type="crawl"><amount currency="USD">0.0011</amount>
        <accepts type="application/x402+json"><![CDATA[{"scheme":"exact","network":"eip155:8453"}]]></accepts>
      </payment>
    </license>
  </content>`);

test("a naulon-published article resolves to a priced x402 read and a free search", () => {
  const t = termsForUrl(NAULON, "https://pub.example/articles/2026/one")!;
  assert.equal(t.usage["ai-input"], true);
  assert.equal(t.usage["search"], true);
  assert.equal(t.usage["ai-train"], undefined, "silence is not permission and must not read as false either");
  assert.equal(t.read?.paymentType, "crawl");
  assert.deepEqual(t.read?.amount, { value: 0.0011, currency: "USD" });
  assert.equal(t.read?.accepts[0]?.type, "application/x402+json");
  assert.equal(t.obligation, "inline");
});

test("a url outside every scope resolves to null — no terms, not free terms", () => {
  assert.equal(termsForUrl(NAULON, "https://pub.example/about"), null);
});

test("precedence is per-question: a narrow priced scope keeps the broad free-search grant", () => {
  // The failure this exists to stop: winner-takes-all would drop the site-wide search grant on any
  // article path, so a search crawler would be told it may not index a page it is welcome to.
  const d = doc(`
    <content url="/"><license><permits type="usage">search</permits><payment type="free"/></license></content>
    <content url="/articles/*"><license><permits type="usage">ai-input</permits>
      <payment type="crawl"><amount currency="USD">0.01</amount></payment></license></content>`);
  const t = termsForUrl(d, "/articles/x")!;
  assert.deepEqual(t.scopes, ["/articles/*", "/"], "most specific first");
  assert.equal(t.usage["search"], true);
  assert.equal(t.usage["ai-input"], true);
  assert.deepEqual(t.read?.amount, { value: 0.01, currency: "USD" });
});

test("a narrower scope overrides the broader one on the token it speaks to", () => {
  const d = doc(`
    <content url="/"><license><permits type="usage">ai-input</permits>
      <payment type="crawl"><amount currency="USD">0.01</amount></payment></license></content>
    <content url="/private/*"><license><prohibits type="usage">ai-input</prohibits></license></content>`);
  assert.equal(termsForUrl(d, "/private/x")!.usage["ai-input"], false);
  assert.equal(termsForUrl(d, "/public/x")!.usage["ai-input"], true);
});

test("prohibition beats permission inside one scope", () => {
  const d = doc(`<content url="/">
    <license><permits type="usage">ai-input</permits>
      <payment type="crawl"><amount currency="USD">0.01</amount></payment></license>
    <license><prohibits type="usage">ai-input</prohibits></license></content>`);
  assert.equal(termsForUrl(d, "/x")!.usage["ai-input"], false);
});

test("`ai-all` grants ai-input; `all` prohibits everything under it", () => {
  const grant = doc(`<content url="/"><license><permits type="usage">ai-all</permits>
    <payment type="crawl"><amount currency="USD">0.02</amount></payment></license></content>`);
  const t = termsForUrl(grant, "/x")!;
  assert.equal(t.usage["ai-input"], true);
  assert.equal(t.usage["ai-train"], true);
  assert.deepEqual(t.read?.amount, { value: 0.02, currency: "USD" });

  const deny = doc(`<content url="/"><license><prohibits type="usage">all</prohibits></license></content>`);
  const d = termsForUrl(deny, "/x")!;
  assert.equal(d.usage["ai-input"], false);
  assert.equal(d.usage["search"], false);
  assert.equal(d.read, undefined);
});

test("a free grant is preferred over a priced one in the same scope", () => {
  const d = doc(`<content url="/">
    <license><permits type="usage">ai-input</permits>
      <payment type="crawl"><amount currency="USD">0.01</amount></payment></license>
    <license><permits type="usage">ai-input</permits><payment type="free"/></license></content>`);
  assert.equal(termsForUrl(d, "/x")!.read?.paymentType, "free");
});

test("a narrow scope silent on price inherits the broader price, never free", () => {
  const d = doc(`
    <content url="/"><license><permits type="usage">ai-input</permits>
      <payment type="crawl"><amount currency="USD">0.05</amount></payment></license></content>
    <content url="/notes/*"><license><permits type="usage">ai-input</permits></license></content>`);
  const t = termsForUrl(d, "/notes/x")!;
  assert.equal(t.read?.paymentType, "crawl");
  assert.deepEqual(t.read?.amount, { value: 0.05, currency: "USD" });
  assert.equal(t.read?.scope, "/");
});

test("a licence server makes the inline terms unusable — obligation, not price", () => {
  // Spec: with `server` set, a client MUST obtain the licence there regardless of payment type,
  // including `free`. Paying the inline price would license nothing.
  const d = doc(`<content url="/" server="https://olp.example/api">
    <license><permits type="usage">ai-input</permits>
      <payment type="crawl"><amount currency="USD">0.01</amount></payment></license></content>`);
  const t = termsForUrl(d, "/x")!;
  assert.equal(t.obligation, "license-server");
  assert.equal(t.server, "https://olp.example/api");
});

test("the server binds only when its scope is the one governing the read", () => {
  const d = doc(`
    <content url="/" server="https://olp.example/api"><license><permits type="usage">search</permits>
      <payment type="free"/></license></content>
    <content url="/open/*"><license><permits type="usage">ai-input</permits>
      <payment type="crawl"><amount currency="USD">0.01</amount></payment></license></content>`);
  assert.equal(termsForUrl(d, "/open/x")!.obligation, "inline");
  assert.equal(termsForUrl(d, "/elsewhere")!.obligation, "license-server");
});

test("an empty scope url applies only to the path the locator says it was associated with", () => {
  const d = doc(`<content url=""><license><permits type="usage">ai-input</permits>
    <payment type="free"/></license></content>`);
  assert.equal(termsForUrl(d, "/inline-page"), null, "no association ⇒ it governs nothing");
  const t = termsForUrl(d, "/inline-page", { associationPath: "/inline-page" })!;
  assert.equal(t.read?.paymentType, "free");
  assert.equal(termsForUrl(d, "/other", { associationPath: "/inline-page" }), null);
});

test("a non-USD price is reported as stated — conversion is not this module's call", () => {
  const d = doc(`<content url="/"><license><permits type="usage">ai-input</permits>
    <payment type="crawl"><amount currency="EUR">0.03</amount></payment></license></content>`);
  assert.deepEqual(termsForUrl(d, "/x")!.read?.amount, { value: 0.03, currency: "EUR" });
});

test("a garbage url resolves to null rather than throwing", () => {
  assert.equal(termsForUrl(NAULON, "not a url"), null);
});

test("the contact from the governing scope is carried for a human follow-up", () => {
  const d = doc(`<content url="/"><license><legal type="contact">mailto:r@example.com</legal>
    <permits type="usage">ai-input</permits><payment type="crawl"><amount currency="USD">0.01</amount></payment>
  </license></content>`);
  assert.equal(termsForUrl(d, "/x")!.contact, "mailto:r@example.com");
});
