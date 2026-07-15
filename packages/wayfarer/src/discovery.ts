/**
 * Discovery sources — where the agent finds candidate essays for a topic. The
 * agent reads only free, public teasers here; it hasn't paid for anything yet.
 *
 * One seam, three implementations (parallel to the `Buyer` seam in buyer.ts):
 *   - rssSource     — fetch + parse the publisher's live `/rss.xml`.
 *   - catalogSource — a bespoke CATALOG_URL JSON endpoint ({slug,title,summary}[]).
 *   - demoSource    — a small bundled catalog so the loop runs with no backend.
 *
 * Precedence (selectSource): RSS_URL > PUBLISHER_URL > CATALOG_URL > demo.
 */
import { getConfig } from "@naulon/shared";
import { rssToCandidates } from "./rss.ts";
import { agentFetch } from "./sign.ts";
import type { Candidate } from "./types.ts";

export interface DiscoverySource {
  /** Free teasers for a topic. `topic` may filter (catalog) or be ignored (rss). */
  discover(topic: string): Promise<Candidate[]>;
}

const AGENT_UA = "naulon-wayfarer/0.1";

/** Mirrors the slugs in examples/meridian/credits.json. */
export const DEMO_CATALOG: Candidate[] = [
  {
    slug: "on-stillness",
    title: "On Stillness",
    summary: "On attention, silence, and the discipline of staying with one thing.",
  },
  {
    slug: "the-naulon",
    title: "The Naulon",
    summary: "The fare paid to cross — payment, passage, and what we owe for what we take.",
  },
  {
    slug: "the-river-and-the-name",
    title: "The River and the Name",
    summary: "Identity, change, and whether a thing survives the renaming of itself.",
  },
];

/** The offline fallback — always returns the bundled catalog. */
export function demoSource(): DiscoverySource {
  return { discover: async () => DEMO_CATALOG };
}

/**
 * A catalog endpoint: bare `Candidate[]` (legacy, single page) or the paginated
 * `{ entries, nextCursor }` envelope. Filters server-side by `?q=topic`; follows
 * `nextCursor` (as `?cursor=`) up to 50 pages so a large fleet catalog enumerates.
 */
export function catalogSource(url: string): DiscoverySource {
  const base = url.replace(/\/$/, "");
  return {
    async discover(topic: string): Promise<Candidate[]> {
      const out: Candidate[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const u = new URL(base);
        u.searchParams.set("q", topic);
        if (cursor) u.searchParams.set("cursor", cursor);
        const res = await agentFetch(u.toString(), { headers: { "user-agent": AGENT_UA } });
        if (!res.ok) return out.length ? out : DEMO_CATALOG;
        const json = (await res.json()) as Candidate[] | { entries: Candidate[]; nextCursor?: string };
        if (Array.isArray(json)) return [...out, ...json]; // legacy shape: single page
        out.push(...json.entries);
        cursor = json.nextCursor;
        if (!cursor) break;
      }
      return out;
    },
  };
}

/**
 * The publisher's live RSS feed. Returns the whole catalog (topic is ignored);
 * the appraise → decide pipeline downstream does relevance, so the agent reasons
 * over the *real* catalog rather than a discovery-time substring filter.
 */
export function rssSource(rssUrl: string): DiscoverySource {
  return {
    async discover(): Promise<Candidate[]> {
      const res = await agentFetch(rssUrl, {
        headers: { "user-agent": AGENT_UA, accept: "application/rss+xml, application/xml" },
      });
      if (!res.ok) return DEMO_CATALOG;
      const candidates = rssToCandidates(await res.text());
      return candidates.length > 0 ? candidates : DEMO_CATALOG;
    },
  };
}

/** Resolve the configured RSS feed URL: explicit RSS_URL, else ${PUBLISHER_URL}/rss.xml. */
function rssUrlFromConfig(): string | undefined {
  const cfg = getConfig();
  if (cfg.RSS_URL) return cfg.RSS_URL;
  if (cfg.PUBLISHER_URL) return `${cfg.PUBLISHER_URL.replace(/\/$/, "")}/rss.xml`;
  return undefined;
}

/** Pick the discovery source from config (see precedence above). */
export function selectSource(): DiscoverySource {
  const cfg = getConfig();
  const rss = rssUrlFromConfig();
  if (rss) return rssSource(rss);
  if (cfg.CATALOG_URL) return catalogSource(cfg.CATALOG_URL);
  return demoSource();
}
