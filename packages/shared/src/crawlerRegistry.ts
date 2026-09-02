/**
 * Curated known-crawler registry — the shared vocabulary any naulon surface uses to let a
 * publisher pick a policy per crawler instead of typing user-agent substrings by hand.
 *
 * The GATE never reads this. It only ever receives resolved fragment lists on
 * `PublisherConfig.crawlerPolicy`; this file exists so the surfaces that AUTHOR a policy
 * present the same names, operators and defaults rather than each inventing a list.
 *
 * Fragments are the crawler's real UA token, lowercase (verified against Cloudflare
 * Radar's verified-bot directory + darkvisitors.com — update via PR, never invent).
 *
 * Verification notes (2026-07-03):
 *   • applebot-extended: Apple notes this bot "does not crawl webpages"; it
 *     controls whether Applebot-crawled data may be used for Apple Intelligence
 *     training. The UA token "Applebot-Extended" is documented in the UA string
 *     format by Apple and third-party sources and is retained here accordingly.
 *
 * Web Bot Auth directory verification (2026-07-04, live GETs against
 * /.well-known/http-message-signatures-directory — 200 + the directory
 * content-type + an Ed25519 JWKS is the bar; an HTML 200 is a SPA catch-all,
 * not a directory):
 *   • chatgpt.com — REAL directory (signature_agent "https://chatgpt.com",
 *     purpose "ai"). OpenAI's own bot docs still list only IP ranges for
 *     GPTBot/ChatGPT-User/OAI-SearchBot; the signing plane is the ChatGPT
 *     agent traffic. The badge therefore claims operator capability, never
 *     "this UA signs".
 *   • ahrefs.com — REAL directory (2 Ed25519 keys).
 *   • naulon.app — a live, signature-VALID directory (re-confirmed 2026-07-16), served
 *     under the apex; keyid BYljRezMWMjeJPiDfKtnznxXk9HwkWdhLR79i_9fuYI.
 *   • Re-probe 2026-08-18 — the list GREW, which is why the note above says to re-probe:
 *     meta.com now serves a REAL directory (3 Ed25519 keys, correct content-type, via a
 *     301 to www), so its three rows below carry the badge as of this date. you.com also
 *     serves a REAL directory (1 key) — deliberately NOT given a row, because YouBot is
 *     still in the "known gap" list above and a signer with no crawler row is nothing for
 *     a publisher to act on. Add both together or neither.
 *   • Probed 2026-09-02 — crawler.exa.ai serves a REAL directory (1 Ed25519 key, kid
 *     sDCpsJpgItYcmF_KhZozOUGIGL6a49yxE3f0yQR5SIA, correct content-type). The APEX exa.ai
 *     404s with SPA HTML, so this is the first row whose directoryHost is NOT an apex — the
 *     operator publishes under the crawler subdomain and says so on its own page. Exa signs
 *     EVERY request (Signature/Signature-Input/Signature-Agent), which means the gate's
 *     verified-identity branch charges it at 0.98 whatever the UA row below does; the row
 *     exists so a publisher can SEE the crawler and decide, not to make the toll happen.
 *   • NOT publishing (re-probed 2026-08-18): anthropic.com/claude.com, perplexity.ai,
 *     google.com, bing.com, apple.com, amazon.com, bytedance.com, duckduckgo.com,
 *     cohere.com, brave.com, huggingface.co, cloudflare.com. (openai.com 404s — OpenAI's
 *     directory is on chatgpt.com, which is the row we carry.)
 *     Re-probe when operators announce Web Bot Auth support.
 *
 * Operator-doc re-verification (2026-08-03) — every operator page re-read, which is how
 * the six additions below were found. The audit plane is what prompted it: one publisher's
 * third-biggest traffic source was Meta-WebIndexer, and it had no row here at all, so it
 * was neither charged nor refusable — it simply had no name.
 *   • Meta documents FIVE tokens, this file listed one. Added Meta-WebIndexer (AI-search
 *     index that cites and links back — free, like every other search indexer) and
 *     Meta-ExternalFetcher (fetches a link "at a user's request" — the citation moment,
 *     charged). Deliberately still absent: Meta-ExternalAds and FacebookExternalHit, which
 *     validate ad landing pages and render link previews — neither reads content for an AI,
 *     so neither belongs in a citation toll's vocabulary. Same reason OAI-AdsBot is absent.
 *   • Amazon documents THREE, this file listed one. Added Amzn-SearchBot ("does not crawl
 *     content for generative AI model training" — free) and Amzn-User (live fetch answering
 *     a user's question — charged).
 *   • Added MistralAI-User (user-triggered retrieval). Mistral publishes no training-crawler
 *     token.
 *   • Verified complete against their own docs, no change needed: OpenAI (GPTBot,
 *     ChatGPT-User, OAI-SearchBot), Anthropic (ClaudeBot, Claude-User, Claude-SearchBot —
 *     and still no anthropic-ai/claude-web), Apple (Applebot, Applebot-Extended).
 *   • Added 2026-09-02: ExaSearchBot (Exa), read off crawler.exa.ai — see the divergence
 *     comment on its row. Exa was the second signer found publishing a real key directory
 *     while having no row here, which is the you.com situation resolved the other way: this
 *     one gets the row, because unlike YouBot its operator publishes a crawler page.
 *   • Known gap, deliberate: xAI (Grok-User/GrokBot), cohere-ai, YouBot, Diffbot and
 *     omgili publish NO operator documentation page. The bar above is the operator's own
 *     doc, cross-checked against Cloudflare Radar / darkvisitors — a token sourced only
 *     from a third-party blog list is exactly the "never invent" this file forbids. Add
 *     them when a primary source exists.
 */
