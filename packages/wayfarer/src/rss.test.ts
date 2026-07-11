/**
 * RSS parsing + the teaser boundary. The critical invariant: discovery never
 * surfaces the full body, even when the feed ships one — otherwise the agent
 * reads the article for free and the toll is bypassed at discovery.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseRss,
  slugFromLink,
  extractTeaser,
  rssItemToCandidate,
  rssToCandidates,
} from "./rss.ts";

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Meridian — Essays</title>
    <item>
      <title>Esoteric Bible Reading: &quot;666&quot;</title>
      <link>https://meridian.example/articles/esoteric-bible-reading-666</link>
      <guid isPermaLink="true">https://meridian.example/articles/esoteric-bible-reading-666</guid>
      <description>The number six caught my attention&#8230; a short lede only.</description>
      <pubDate>Wed, 20 May 2026 17:20:34 GMT</pubDate>
      <dc:creator>etiric</dc:creator>
    </item>
    <item>
      <title><![CDATA[The Sanctuary of Delphi]]></title>
      <link>https://meridian.example/articles/the-sanctuary-of-delphi</link>
      <description><![CDATA[Two swans, released from opposite ends of the world.]]></description>
      <content:encoded><![CDATA[FULL BODY: the entire paid article text lives here.]]></content:encoded>
    </item>
  </channel>
</rss>`;

test("parseRss lifts every item with its teaser fields", () => {
  const items = parseRss(FEED);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.link, "https://meridian.example/articles/esoteric-bible-reading-666");
  assert.equal(items[1]!.title, "The Sanctuary of Delphi"); // CDATA unwrapped
});

test("decodes named and numeric XML entities, not CDATA", () => {
  const items = parseRss(FEED);
  assert.equal(items[0]!.title, 'Esoteric Bible Reading: "666"'); // &quot;
  assert.ok(items[0]!.description.includes("…")); // &#8230; → …
});

test("slugFromLink takes the last path segment", () => {
  assert.equal(slugFromLink("https://meridian.example/articles/the-sanctuary-of-delphi"), "the-sanctuary-of-delphi");
  assert.equal(slugFromLink("https://x.test/a/b/c/?q=1#frag"), "c");
  assert.equal(slugFromLink(""), "");
});

test("teaser boundary: the full body never leaks into the teaser", () => {
  const items = parseRss(FEED);
  const withBody = items[1]!;
  assert.equal(withBody.contentEncoded, "FULL BODY: the entire paid article text lives here.");
  // The teaser is the description; the body is refused even though it's present.
  const teaser = extractTeaser(withBody);
  assert.ok(!teaser.includes("FULL BODY"));
  assert.equal(teaser, "Two swans, released from opposite ends of the world.");
});

test("rssItemToCandidate yields a free teaser (slug + title + summary, no price)", () => {
  const c = rssItemToCandidate(parseRss(FEED)[0]!);
  assert.deepEqual(Object.keys(c).sort(), ["slug", "summary", "title", "url"]);
  assert.equal(c.slug, "esoteric-bible-reading-666");
  // URL-centric: the real feed link is carried verbatim (here /articles/, not /essays/).
  assert.equal(c.url, "https://meridian.example/articles/esoteric-bible-reading-666");
});

test("rssToCandidates maps the whole feed and drops slugless items", () => {
  const cands = rssToCandidates(FEED);
  assert.equal(cands.length, 2);
  assert.ok(cands.every((c) => c.slug.length > 0));
  // None of the candidates carry the paid body.
  assert.ok(cands.every((c) => !c.summary.includes("FULL BODY")));
});

test("an item with no link or guid is dropped (no usable slug)", () => {
  const cands = rssToCandidates(
    `<rss><channel><item><title>Orphan</title><description>No link here.</description></item></channel></rss>`,
  );
  assert.equal(cands.length, 0);
});
