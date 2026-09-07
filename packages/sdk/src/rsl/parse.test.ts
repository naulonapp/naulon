import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRsl, parseRslOrNull } from "./parse.ts";

/** The document naulon itself publishes, shortened — default namespace, free-then-priced. */
const NAULON_DOC = `<?xml version="1.0" encoding="UTF-8"?>
<rsl xmlns="https://rslstandard.org/rsl">
  <content url="/articles/*" lastmod="2026-09-02T00:00:00Z">
    <license>
      <permits type="usage">search</permits>
      <payment type="free"/>
    </license>
    <license>
      <permits type="usage">ai-input ai-index</permits>
      <payment type="crawl">
        <amount currency="USD">0.0011</amount>
        <accepts type="application/x402+json"><![CDATA[{"scheme":"exact","network":"eip155:8453"}]]></accepts>
      </payment>
    </license>
  </content>
</rsl>
`;

test("parses the shape naulon emits: two licences, free first, priced second", () => {
  const doc = parseRsl(NAULON_DOC);
  assert.equal(doc.contents.length, 1);
  const c = doc.contents[0]!;
  assert.equal(c.url, "/articles/*");
  assert.equal(c.lastmod, "2026-09-02T00:00:00Z");
  assert.equal(c.licenses.length, 2);

  assert.deepEqual(c.licenses[0]!.permits.usage, ["search"]);
  assert.equal(c.licenses[0]!.payment?.type, "free");
  assert.equal(c.licenses[0]!.payment?.amount, undefined);

  const priced = c.licenses[1]!;
  assert.deepEqual(priced.permits.usage, ["ai-input", "ai-index"]);
  assert.equal(priced.payment?.type, "crawl");
  assert.deepEqual(priced.payment?.amount, { value: 0.0011, currency: "USD" });
  assert.deepEqual(priced.payment?.accepts, [
    { type: "application/x402+json", meta: '{"scheme":"exact","network":"eip155:8453"}' },
  ]);
});

test("an explicit namespace prefix parses identically — the prefix is the author's choice", () => {
  // The spec's own RSS and media-embedding examples are prefixed. A parser keyed to the bare local
  // name reads these as an empty document, i.e. "this publisher has no terms".
  const prefixed = `<rsl:rsl xmlns:rsl="https://rslstandard.org/rsl">
    <rsl:content url="/">
      <rsl:license>
        <rsl:permits type="usage">ai-input</rsl:permits>
        <rsl:payment type="crawl"><rsl:amount currency="USD">0.01</rsl:amount></rsl:payment>
      </rsl:license>
    </rsl:content>
  </rsl:rsl>`;
  const doc = parseRsl(prefixed);
  assert.equal(doc.contents.length, 1);
  assert.deepEqual(doc.contents[0]!.licenses[0]!.permits.usage, ["ai-input"]);
  assert.deepEqual(doc.contents[0]!.licenses[0]!.payment?.amount, { value: 0.01, currency: "USD" });
});

test("many <content> scopes and many licences per scope are all kept, in document order", () => {
  const doc = parseRsl(`<rsl xmlns="https://rslstandard.org/rsl">
    <content url="/"><license><permits type="usage">ai-input</permits></license></content>
    <content url="/free/*"><license><payment type="free"/></license></content>
  </rsl>`);
  assert.deepEqual(doc.contents.map((c) => c.url), ["/", "/free/*"]);
});

test("all three constraint axes parse, and prohibits is kept separate from permits", () => {
  const doc = parseRsl(`<rsl xmlns="https://rslstandard.org/rsl"><content url="/">
    <license>
      <permits type="usage">ai-input</permits>
      <permits type="user">commercial education</permits>
      <permits type="geo">us,eu</permits>
      <prohibits type="usage">ai-train</prohibits>
    </license>
  </content></rsl>`);
  const l = doc.contents[0]!.licenses[0]!;
  assert.deepEqual(l.permits.usage, ["ai-input"]);
  assert.deepEqual(l.permits.user, ["commercial", "education"]);
  assert.deepEqual(l.permits.geo, ["US", "EU"]); // comma-separated + upper-cased
  assert.deepEqual(l.prohibits.usage, ["ai-train"]);
  assert.deepEqual(l.prohibits.user, []);
});

