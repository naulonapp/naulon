/**
 * Turning a publisher's stated terms into a refusal on the wire.
 *
 * `TermsPolicy` says what a publisher permits. Emitting it in the licence document tells an
 * honest reader; it does nothing to one that does not read licences, which is the population the
 * policy was written for. This module is the other half: which requests a stated prohibition
 * refuses outright.
 *
 * Three facts are observable at a gated request, and the rules below use only those: whether the
 * caller is a machine, which crawler the registry recognises it as, and what a toll would grant
 * if one were sold. Anything finer is a claim the caller makes about itself.
 */
import { CRAWLER_REGISTRY, type RegistryCrawler } from "./crawlerRegistry.ts";
import type { TermsPolicy } from "./publisher.ts";

/** The terms a refusal can be issued under. `ai-index` is deliberately absent; see below. */
export type ProhibitedTerm = "ai-input" | "ai-train" | "search";

export interface Prohibition {
  /** The stated term this request was refused under. */
  term: ProhibitedTerm;
  /** Why, in the publisher's vocabulary, safe to log and to show. */
  reason: string;
}

export interface ProhibitionInput {
  /** The publisher's stated terms. Absent or empty refuses nothing. */
  policy?: TermsPolicy | undefined;
  /** The raw user agent. A claim about identity, never proof of one. */
  ua: string;
  /** The Web Bot Auth identity, when the request carried a valid signature. */
  verifiedAgent?: string | null | undefined;
  /** What the classifier decided this request is. */
  classifiedAs: "human" | "agent";
}

function registryHit(ua: string, verifiedAgent?: string | null): RegistryCrawler | undefined {
  const hay = `${ua} ${verifiedAgent ?? ""}`.toLowerCase();
  return CRAWLER_REGISTRY.find((c) => hay.includes(c.fragment));
}

/**
 * The refusal a request earns under the publisher's terms, or null to carry on.
 *
 * The rules, and why each one stops where it does:
 *
 * **A human is never refused.** Inherited from the gate's oldest promise and not negotiable by
 * any policy: people read free, forever.
 *
 * **A prohibited `ai-input` refuses every agent, identified or not.** A per-read toll grants
 * `ai-input` and nothing else, so an agent asking for a gated page is asking for exactly the term
 * being refused. Recognising the caller first would let an unlisted user agent walk through the
 * one prohibition a publisher is most likely to mean, and a user agent is the easiest field in a
 * request to change.
 *
 * **A prohibited `ai-train` refuses the crawlers that collect a corpus, and only those.** The
 * registry knows which crawlers those are. An unidentified agent buying a single read is not
 * asking for a training corpus, and refusing it would take a priced read away from a publisher
 * who chose to sell one, which is the opposite of what the policy said.
 *
 * **A prohibited `search` refuses search crawlers even though they read free.** Free is the
 * allowlist's answer to "does this pay", not the publisher's answer to "may this index me", and
 * a crawler is not a person whatever the classifier concluded about payment.
 *
 * **A prohibited `ai-index` refuses nothing here.** A retrieval index is built by the same
 * crawlers, over the same requests, as an ordinary assistant read; the wire cannot tell the two
 * apart. Refusing on it would mean refusing assistants a publisher may have priced. It is stated
 * in the licence, carried into the record, and honoured by every reader that checks terms before
 * spending.
 */
export function prohibitedUse(input: ProhibitionInput): Prohibition | null {
  const { policy, ua, verifiedAgent, classifiedAs } = input;
  if (!policy) return null;

  const crawler = registryHit(ua, verifiedAgent);

  if (policy.search === "prohibit" && crawler?.category === "search") {
    return { term: "search", reason: `${crawler.name} is refused: this site prohibits search indexing` };
  }

  if (policy["ai-train"] === "prohibit" && crawler?.category === "ai-training") {
    return { term: "ai-train", reason: `${crawler.name} is refused: this site prohibits AI training` };
  }

  // A recognised AI crawler is refused even when a per-crawler allow made the classifier call it a
  // person. The allow is an exception to the PRICE, and a refused term is not for sale at any price,
  // so a per-bot rule can tighten a refusal but never undo one.
  const aiCrawler = crawler?.category === "ai-assistant" || crawler?.category === "ai-training";
  if ((classifiedAs === "agent" || aiCrawler) && policy["ai-input"] === "prohibit") {
    const who = crawler ? crawler.name : "this agent";
    return { term: "ai-input", reason: `${who} is refused: this site prohibits ai-input, so agent reads are not for sale` };
  }

  return null;
}
