import { test } from "node:test";
import assert from "node:assert/strict";
import { describeMarkdown, extractArticle, isHtml, isMarkdown, prefersMarkdown } from "./index.ts";

const PARA = "Pricing an article taught me that a reader values the argument, not the word count. ".repeat(6);

/** The shape of a themed blog page: most of the bytes are not the article. */
function themedPage(article: string): string {
  const chrome = (tag: string, n: number) =>
    `<${tag}>${Array.from({ length: n }, (_, i) => `<a href="/p/${i}">Related post ${i}</a>`).join(" ")}</${tag}>`;
  return `<!doctype html><html lang="en"><head>
<title>What pricing an article taught me</title>
<link rel="canonical" href="https://blog.example/what-pricing-taught-me/">
<meta property="article:published_time" content="2026-09-01T10:00:00Z">
<style>${"body{margin:0}".repeat(400)}</style>
<script>${"window.dataLayer=window.dataLayer||[];".repeat(400)}</script>
</head><body>
${chrome("nav", 40)}
<div class="cookie-banner">We use cookies. Accept all cookies to continue.</div>
<aside class="sidebar">${chrome("div", 60)}</aside>
<main><article>
<h1>What pricing an article taught me</h1>
<p class="byline">By Ada Writer</p>
${article}
</article></main>
<section class="comments"><h3>Comments</h3><p>Great post, buy my course at spam.example</p></section>
<footer>${chrome("div", 30)} Copyright footer text</footer>
<script>${"console.log(1);".repeat(300)}</script>
</body></html>`;
}

const BODY = `<p>${PARA}</p><h2>What changed</h2><p>${PARA}</p><ul><li>one</li><li>two</li></ul>
<p>See <a href="/other-post/">the other post</a> for more.</p>
<table><thead><tr><th>price</th><th>reads</th></tr></thead><tbody><tr><td>0.01</td><td>40</td></tr></tbody></table>
<pre><code>const toll = 0.01;</code></pre><p>${PARA}</p>`;

const URL_ = "https://blog.example/what-pricing-taught-me/";

test("a themed page reduces to its article, far smaller than the page", () => {
  const page = themedPage(BODY);
  const a = extractArticle(page, URL_);
  assert.ok(a);
  assert.ok(a.markdown.length * 5 < page.length, `${a.markdown.length} vs ${page.length}`);
  assert.match(a.markdown, /a reader values the argument/);
  assert.doesNotMatch(a.markdown, /<script|<style|dataLayer|Related post|cookies|spam\.example|Copyright footer/);
  assert.equal(a.title, "What pricing an article taught me");
  assert.equal(a.canonical, "https://blog.example/what-pricing-taught-me/");
  assert.equal(a.lang, "en");
  assert.ok(a.words > 100);
  assert.equal(a.approxTokens, Math.ceil(a.markdown.length / 4));
});

test("structure survives: headings, lists, absolute links, tables, code", () => {
  const a = extractArticle(themedPage(BODY), URL_);
  assert.ok(a);
  assert.match(a.markdown, /^## What changed$/m);
  assert.match(a.markdown, /^-\s+one$/m);
  assert.match(a.markdown, /\[the other post\]\(https:\/\/blog\.example\/other-post\/\)/);
  assert.match(a.markdown, /\|\s*price\s*\|\s*reads\s*\|/);
  assert.match(a.markdown, /```\s*\nconst toll = 0\.01;\n```/);
});

test("too little content is null, never a guess", () => {
  assert.equal(extractArticle("<html><body><p>short</p></body></html>", URL_), null);
  assert.equal(extractArticle("", URL_), null);
  assert.equal(extractArticle("not html at all", URL_), null);
});

test("prefersMarkdown reads q-values against every HTML type", () => {
  assert.equal(prefersMarkdown("text/markdown, text/html;q=0.9"), true);
  assert.equal(prefersMarkdown("text/html;q=0.9, text/markdown"), true);
  assert.equal(prefersMarkdown("text/html,application/xhtml+xml,*/*;q=0.8"), false);
  assert.equal(prefersMarkdown("text/markdown;q=0"), false);
  assert.equal(prefersMarkdown("text/markdown;q=0.5, text/html"), false);
  assert.equal(prefersMarkdown("TEXT/MARKDOWN"), true);
  assert.equal(prefersMarkdown(null), false);
  assert.equal(prefersMarkdown(""), false);
});

test("media type helpers ignore parameters and case", () => {
  assert.equal(isHtml("text/html; charset=utf-8"), true);
  assert.equal(isHtml("application/xhtml+xml"), true);
  assert.equal(isHtml("application/pdf"), false);
  assert.equal(isHtml(null), false);
  assert.equal(isMarkdown("Text/Markdown; charset=utf-8"), true);
  assert.equal(isMarkdown("text/plain"), false);
});

test("describeMarkdown counts words and estimates tokens", () => {
  assert.deepEqual(describeMarkdown("one two  three\n"), { words: 3, approxTokens: 4 });
  assert.deepEqual(describeMarkdown(""), { words: 0, approxTokens: 0 });
});
