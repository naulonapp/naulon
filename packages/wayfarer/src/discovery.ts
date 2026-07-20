/**
 * Discovery sources — where the agent finds candidate essays for a topic. The
 * agent reads only free, public teasers here; it hasn't paid for anything yet.
 *
 * One seam, two implementations (parallel to the `Buyer` seam in buyer.ts):
 *   - rssSource     — fetch + parse the publisher's live `/rss.xml`.
 *   - catalogSource — a bespoke CATALOG_URL JSON endpoint ({slug,title,summary}[]).
 *
 * Precedence (selectSource): RSS_URL > PUBLISHER_URL > CATALOG_URL, then refuse.
 *
 * No fail-open: a *failed* fetch throws — it never resolves to fabricated
 * fixtures wearing the shape of a real catalog (the defect that shipped demo
 * essays to real buyers). A *successful* fetch that is genuinely empty returns
 * `[]` — the honest "found nothing", not an error and not substituted data.
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

/**
 * A catalog endpoint: bare `Candidate[]` (legacy, single page) or the paginated
 * `{ entries, nextCursor }` envelope. Filters server-side by `?q=topic`; follows
 * `nextCursor` (as `?cursor=`) up to 50 pages so a large fleet catalog enumerates.
 * A non-OK response throws (including mid-pagination — a partial catalog is never
 * silently returned as if complete). A clean but empty response yields `[]`.
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
        if (!res.ok) throw new Error(`catalog fetch failed (${res.status}) for ${u.toString()}`);
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
 * over the *real* catalog rather than a discovery-time substring filter. A
 * non-OK response throws; a valid feed that parses to zero candidates returns
 * `[]` (honest empty — `parseRss` is lenient, so `[]` means "no items").
 */
export function rssSource(rssUrl: string): DiscoverySource {
  return {
    async discover(): Promise<Candidate[]> {
      const res = await agentFetch(rssUrl, {
        headers: { "user-agent": AGENT_UA, accept: "application/rss+xml, application/xml" },
      });
      if (!res.ok) throw new Error(`rss fetch failed (${res.status}) for ${rssUrl}`);
      return rssToCandidates(await res.text());
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

/** Pick the discovery source from config (see precedence above). Throws when
 *  none is configured — the agent has nowhere to discover, and inventing a
 *  bundled catalog would be a fail-open. */
export function selectSource(): DiscoverySource {
  const cfg = getConfig();
  const rss = rssUrlFromConfig();
  if (rss) return rssSource(rss);
  if (cfg.CATALOG_URL) return catalogSource(cfg.CATALOG_URL);
  throw new Error("no discovery source configured — set RSS_URL, PUBLISHER_URL, or CATALOG_URL");
}
