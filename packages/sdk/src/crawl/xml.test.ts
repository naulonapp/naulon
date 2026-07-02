import { test } from "node:test";
import assert from "node:assert/strict";
import { parseXml, toArray, textOf } from "./xml.ts";

test("toArray normalizes one child, many children, and absence", () => {
  assert.deepEqual(toArray(undefined), []);
  assert.deepEqual(toArray(null), []);
  assert.deepEqual(toArray("a"), ["a"]);
  assert.deepEqual(toArray(["a", "b"]), ["a", "b"]);
});

test("textOf reads a bare string, mixed-content #text, and CDATA", () => {
  assert.equal(textOf("hello"), "hello");
  assert.equal(textOf({ "#text": "mixed" }), "mixed");
  assert.equal(textOf({ __cdata: "cdata body" }), "cdata body");
  assert.equal(textOf(42), "");
  assert.equal(textOf(undefined), "");
});

test("parseXml keeps tag values as strings (a numeric-looking slug stays a string)", () => {
  const doc = parseXml("<root><guid>2026</guid></root>");
  const root = doc["root"] as Record<string, unknown>;
  assert.equal(root["guid"], "2026");
  assert.equal(typeof root["guid"], "string");
});

test("parseXml surfaces attributes under @_ (Atom link href is reachable)", () => {
  const doc = parseXml(`<feed><entry><link rel="alternate" href="https://x/essays/a"/></entry></feed>`);
  const entry = ((doc["feed"] as Record<string, unknown>)["entry"]) as Record<string, unknown>;
  const link = entry["link"] as Record<string, unknown>;
  assert.equal(link["@_href"], "https://x/essays/a");
});
