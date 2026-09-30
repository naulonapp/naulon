/**
 * What an agent receives for a read it paid for or holds a licence to.
 *
 * When the request ranks `text/markdown` above HTML and the origin answered HTML, the article is
 * extracted and sent as markdown. The caller hashes `bytes`, so the licence covers exactly the text
 * the agent holds and a later check of that copy succeeds. Everything else is sent as the origin
 * sent it: HTML to a caller that asked for HTML, a body the origin already wrote as markdown, and
 * any page with no readable article, which is labelled `raw` rather than guessed at.
 *
 * Only the agent paths call this. A human's read never reaches it, whatever `Accept` it sends.
 */
import { describeMarkdown, extractArticle, isHtml, isMarkdown, prefersMarkdown, type Extraction } from "@naulon/extract";

export const EXTRACTION_HEADER = "x-naulon-extraction";
/** base64url JSON of the article metadata (`ArticleMeta` from `@naulon/extract`), never the text. */
export const ARTICLE_HEADER = "x-naulon-article";

export interface Delivered {
  res: Response;
  /** Exactly the body `res` carries, for hashing. */
  bytes: Uint8Array;
  /** Absent when the caller asked for HTML and got it unchanged. */
  extraction?: Exclude<Extraction, "client">;
  sourceBytes: number;
}

/**
 * A delivered read's body depends on `Accept`. Paid responses are already `no-store`, so no shared
 * cache holds one; this states the variance for anything that inspects it. Merged, never clobbered.
 */
export function varyOnAccept(headers: Headers): void {
  const current = headers.get("vary");
  const has = current?.split(",").some((v) => v.trim() === "*" || v.trim().toLowerCase() === "accept") ?? false;
  if (!has) headers.set("vary", current ? `${current}, Accept` : "Accept");
}

const encodeMeta = (meta: object): string => Buffer.from(JSON.stringify(meta)).toString("base64url");

/**
 * Rebuild the response around a body. A replaced body drops the origin's validators and length:
 * they describe the HTML, and a cache or client revalidating markdown against them would be told
 * the wrong thing.
 */
function withBody(from: Response, body: Uint8Array, contentType?: string): Response {
  const headers = new Headers(from.headers);
  headers.delete("content-length");
  if (contentType) {
    headers.set("content-type", contentType);
    headers.delete("etag");
    headers.delete("last-modified");
    headers.delete("content-md5");
  }
  varyOnAccept(headers);
  return new Response(body, { status: from.status, statusText: from.statusText, headers });
}

export async function deliverForAgent(materialized: Response, accept: string | null, url: string): Promise<Delivered> {
  const source = new Uint8Array(await materialized.arrayBuffer());
  const contentType = materialized.headers.get("content-type");
  const asServed = (extraction?: Delivered["extraction"]): Delivered => {
    const res = withBody(materialized, source);
    if (extraction) res.headers.set(EXTRACTION_HEADER, extraction);
    return { res, bytes: source, sourceBytes: source.byteLength, ...(extraction ? { extraction } : {}) };
  };

  if (!prefersMarkdown(accept)) return asServed();
  if (isMarkdown(contentType)) {
    const delivered = asServed("passthrough");
    delivered.res.headers.set(ARTICLE_HEADER, encodeMeta(describeMarkdown(new TextDecoder().decode(source))));
    return delivered;
  }
  if (!isHtml(contentType)) return asServed("raw");

  const article = extractArticle(new TextDecoder().decode(source), url);
  if (!article) return asServed("raw");
  const { markdown, ...meta } = article;
  const bytes = new TextEncoder().encode(markdown);
  const res = withBody(materialized, bytes, "text/markdown; charset=utf-8");
  res.headers.set(EXTRACTION_HEADER, "gate");
  res.headers.set(ARTICLE_HEADER, encodeMeta(meta));
  return { res, bytes, extraction: "gate", sourceBytes: source.byteLength };
}