test("a bare <permits> with no type attribute is the usage axis", () => {
  const doc = parseRsl(`<rsl xmlns="https://rslstandard.org/rsl"><content url="/">
    <license><permits>ai-input</permits></license></content></rsl>`);
  assert.deepEqual(doc.contents[0]!.licenses[0]!.permits.usage, ["ai-input"]);
});

test("tokens outside the RSL vocabulary are dropped, never guessed at", () => {
  const doc = parseRsl(`<rsl xmlns="https://rslstandard.org/rsl"><content url="/">
    <license><permits type="usage">ai-input ai-summarize</permits>
    <permits type="geo">United States</permits></license></content></rsl>`);
  const l = doc.contents[0]!.licenses[0]!;
  assert.deepEqual(l.permits.usage, ["ai-input"]);
  assert.deepEqual(l.permits.geo, []);
});

test("an unknown payment type yields NO payment — never a silent free", () => {
  // Reading a licence we do not understand as costing nothing is the most expensive default there
  // is: the agent takes the content and pays no one.
  const doc = parseRsl(`<rsl xmlns="https://rslstandard.org/rsl"><content url="/">
    <license><payment type="barter"><amount currency="USD">5</amount></payment></license>
  </content></rsl>`);
  assert.equal(doc.contents[0]!.licenses[0]!.payment, undefined);
});

test("a non-numeric or currency-less amount is dropped, not coerced to zero", () => {
  const doc = parseRsl(`<rsl xmlns="https://rslstandard.org/rsl"><content url="/">
    <license><payment type="crawl"><amount currency="USD">ask us</amount></payment></license>
    <license><payment type="crawl"><amount>0.01</amount></payment></license>
    <license><payment type="crawl"><amount currency="USD">-1</amount></payment></license>
  </content></rsl>`);
  const ls = doc.contents[0]!.licenses;
  assert.equal(ls[0]!.payment?.amount, undefined);
  assert.equal(ls[0]!.payment?.type, "crawl"); // the block survives; only the number is refused
  assert.equal(ls[1]!.payment?.amount, undefined);
  assert.equal(ls[2]!.payment?.amount, undefined);
});

test("the server attribute survives — it is what makes inline terms unusable", () => {
  const doc = parseRsl(`<rsl xmlns="https://rslstandard.org/rsl">
    <content url="/" server="https://licences.example/api"><license><payment type="free"/></license></content>
  </rsl>`);
  assert.equal(doc.contents[0]!.server, "https://licences.example/api");
});

test("encrypted, contact and terms are read; an empty url is preserved as empty", () => {
  const doc = parseRsl(`<rsl xmlns="https://rslstandard.org/rsl">
    <content url="" encrypted="true">
      <license>
        <legal type="contact">mailto:rights@example.com</legal>
        <legal type="disclaimer">as-is</legal>
        <terms>https://example.com/terms</terms>
      </license>
    </content></rsl>`);
  const c = doc.contents[0]!;
  assert.equal(c.url, "");
  assert.equal(c.encrypted, true);
  assert.equal(c.licenses[0]!.contact, "mailto:rights@example.com");
  assert.equal(c.licenses[0]!.termsUrl, "https://example.com/terms");
});

test("well-formed XML that is not RSL yields no contents rather than throwing", () => {
  // What a locator gets when it guessed wrong: a sitemap, a feed, an XML error page.
  assert.deepEqual(parseRsl(`<urlset><url><loc>https://x.example/</loc></url></urlset>`).contents, []);
});

test("an external-entity DTD is REFUSED outright — the XXE class fails closed", () => {
  const hostile = `<!DOCTYPE rsl [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
    <rsl xmlns="https://rslstandard.org/rsl"><content url="/">
      <license><legal type="contact">&xxe;</legal></license></content></rsl>`;
  // The parser throws rather than resolving the entity, so no local file can reach a parsed value.
  assert.throws(() => parseRsl(hostile), /External entities are not supported/);
  // …and the wrapper every consumer uses turns that into "this publisher has no licence".
  assert.equal(parseRslOrNull(hostile), null);
});

test("parseRslOrNull answers null for malformed input and for XML that carries no contents", () => {
  assert.equal(parseRslOrNull("not xml at all <<<"), null);
  assert.equal(parseRslOrNull("<urlset><url><loc>https://x.example/</loc></url></urlset>"), null);
  assert.notEqual(parseRslOrNull(NAULON_DOC), null);
});
