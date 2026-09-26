import { test } from "node:test";
import assert from "node:assert/strict";
import { rslContentType, rslResponseHeaders } from "./rsl-media.ts";

const RSL = "application/rsl+xml; charset=utf-8";
const XML = "application/xml; charset=utf-8";

test("a browser gets the licence as XML it can show", () => {
  // Chrome's own Accept for a navigation.
  assert.equal(
    rslContentType("text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"),
    XML,
  );
  assert.equal(rslContentType("TEXT/HTML"), XML);
});

test("a crawler keeps the RSL type", () => {
  assert.equal(rslContentType("application/rsl+xml, application/xml;q=0.9"), RSL);
  assert.equal(rslContentType("*/*"), RSL);
  assert.equal(rslContentType(""), RSL);
  assert.equal(rslContentType(null), RSL);
  assert.equal(rslContentType(undefined), RSL);
});

test("naming the RSL type wins even beside HTML", () => {
  assert.equal(rslContentType("text/html, application/rsl+xml"), RSL);
});

test("every licence response varies on Accept", () => {
  assert.equal(rslResponseHeaders(null).vary, "Accept");
  assert.equal(rslResponseHeaders("text/html").vary, "Accept");
});
