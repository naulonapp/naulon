/**
 * crawl/xml.ts — the one XML parse wrapper (fast-xml-parser).
 *
 * RSS/Atom/sitemap are all XML; this is the only place the parser is configured, so every
 * adapter reads feeds the same way. Text values stay strings (a slug like `2026` must not
 * become the number 2026), attributes surface under `@_` so `<link href=…>` (Atom) is
 * reachable, and namespaced tags (`dc:creator`, `content:encoded`) keep their prefix.
 *
 * WHY WE STAY ON fast-xml-parser 4.x. `npm audit` flags 4.x for "XMLBuilder: XML Comment and
 * CDATA Injection via Unescaped Delimiters", and the only fix is 5.x — a major. That advisory
 * is against **XMLBuilder**, the WRITE side. This package imports `XMLParser` and nothing else
 * (there is no `XMLBuilder` anywhere in the tree), so the vulnerable API is never constructed
 * and the finding is unreachable. Taking a major on the parser that reads every publisher's
 * feed, to fix a writer we do not call, is the worse trade. Re-decide the moment anything here
 * EMITS xml: then the advisory is live and 5.x is mandatory, not optional.
 */
import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false, // keep `<guid>2026</guid>` a string, not the number 2026
  parseAttributeValue: false,
  trimValues: true,
  cdataPropName: "__cdata", // CDATA (common in RSS) folds into the tag's text value
  processEntities: true,
});

/** Parse an XML document. Throws on malformed input (an adapter treats a throw as "no feed"). */
export function parseXml(xml: string): Record<string, unknown> {
  return parser.parse(xml) as Record<string, unknown>;
}

/** fast-xml-parser yields a single object for one child and an array for many. Normalize to an
 *  array so adapters iterate uniformly (`<item>`×1 and ×N look the same). */
export function toArray<T>(x: T | T[] | undefined | null): T[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

/** Read a node's text whether it is a bare string, a `{ "#text" }` object (mixed content), or a
 *  CDATA `{ __cdata }`. Returns "" for anything else. */
export function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o["__cdata"] === "string") return o["__cdata"];
    if (typeof o["#text"] === "string") return o["#text"];
  }
  return "";
}
