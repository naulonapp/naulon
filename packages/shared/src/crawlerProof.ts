/**
 * How each crawler operator lets a site check that a request naming its crawler came from it.
 * One row per published source. `forgedEligible` is a judgement about the SOURCE, not the fetch:
 * only a ranges file the operator visibly maintains may ever turn a claim into `forged`. Every
 * other row is checked and recorded, and at worst reads `unverified`. Raising a row to eligible is
 * a change to this file with the operator's own page cited in `doc`.
 */

export type ProofKind = "ranges" | "signature" | "none";
export type IdentityCheck = "signature" | "ip-verified" | "unverified" | "forged";

export interface CrawlerProofSource {
  id: string;
  operator: string;
  /** Lowercase UA substrings that claim this operator. */
  fragments: readonly string[];
  kind: ProofKind;
  /** Range files, Google's `{creationTime, prefixes}` shape. Empty unless `kind` is `ranges`. */
  sources: readonly string[];
  /** The operator's own page that documents the source. Empty when the operator documents none. */
  doc: string;
  forgedEligible: boolean;
}

const OPENAI_DOC = "https://developers.openai.com/api/docs/bots";
const PERPLEXITY_DOC = "https://docs.perplexity.ai/docs/resources/perplexity-crawlers";

export const CRAWLER_PROOF: readonly CrawlerProofSource[] = [
  { id: "google", operator: "Google", fragments: ["googlebot"], kind: "ranges",
    sources: ["https://developers.google.com/static/crawling/ipranges/common-crawlers.json"],
    doc: "https://developers.google.com/crawling/docs/crawlers-fetchers/verify-google-requests", forgedEligible: true },
  { id: "bing", operator: "Microsoft", fragments: ["bingbot"], kind: "ranges",
    sources: ["https://www.bing.com/toolbox/bingbot.json"],
    doc: "https://www.bing.com/webmasters/help/how-to-verify-bingbot-3905dc26", forgedEligible: true },
  { id: "duckduckgo", operator: "DuckDuckGo", fragments: ["duckduckbot"], kind: "ranges",
    sources: ["https://duckduckgo.com/duckduckbot.json"],
    doc: "https://duckduckgo.com/duckduckgo-help-pages/results/duckduckbot", forgedEligible: true },
  { id: "apple", operator: "Apple", fragments: ["applebot"], kind: "ranges",
    sources: ["https://search.developer.apple.com/applebot.json"],
    doc: "https://support.apple.com/en-us/119829", forgedEligible: true },
  { id: "openai-gptbot", operator: "OpenAI", fragments: ["gptbot"], kind: "ranges",
    sources: ["https://openai.com/gptbot.json"], doc: OPENAI_DOC, forgedEligible: true },
  { id: "openai-searchbot", operator: "OpenAI", fragments: ["oai-searchbot"], kind: "ranges",
    sources: ["https://openai.com/searchbot.json"], doc: OPENAI_DOC, forgedEligible: true },
  { id: "openai-chatgpt-user", operator: "OpenAI", fragments: ["chatgpt-user"], kind: "ranges",
    sources: ["https://openai.com/chatgpt-user.json"], doc: OPENAI_DOC, forgedEligible: true },
  { id: "anthropic", operator: "Anthropic", fragments: ["claudebot", "claude-user", "claude-searchbot"], kind: "ranges",
    sources: ["https://claude.com/crawling/bots.json"],
    doc: "https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler",
    forgedEligible: true },
  { id: "commoncrawl", operator: "Common Crawl", fragments: ["ccbot"], kind: "ranges",
    sources: ["https://index.commoncrawl.org/ccbot.json"], doc: "https://commoncrawl.org/ccbot", forgedEligible: true },
  { id: "mistral", operator: "Mistral", fragments: ["mistralai-user"], kind: "ranges",
    sources: ["https://mistral.ai/mistralai-user-ips.json"], doc: "https://mistral.ai/mistralai-user-ips.json", forgedEligible: true },
  // The file carries no sign of maintenance: its own creationTime trails its siblings' by many months.
  { id: "perplexity-bot", operator: "Perplexity", fragments: ["perplexitybot"], kind: "ranges",
    sources: ["https://www.perplexity.ai/perplexitybot.json"], doc: PERPLEXITY_DOC, forgedEligible: false },
  { id: "perplexity-user", operator: "Perplexity", fragments: ["perplexity-user"], kind: "ranges",
    sources: ["https://www.perplexity.ai/perplexity-user.json"], doc: PERPLEXITY_DOC, forgedEligible: false },
  // The published list is an HTML page, not a file a parser can trust.
  { id: "amazon", operator: "Amazon", fragments: ["amazonbot", "amzn-user"], kind: "none",
    sources: [], doc: "https://developer.amazon.com/amazonbot", forgedEligible: false },
  { id: "exa", operator: "Exa", fragments: ["exasearchbot"], kind: "signature",
    sources: [], doc: "https://crawler.exa.ai", forgedEligible: false },
  { id: "meta", operator: "Meta", fragments: ["meta-externalagent", "meta-externalfetcher"], kind: "none",
    sources: [], doc: "https://developers.facebook.com/documentation/sharing/webmasters/web-crawlers", forgedEligible: false },
  { id: "bytedance", operator: "ByteDance", fragments: ["bytespider"], kind: "none",
    sources: [], doc: "", forgedEligible: false },
];

/** Proxies whose addresses are never a caller's own. */
export const PROXY_SOURCES: Readonly<Record<string, readonly string[]>> = {
  cloudflare: ["https://www.cloudflare.com/ips-v4", "https://www.cloudflare.com/ips-v6"],
};

/** Every operator a UA names, with the fragment that named it. Order follows the table. */
export function claimsIn(
  ua: string,
  table: readonly { id: string; fragments: readonly string[] }[] = CRAWLER_PROOF,
): Array<{ id: string; fragment: string }> {
  const lower = ua.toLowerCase();
  const out: Array<{ id: string; fragment: string }> = [];
  for (const row of table) {
    const hit = row.fragments.find((f) => lower.includes(f));
    if (hit) out.push({ id: row.id, fragment: hit });
  }
  return out;
}
