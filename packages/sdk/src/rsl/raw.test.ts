import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRsl } from "./parse.ts";
import { rawLicensesByContent } from "./raw.ts";

test("each content block's licences are recovered verbatim, in order", () => {
  const xml = `<rsl xmlns="https://rslstandard.org/rsl">
  <content url="/a/*">
    <license><permits type="usage">search</permits><payment type="free"/></license>
    <license><permits type="usage">ai-input</permits><payment type="crawl"><amount currency="USD">0.01</amount></payment></license>
  </content>
  <content url="/b/*">
    <license><permits type="usage">ai-index</permits></license>
  </content>
</rsl>`;
  const raw = rawLicensesByContent(xml);
  assert.equal(raw.length, 2);
  assert.equal(raw[0]!.length, 2);
  assert.equal(raw[1]!.length, 1);
  assert.ok(raw[0]![0]!.startsWith("<license>") && raw[0]![0]!.endsWith("</license>"));
  assert.ok(raw[0]![0]!.includes("search"));
  assert.ok(raw[0]![1]!.includes("0.01"));
  assert.ok(raw[1]![0]!.includes("ai-index"));
});

test("the index pairing matches the parser's, block for block and licence for licence", () => {
  // The whole contract: the Nth block's Mth raw licence must describe the Nth block's Mth parsed
  // licence, or a token is requested for terms the publisher did not offer.
  const xml = `<rsl xmlns="https://rslstandard.org/rsl">
  <content url="/one"><license><permits type="usage">search</permits></license></content>
  <content url="/two"><license><permits type="usage">ai-train</permits></license>
    <license><permits type="usage">ai-input</permits></license></content>
</rsl>`;
  const doc = parseRsl(xml);
  const raw = rawLicensesByContent(xml);
  assert.equal(raw.length, doc.contents.length);
  doc.contents.forEach((c, i) => {
    assert.equal(raw[i]!.length, c.licenses.length, `block ${i}`);
    c.licenses.forEach((l, j) => {
      for (const token of l.permits.usage) assert.ok(raw[i]![j]!.includes(token), `block ${i} licence ${j}`);
    });
  });
});

test("CDATA containing the close tag does not truncate the licence", () => {
  // `<accepts>` carries CDATA, and CDATA may legally contain `</license>`. A regex scan cuts the
  // licence in half here and hands a licence server a fragment.
  const xml = `<rsl xmlns="https://rslstandard.org/rsl"><content url="/">
    <license><payment type="crawl">
      <accepts type="application/x402+json"><![CDATA[{"note":"</license> is just text"}]]></accepts>
    </payment><permits type="usage">ai-input</permits></license>
  </content></rsl>`;
  const raw = rawLicensesByContent(xml)[0]![0]!;
  assert.ok(raw.endsWith("</license>"));
  assert.ok(raw.includes("ai-input"), "the part AFTER the CDATA must survive");
  assert.equal((raw.match(/<permits/g) ?? []).length, 1);
});

test("a comment mentioning a tag is skipped, not counted", () => {
  const xml = `<rsl xmlns="https://rslstandard.org/rsl"><content url="/">
    <!-- <license>this one is commented out</license> -->
    <license><permits type="usage">ai-input</permits></license>
  </content></rsl>`;
  const raw = rawLicensesByContent(xml)[0]!;
  assert.equal(raw.length, 1);
  assert.ok(raw[0]!.includes("ai-input"));
});

test("namespace prefixes are matched by local name", () => {
  const xml = `<rsl:rsl xmlns:rsl="https://rslstandard.org/rsl"><rsl:content url="/">
    <rsl:license><rsl:permits type="usage">ai-input</rsl:permits></rsl:license>
  </rsl:content></rsl:rsl>`;
  const raw = rawLicensesByContent(xml);
  assert.equal(raw[0]?.length, 1);
  assert.ok(raw[0]![0]!.includes("ai-input"));
});

test("a self-closing content block has no licences and does not swallow the next one", () => {
  const xml = `<rsl xmlns="https://rslstandard.org/rsl">
    <content url="/empty"/>
    <content url="/real"><license><permits type="usage">search</permits></license></content>
  </rsl>`;
  const raw = rawLicensesByContent(xml);
  assert.deepEqual(raw.map((b) => b.length), [0, 1]);
});

test("a document with no content blocks yields an empty list, matching the parser", () => {
  assert.deepEqual(rawLicensesByContent("<urlset><url><loc>x</loc></url></urlset>"), []);
});
