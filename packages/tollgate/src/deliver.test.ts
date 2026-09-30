import assert from "node:assert/strict";
import { test } from "node:test";
import { ARTICLE_HEADER, deliverForAgent, EXTRACTION_HEADER } from "./deliver.ts";

const PARA = "A sentence the author wrote and the agent paid to read. ".repeat(8);
const ARTICLE = `<!doctype html><html lang="en"><head><title>Paid</title></head><body>
<nav>${"<a href='/x'>menu</a> ".repeat(40)}</nav>
<article><h1>Paid</h1><p>${PARA}</p><p>${PARA}</p></article>
<footer>footer chrome</footer></body></html>`;

const html = (body: string, extra: Record<string, string> = {}) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8", etag: '"abc"', ...extra } });

test("markdown asked, HTML served: converted, labelled gate, and the bytes are what is sent", async () => {
  const d = await deliverForAgent(html(ARTICLE), "text/markdown, text/html;q=0.9", "https://x.test/essays/a");
  assert.equal(d.extraction, "gate");
  assert.equal(d.res.headers.get(EXTRACTION_HEADER), "gate");
  assert.match(d.res.headers.get("content-type")!, /^text\/markdown; charset=utf-8$/);
  assert.equal(d.res.headers.get("etag"), null, "the origin's validator describes the HTML, not this body");
  const text = await d.res.text();
  assert.equal(new TextDecoder().decode(d.bytes), text);
  assert.doesNotMatch(text, /menu|footer chrome|<p>/);
  const meta = JSON.parse(Buffer.from(d.res.headers.get(ARTICLE_HEADER)!, "base64url").toString("utf8"));
  assert.equal(meta.title, "Paid");
  assert.ok(meta.words > 50);
  assert.equal(meta.markdown, undefined, "metadata only, the text travels once");
  assert.ok(d.sourceBytes > d.bytes.byteLength);
});

test("HTML asked: served unchanged and unlabelled", async () => {
  const d = await deliverForAgent(html(ARTICLE), "text/html", "https://x.test/essays/a");
  assert.equal(d.extraction, undefined);
  assert.equal(d.res.headers.get(EXTRACTION_HEADER), null);
  assert.equal(d.res.headers.get("etag"), '"abc"');
  assert.equal(await d.res.text(), ARTICLE);
  assert.equal(d.sourceBytes, d.bytes.byteLength);
});

test("no Accept at all: served unchanged", async () => {
  const d = await deliverForAgent(html(ARTICLE), null, "https://x.test/essays/a");
  assert.equal(d.extraction, undefined);
  assert.equal(await d.res.text(), ARTICLE);
});

test("the origin already answered markdown: passed through, not re-extracted", async () => {
  const md = "# Hi\n\nThe site wrote this as markdown.";
  const d = await deliverForAgent(new Response(md, { headers: { "content-type": "text/markdown" } }), "text/markdown", "https://x.test/a");
  assert.equal(d.extraction, "passthrough");
  assert.equal(await d.res.text(), md);
  const meta = JSON.parse(Buffer.from(d.res.headers.get(ARTICLE_HEADER)!, "base64url").toString("utf8"));
  assert.equal(meta.words, 8);
});

test("a binary body is never fed to the extractor: raw, byte for byte", async () => {
  const pdf = new Uint8Array([37, 80, 68, 70, 0, 255]);
  const d = await deliverForAgent(new Response(pdf, { headers: { "content-type": "application/pdf" } }), "text/markdown", "https://x.test/a.pdf");
  assert.equal(d.extraction, "raw");
  assert.deepEqual([...new Uint8Array(await d.res.arrayBuffer())], [...pdf]);
});

test("HTML with no readable article: raw, served as it was", async () => {
  const d = await deliverForAgent(html("<p>tiny</p>"), "text/markdown", "https://x.test/a");
  assert.equal(d.extraction, "raw");
  assert.equal(await d.res.text(), "<p>tiny</p>");
});

test("status and unrelated headers survive the rewrap", async () => {
  const d = await deliverForAgent(html(ARTICLE, { "x-origin": "kept" }), "text/markdown", "https://x.test/a");
  assert.equal(d.res.status, 200);
  assert.equal(d.res.headers.get("x-origin"), "kept");
});
