import { test } from "node:test";
import assert from "node:assert/strict";
import { contentExitFor, WORDPRESS_FEED, WORDPRESS_REST } from "./content-exits.ts";

const u = (s: string) => new URL(s, "https://site.test");

test("matches every WordPress REST spelling and nothing else", () => {
  assert.equal(contentExitFor(u("/wp-json/wp/v2/posts?per_page=1"))?.id, "wordpress-rest");
  assert.equal(contentExitFor(u("/wp-json//wp/v2/pages/7"))?.id, "wordpress-rest", "a doubled slash inside the path");
  assert.equal(contentExitFor(u("/?rest_route=/wp/v2/posts"))?.id, "wordpress-rest");
  assert.equal(contentExitFor(u("/index.php?rest_route=%2Fwp%2Fv2%2Fposts"))?.id, "wordpress-rest");
  assert.equal(contentExitFor(u("/wp-json/naulon/v1/catalog")), null, "the plugin's own catalog is a teaser list already");
  assert.equal(contentExitFor(u("/blog/a-post/")), null, "an article page is the toll's, not an exit's");
});

test("matches every WordPress feed spelling", () => {
  for (const p of ["/feed/", "/feed/atom/", "/category/news/feed/", "/2026/10/feed/rss2/", "/?feed=rss2", "/wp-rss2.php", "/comments/feed/"]) {
    assert.equal(contentExitFor(u(p))?.id, "wordpress-feed", p);
  }
  assert.equal(contentExitFor(u("/feedback-form/")), null);
});

test("REST: every post body becomes its excerpt, in lists, single posts and embeds; comments and users untouched", () => {
  const body = JSON.stringify([
    {
      id: 1,
      title: { rendered: "A" },
      content: { rendered: "<p>Full text of A.</p>", protected: false },
      excerpt: { rendered: "<p>Teaser A.</p>" },
      _embedded: {
        author: [{ id: 2, name: "Ada", description: "bio" }],
        replies: [[{ id: 9, content: { rendered: "<p>A comment.</p>" } }]],
      },
    },
    { id: 2, title: { rendered: "B" }, content: { rendered: "<p>Full text of B.</p>" } },
  ]);
  const out = JSON.parse(WORDPRESS_REST.strip(body, "application/json; charset=UTF-8", u("/wp-json/wp/v2/posts?_embed"))!);
  assert.deepEqual(out[0].content, { rendered: "<p>Teaser A.</p>", protected: true });
  assert.deepEqual(out[1].content, { rendered: "", protected: true }, "no excerpt support: nothing, never the body");
  assert.equal(out[0]._embedded.replies[0][0].content.rendered, "<p>A comment.</p>", "a comment has no title, so it is not a post");
  assert.equal(out[0]._embedded.author[0].description, "bio");
  assert.ok(!JSON.stringify(out).includes("Full text"));
});

test("REST: a body that is not JSON is served as it came", () => {
  assert.equal(WORDPRESS_REST.strip("<html>error</html>", "text/html", u("/wp-json/wp/v2/posts")), null);
  assert.equal(WORDPRESS_REST.strip("{not json", "application/json", u("/wp-json/wp/v2/posts")), null);
});

test("feeds: RSS content:encoded and Atom content go; description and summary stay", () => {
  const rss = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><title>A</title><description><![CDATA[Teaser A]]></description><content:encoded><![CDATA[<p>Full text of A.</p>]]></content:encoded></item></channel></rss>`;
  const outRss = WORDPRESS_FEED.strip(rss, "application/rss+xml; charset=UTF-8", u("/feed/"))!;
  assert.ok(!outRss.includes("Full text"));
  assert.ok(outRss.includes("Teaser A"));
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A</title><summary type="html">Teaser A</summary><content type="html">&lt;p&gt;Full text of A.&lt;/p&gt;</content></entry></feed>`;
  const outAtom = WORDPRESS_FEED.strip(atom, "application/atom+xml", u("/feed/atom/"))!;
  assert.ok(!outAtom.includes("Full text"));
  assert.ok(outAtom.includes("<summary"));
  assert.equal(WORDPRESS_FEED.strip("<html>404</html>", "text/html", u("/feed/")), null);
});

test("REST: asking for only id and content does not dodge the strip (decided by route, not shape)", () => {
  const body = JSON.stringify([{ id: 1, content: { rendered: "<p>Full text of A.</p>" } }]);
  for (const path of ["/wp-json/wp/v2/posts?_fields=id,content", "/?rest_route=/wp/v2/posts&_fields=content", "/wp-json/wp/v2/my_cpt?_fields=content"]) {
    const out = WORDPRESS_REST.strip(body, "application/json", u(path))!;
    assert.ok(!out.includes("Full text"), path);
  }
});

test("REST: the comments route keeps its text, it is not the article", () => {
  const body = JSON.stringify([{ id: 9, post: 1, content: { rendered: "<p>A comment.</p>" } }]);
  assert.equal(WORDPRESS_REST.strip(body, "application/json", u("/wp-json/wp/v2/comments?post=1")), body);
});

test("REST: the PATH_INFO spelling and any letter case reach the exit", () => {
  for (const p of ["/index.php/wp-json/wp/v2/posts", "/WP-JSON/wp/v2/posts", "/?rest_route=/WP/V2/posts"]) {
    assert.equal(contentExitFor(u(p))?.id, "wordpress-rest", p);
  }
});

test("REST: a JSONP answer (?_jsonp=cb, on by default) is stripped inside its callback", () => {
  const body = `/**/cb(${JSON.stringify([{ id: 1, content: { rendered: "<p>Full text of A.</p>" }, excerpt: { rendered: "T" } }])})`;
  const out = WORDPRESS_REST.strip(body, "application/javascript; charset=UTF-8", u("/wp-json/wp/v2/posts?_jsonp=cb"))!;
  assert.ok(out.startsWith("/**/cb(") && out.endsWith(")"));
  assert.ok(!out.includes("Full text"));
  assert.equal(WORDPRESS_REST.failClosed, true, "a REST body the exit cannot read is refused, never served");
  assert.ok(!WORDPRESS_FEED.failClosed, "a /feed/ page on another kind of site is an ordinary page");
});
