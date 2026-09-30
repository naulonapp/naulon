/**
 * `@naulon/extract`: the article inside a page, as markdown.
 *
 * Readability (the Firefox Reader View engine) picks the article out of the page and turndown
 * writes it as markdown, keeping headings, lists, links, tables and code. It is deterministic and
 * offline: no network, no model. An agent paying for a read is paying for the author's words, and
 * a paraphrase is not those words.
 *
 * When a page has no readable article it returns null rather than a guess, so the caller can serve
 * the page as it was and say so.
 *
 * Dropping page chrome also drops most of the text an attacker controls on a page (comment
 * widgets, hidden asides, injected sidebars) before any model reads it. That is a side effect,
 * not a sanitizer: the article body itself is still untrusted input.
 */
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

/**
 * How the text an agent received was produced.
 * - `gate`: the serving gate extracted it, and the licence hash covers exactly this text.
 * - `passthrough`: the site served markdown itself.
 * - `client`: the agent's own client extracted it from HTML after delivery, so a licence hash
 *   covers the HTML, not this text.
 * - `raw`: no article could be extracted; this is the page as served.
 */
export type Extraction = "gate" | "passthrough" | "client" | "raw";

export interface ArticleMeta {
  title?: string;
  byline?: string;
  /** As the page states it, usually ISO 8601. Not normalised. */
  published?: string;
  canonical?: string;
  lang?: string;
  words: number;
  /** Characters divided by four, rounded up. A budgeting estimate, not a tokenizer count. */
  approxTokens: number;
}

export interface ExtractedArticle extends ArticleMeta {
  markdown: string;
}

/** Below this many characters of article text, the page has no article worth serving as one. */
export const MIN_CONTENT_CHARS = 200;

type ReadabilityDoc = ConstructorParameters<typeof Readability>[0];

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
});
turndown.use(gfm);
turndown.remove(["script", "style", "noscript", "iframe", "form", "button"]);

export function describeMarkdown(markdown: string): Pick<ArticleMeta, "words" | "approxTokens"> {
  const words = markdown.split(/\s+/).filter(Boolean).length;
  return { words, approxTokens: Math.ceil(markdown.length / 4) };
}

interface AttrElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

/** Relative links would point nowhere once the text leaves the page, so resolve them first. */
function absolutise(doc: { querySelectorAll(selector: string): Iterable<AttrElement> }, base: string): void {
  for (const [selector, attr] of [
    ["a[href]", "href"],
    ["img[src]", "src"],
  ] as const) {
    for (const el of doc.querySelectorAll(selector)) {
      const value = el.getAttribute(attr);
      if (!value || value.startsWith("#")) continue;
      try {
        el.setAttribute(attr, new URL(value, base).href);
      } catch {
        // An unparseable reference stays as written.
      }
    }
  }
}

function resolved(href: string | null | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href, base).href;
  } catch {
    return undefined;
  }
}

export function extractArticle(html: string, url: string): ExtractedArticle | null {
  if (!html) return null;
  try {
    const { document } = parseHTML(html);
    if (!document?.documentElement) return null;
    const canonical = resolved(document.querySelector('link[rel="canonical"]')?.getAttribute("href"), url);
    const lang = document.documentElement.getAttribute("lang") || undefined;
    absolutise(document as unknown as { querySelectorAll(selector: string): Iterable<AttrElement> }, url);
    const article = new Readability(document as unknown as ReadabilityDoc, { charThreshold: MIN_CONTENT_CHARS }).parse();
    if (!article?.content) return null;
    if ((article.textContent ?? "").trim().length < MIN_CONTENT_CHARS) return null;
    const markdown = turndown.turndown(article.content).trim();
    if (markdown.length < MIN_CONTENT_CHARS) return null;
    return {
      markdown,
      ...(article.title ? { title: article.title } : {}),
      ...(article.byline ? { byline: article.byline } : {}),
      ...(article.publishedTime ? { published: article.publishedTime } : {}),
      ...(canonical ? { canonical } : {}),
      ...(lang ? { lang } : {}),
      ...describeMarkdown(markdown),
    };
  } catch {
    return null;
  }
}

const mediaType = (contentType: string | null): string => (contentType ?? "").split(";")[0]!.trim().toLowerCase();

export const isHtml = (contentType: string | null): boolean =>
  ["text/html", "application/xhtml+xml"].includes(mediaType(contentType));

export const isMarkdown = (contentType: string | null): boolean => mediaType(contentType) === "text/markdown";

/**
 * True when an `Accept` header ranks `text/markdown` strictly above every HTML type it names.
 * A browser's default header never names markdown, so it never qualifies.
 */
export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  let markdown = 0;
  let html = 0;
  for (const part of accept.split(",")) {
    const [type, ...params] = part.trim().split(";");
    const qParam = params.map((p) => p.trim()).find((p) => p.toLowerCase().startsWith("q="));
    const parsed = qParam ? Number(qParam.slice(2)) : 1;
    const q = Number.isFinite(parsed) ? parsed : 0;
    const t = (type ?? "").trim().toLowerCase();
    if (t === "text/markdown") markdown = Math.max(markdown, q);
    else if (t === "text/html" || t === "application/xhtml+xml") html = Math.max(html, q);
  }
  return markdown > 0 && markdown > html;
}
