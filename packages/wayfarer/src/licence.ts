/**
 * The agent's view of a publisher's PUBLISHED terms — RSL, resolved and cached for one run.
 *
 * Why the buyer cares about a document it is not obliged to read: the 402 says what a page costs,
 * and nothing else. It does not say whether the publisher permits an AI to ground an answer in the
 * page, whether they forbid training on it, or whether they route licensing through a server that
 * makes the inline price meaningless. Those are the publisher's own words, published in the
 * standard ~1,500 organisations already use, and they are the only evidence of CONSENT an agent can
 * cite afterwards. An operator's allowlist cannot supply consent on a publisher's behalf.
 *
 * ## The cache is the whole design
 *
 * A licence found through `robots.txt` governs an entire ORIGIN, so it is fetched once and answers
 * for every candidate on that host — including the negative answer, which is the common one and the
 * expensive one to re-learn. A licence found on the PAGE (Link header, HTML link, inline document)
 * is per-URL by construction and is never written into the origin cache; caching it there would
 * apply one article's terms to a whole site.
 *
 * In-flight requests are deduplicated, so ten candidates on one host produce one `robots.txt` fetch
 * rather than ten. That matters twice: it is a stranger's server, and a research run that hammers a
 * publisher to ask permission has answered its own question badly.
 */
import {
  locateFromObserved,
  locateFromRobots,
  termsForUrl,
  type LocatedLicence,
  type ObservedResponse,
  type RslSource,
  type RslTermsForUrl,
} from "@naulon/sdk/rsl";
import type { Fetcher } from "@naulon/sdk/crawl";

/** What the agent learned about one URL. `terms: null` = nothing published that covers it. */
export interface LicenceLookup {
  terms: RslTermsForUrl | null;
  /** Which association mechanism the document came from — evidence for the decision log. */
  source?: RslSource;
  documentUrl?: string;
}

export interface LicenceResolverOptions {
  /** Per-origin guarded fetcher factory. Defaults to the SDK's SSRF-guarded implementation. */
  fetcherFor?: (origin: string) => Fetcher;
  /** The agent's robots.txt token, so a `License:` inside its own User-agent group is honoured. */
  userAgent?: string;
  /**
   * How long an origin-level answer stays fresh. Ten minutes: long enough that one research run
   * makes one request per host, short enough that a publisher who changes their price is not
   * quoted the old one for an hour. naulon's own document declares a one-day max-age; this is
   * deliberately stricter, because being wrong here means underpaying someone.
   */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** Nothing published — a shared frozen value, so a caller cannot mutate one lookup into another. */
const NONE: LicenceLookup = Object.freeze({ terms: null });

export interface LicenceResolver {
  /**
   * Terms for one URL. `observed` is a response the caller already holds for that exact URL — a
   * buying agent's 402 probe is one — and lets the page-level channels answer with no extra
   * request.
   */
  forUrl(url: string, observed?: ObservedResponse): Promise<LicenceLookup>;
  /** Origins resolved this session, for a run summary. */
  originsSeen(): number;
}

export function makeLicenceResolver(opts: LicenceResolverOptions = {}): LicenceResolver {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  /** origin → the origin-wide document (or null), with the time it was learned. */
  const cache = new Map<string, { located: LocatedLicence | null; at: number }>();
  /** origin → an in-flight robots lookup, so concurrent candidates share one request. */
  const inflight = new Map<string, Promise<LocatedLicence | null>>();

  const originDoc = async (origin: string): Promise<LocatedLicence | null> => {
    const hit = cache.get(origin);
    if (hit && Date.now() - hit.at < ttlMs) return hit.located;
    const pending = inflight.get(origin);
    if (pending) return pending;
    const p = locateFromRobots(origin, { ...(opts.fetcherFor ? { fetcherFor: opts.fetcherFor } : {}), ...(opts.userAgent ? { userAgent: opts.userAgent } : {}) })
      .then((located) => {
        cache.set(origin, { located, at: Date.now() });
        return located;
      })
      // A TRANSPORT failure is not cached as "no licence": a timeout is a fact about the network,
      // not about the publisher, and freezing it for the TTL would strip consent evidence from
      // every later candidate on that host. A publisher who genuinely publishes nothing resolves to
      // `null` WITHOUT throwing (see `locateFromRobots`) and is cached, which is the case worth
      // caching — it is the common one.
      .catch(() => null)
      .finally(() => inflight.delete(origin));
    inflight.set(origin, p);
    return p;
  };

  const resolve = (located: LocatedLicence | null, url: string): LicenceLookup => {
    if (!located) return NONE;
    const terms = termsForUrl(located.doc, url, {
      ...(located.associationPath ? { associationPath: located.associationPath } : {}),
    });
    // A document that governs the origin but has no scope covering THIS url says nothing about it.
    // That is a real and different answer from "no document" only to a debugger; to a decision it
    // is the same, and collapsing them here keeps every caller from having to know that.
    if (!terms) return NONE;
    return {
      terms,
      source: located.source,
      ...(located.documentUrl ? { documentUrl: located.documentUrl } : {}),
    };
  };

  return {
    async forUrl(url, observed) {
      let origin: string;
      try {
        origin = new URL(url).origin;
      } catch {
        return NONE;
      }
      if (observed) {
        // Page-level first, and never cached per-origin: it is about this URL only. The
        // one-directional failure it prevents is a site-wide "free" masking a page-level price.
        const found = await locateFromObserved(
          url,
          observed,
          opts.fetcherFor ? { fetcherFor: opts.fetcherFor } : {},
        ).catch(() => null);
        if (found) return resolve(found, url);
      }
      return resolve(await originDoc(origin), url);
    },
    originsSeen: () => cache.size,
  };
}
