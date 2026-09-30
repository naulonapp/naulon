import assert from "node:assert/strict";
import { test } from "node:test";
import { readAccept, readBody } from "./readable.ts";

const PARA = "The sentence the agent paid the author to read. ".repeat(10);
const PAGE = `<!doctype html><html lang="en"><head><title>T</title></head><body>
<nav>${"<a href='/x'>chrome link</a> ".repeat(30)}</nav>
<article><h1>T</h1><p>${PARA}</p><p>${PARA}</p></article></body></html>`;
const meta = (m: object) => Buffer.from(JSON.stringify(m)).toString("base64url");

test("each format sends the Accept header that asks for it", () => {
  assert.equal(readAccept("markdown"), "text/markdown, text/html;q=0.9");
  assert.equal(readAccept("html"), "text/html");
});

test("markdown the gate produced passes through untouched, with the gate's metadata", async () => {
  const res = new Response("# T\n\nbody", {
    headers: { "content-type": "text/markdown", "x-naulon-extraction": "gate", "x-naulon-article": meta({ title: "T", words: 3, approxTokens: 3 }) },
  });
  const r = await readBody(res, "https://x.test/a", "markdown");
  assert.equal(r.content, "# T\n\nbody");
  assert.equal(r.extraction, "gate");
  assert.equal(r.article?.title, "T");
});

test("a malformed metadata header is dropped, the text is still served", async () => {
  const res = new Response("# T", { headers: { "content-type": "text/markdown", "x-naulon-extraction": "gate", "x-naulon-article": "%%%" } });
  const r = await readBody(res, "https://x.test/a", "markdown");
  assert.equal(r.content, "# T");
  assert.equal(r.article, undefined);
});

test("a site that serves markdown itself is passthrough", async () => {
  const r = await readBody(new Response("# own words", { headers: { "content-type": "text/markdown" } }), "https://x.test/a", "markdown");
  assert.equal(r.extraction, "passthrough");
  assert.equal(r.content, "# own words");
  assert.equal(r.article?.words, 3);
});

test("HTML from a server that did not convert is converted here and labelled client", async () => {
  const r = await readBody(new Response(PAGE, { headers: { "content-type": "text/html" } }), "https://x.test/a", "markdown");
  assert.equal(r.extraction, "client");
  assert.doesNotMatch(r.content, /chrome link|<p>/);
  assert.ok(r.article && r.article.words > 50);
});

test("HTML with no article is returned as served, labelled raw", async () => {
  const r = await readBody(new Response("<p>x</p>", { headers: { "content-type": "text/html" } }), "https://x.test/a", "markdown");
  assert.equal(r.extraction, "raw");
  assert.equal(r.content, "<p>x</p>");
});

test("format html returns the page as served, with no label", async () => {
  const r = await readBody(new Response(PAGE, { headers: { "content-type": "text/html" } }), "https://x.test/a", "html");
  assert.equal(r.content, PAGE);
  assert.equal(r.extraction, undefined);
  assert.equal(r.article, undefined);
});
