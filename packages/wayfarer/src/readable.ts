/**
 * Turns a paid response into what an agent reads.
 *
 * Every paid read asks for markdown. A server that converted (the naulon gate) says so in
 * `x-naulon-extraction` and is passed through untouched, because its licence hash covers exactly
 * that text. HTML from a server that does not convert is converted here and labelled `client`:
 * any licence hash for that read covers the HTML as delivered, not this text.
 */
import { describeMarkdown, extractArticle, isHtml, isMarkdown, type ArticleMeta, type Extraction } from "@naulon/extract";

export type ReadFormat = "markdown" | "html";

export const readAccept = (format: ReadFormat): string =>
  format === "markdown" ? "text/markdown, text/html;q=0.9" : "text/html";

export interface ReadResult {
  content: string;
  article?: ArticleMeta;
  extraction?: Extraction;
}

function articleHeader(res: Response): ArticleMeta | undefined {
  const raw = res.headers.get("x-naulon-article");
  if (!raw) return undefined;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as ArticleMeta;
    return typeof value.words === "number" && typeof value.approxTokens === "number" ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function readBody(res: Response, url: string, format: ReadFormat): Promise<ReadResult> {
  const content = await res.text();
  if (format === "html") return { content };

  const served = res.headers.get("x-naulon-extraction");
  if (served === "gate" || served === "passthrough" || served === "raw") {
    const article = articleHeader(res);
    return { content, extraction: served, ...(article ? { article } : {}) };
  }

  const contentType = res.headers.get("content-type");
  if (isMarkdown(contentType)) return { content, extraction: "passthrough", article: describeMarkdown(content) };
  if (!isHtml(contentType)) return { content, extraction: "raw" };
  const extracted = extractArticle(content, url);
  if (!extracted) return { content, extraction: "raw" };
  const { markdown, ...article } = extracted;
  return { content: markdown, extraction: "client", article };
}