export type CrawlerCategory = "ai-training" | "ai-assistant" | "search" | "archiver" | "seo";

export interface RegistryCrawler {
  id: string;
  name: string;
  operator: string;
  /** Lowercase UA substring the gate matches on. */
  fragment: string;
  category: CrawlerCategory;
  /**
   * True when this crawler's UA fragment matches a built-in KNOWN_AGENT_UA entry in the
   * gate — meaning the gate already charges it by default without any publisher policy.
   * Mirrors the gate's built-in recognition list at authoring time; keep in sync when the
   * gate list changes.
   */
  defaultCharged: boolean;
  /**
   * The Web Bot Auth key-directory host this crawler's OPERATOR publishes
   * (https://<host>/.well-known/http-message-signatures-directory), when it
   * publishes one — live-verified at authoring time, never invented (see the
   * verification notes above). This is exactly the verified identity the gate
   * reports for requests the operator signs, and the fragment a publisher adds
   * (as a custom rule) to allow/block that identity outright. Operator-level
   * fact: it does NOT claim this specific UA signs its requests.
   */
  directoryHost?: string;
}

export const CRAWLER_REGISTRY: RegistryCrawler[] = [
  // AI training
  { id: "gptbot", name: "GPTBot", operator: "OpenAI", fragment: "gptbot", category: "ai-training", defaultCharged: true, directoryHost: "chatgpt.com" },
  { id: "claudebot", name: "ClaudeBot", operator: "Anthropic", fragment: "claudebot", category: "ai-training", defaultCharged: true },
  // Google-Extended is deliberately absent: it is a robots.txt-only token with NO UA string (per Google's crawler docs) — a UA-matched row for it could never fire and would be a lying UI.
  { id: "ccbot", name: "CCBot", operator: "Common Crawl", fragment: "ccbot", category: "ai-training", defaultCharged: true },
  { id: "bytespider", name: "Bytespider", operator: "ByteDance", fragment: "bytespider", category: "ai-training", defaultCharged: true },
  { id: "applebot-extended", name: "Applebot-Extended", operator: "Apple", fragment: "applebot-extended", category: "ai-training", defaultCharged: true },
  { id: "meta-external", name: "Meta-ExternalAgent", operator: "Meta", fragment: "meta-externalagent", category: "ai-training", defaultCharged: true, directoryHost: "meta.com" },
  { id: "amazonbot", name: "Amazonbot", operator: "Amazon", fragment: "amazonbot", category: "ai-training", defaultCharged: true },
  // AI assistants (fetch on a user's behalf). User-triggered fetches are the
  // citation moment — machine-only UAs, charged by default since the 2026-07-03
  // KNOWN_AGENT_UA refresh (an x402-capable agent answers the 402 by paying).
  { id: "chatgpt-user", name: "ChatGPT-User", operator: "OpenAI", fragment: "chatgpt-user", category: "ai-assistant", defaultCharged: true, directoryHost: "chatgpt.com" },
  { id: "claude-user", name: "Claude-User", operator: "Anthropic", fragment: "claude-user", category: "ai-assistant", defaultCharged: true },
  // PerplexityBot is a DELIBERATE divergence from its operator's doc, and the only entry in
  // this file that is. Perplexity documents it as a search crawler "not used to crawl content
  // for AI foundation models", which by the search rule below would read free. It is charged
  // anyway: it is the crawler with the best-documented history of retrieving content while
  // evading the controls a publisher set (Cloudflare's stealth-crawling investigation, cited
  // in the 2026-06-23 identity research), so "it indexes for search" is not a promise this
  // file will price on. Decision re-affirmed 2026-08-03. Perplexity-User — the citation
  // moment — is charged on the ordinary assistant rule, not this one.
  { id: "perplexitybot", name: "PerplexityBot", operator: "Perplexity", fragment: "perplexitybot", category: "ai-assistant", defaultCharged: true },
  { id: "perplexity-user", name: "Perplexity-User", operator: "Perplexity", fragment: "perplexity-user", category: "ai-assistant", defaultCharged: true },
  { id: "meta-externalfetcher", name: "Meta-ExternalFetcher", operator: "Meta", fragment: "meta-externalfetcher", category: "ai-assistant", defaultCharged: true, directoryHost: "meta.com" },
  { id: "amzn-user", name: "Amzn-User", operator: "Amazon", fragment: "amzn-user", category: "ai-assistant", defaultCharged: true },
  { id: "mistralai-user", name: "MistralAI-User", operator: "Mistral", fragment: "mistralai-user", category: "ai-assistant", defaultCharged: true },
  // ExaSearchBot is the SECOND deliberate divergence from an operator's own doc, and it
  // diverges for a different reason than PerplexityBot above — not evasion, product shape.
  // Exa's crawler page calls it a search engine ("Its purpose is search and retrieval:
  // connecting people and applications to your content and sending them back to your site"),
  // which by the search rule below would read free. Two facts decide otherwise, both from
  // Exa's own surfaces:
  //   - The sentence for what the index is FOR is "allows users to find, retrieve, and cite
  //     your content". An application retrieving and citing IS the moment naulon prices.
  //   - Exa's /contents endpoint returns the FULL page text to an API caller, served from
  //     cache by default (maxAgeHours + livecrawlTimeout re-fetch the origin on demand). An
  //     agent handed that text never reaches the origin, so "sending them back to your site"
  //     describes the consumer search UI, not the API. Exa documents exactly ONE token for
  //     both halves, so the tollable half cannot be separated from the free one.
  // The cost is real, which is why this is a decision and not a default: charging it drops
  // the publisher out of Exa's index, consumer surface included. Read off crawler.exa.ai
  // ("Last Updated: July 30, 2026") on 2026-09-02.
  { id: "exasearchbot", name: "ExaSearchBot", operator: "Exa", fragment: "exasearchbot", category: "ai-assistant", defaultCharged: true, directoryHost: "crawler.exa.ai" },
  // naulon's own buy-side citing agent (the wayfarer). Not in the gate's KNOWN_AGENT_UA
  // (defaultCharged:false) — it isn't auto-charged by UA; it answers a 402 by paying via
  // x402, custody-free. directoryHost is live + signature-valid (see the note above).
  { id: "naulon-wayfarer", name: "naulon-wayfarer", operator: "naulon", fragment: "naulon-wayfarer", category: "ai-assistant", defaultCharged: false, directoryHost: "naulon.app" },
  // Search (tolling these deindexes — the UI cautions on Charge/Block). The AI
  // search indexers (OAI-SearchBot, Claude-SearchBot) sit here, not with the
  // assistants: they index for search surfaces, so they read free like Googlebot.
  { id: "googlebot", name: "Googlebot", operator: "Google", fragment: "googlebot", category: "search", defaultCharged: false },
  { id: "oai-searchbot", name: "OAI-SearchBot", operator: "OpenAI", fragment: "oai-searchbot", category: "search", defaultCharged: false, directoryHost: "chatgpt.com" },
  { id: "claude-searchbot", name: "Claude-SearchBot", operator: "Anthropic", fragment: "claude-searchbot", category: "search", defaultCharged: false },
  { id: "bingbot", name: "Bingbot", operator: "Microsoft", fragment: "bingbot", category: "search", defaultCharged: false },
  { id: "duckduckbot", name: "DuckDuckBot", operator: "DuckDuckGo", fragment: "duckduckbot", category: "search", defaultCharged: false },
  { id: "applebot", name: "Applebot", operator: "Apple", fragment: "applebot", category: "search", defaultCharged: false },
  { id: "meta-webindexer", name: "Meta-WebIndexer", operator: "Meta", fragment: "meta-webindexer", category: "search", defaultCharged: false, directoryHost: "meta.com" },
  { id: "amzn-searchbot", name: "Amzn-SearchBot", operator: "Amazon", fragment: "amzn-searchbot", category: "search", defaultCharged: false },
  // Archivers
  { id: "ia-archiver", name: "Internet Archive", operator: "Internet Archive", fragment: "ia_archiver", category: "archiver", defaultCharged: false },
  // SEO tools
  { id: "ahrefsbot", name: "AhrefsBot", operator: "Ahrefs", fragment: "ahrefsbot", category: "seo", defaultCharged: false, directoryHost: "ahrefs.com" },
  { id: "semrushbot", name: "SemrushBot", operator: "Semrush", fragment: "semrushbot", category: "seo", defaultCharged: false },
];
