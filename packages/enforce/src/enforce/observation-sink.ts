/**
 * Where the in-app middleware reports what it decided — the audit plane's client half.
 *
 * A site enforcing in its own runtime is the ONLY witness to most of its own traffic:
 * the agent's request reaches that runtime and nothing else. The gate's proxy path
 * emits an observation per decision, but an in-app site never touches it, so without
 * this the site's Audit page can only ever show the decisions someone else saw — which
 * is to say, none of them.
 *
 * Report only what you alone witnessed. The two MONEY verdicts (`paid`,
 * `payment-failed`) are written by the hosted `/verify` from the settle outcome and are
 * refused here — the middleware never reports them, and a control plane must never
 * accept them from a client. That keeps a publisher's earnings derived from money that
 * actually moved, not from what its own runtime claims moved.
 *
 * Telemetry, never a toll: a reporter takes no callback and returns nothing. It cannot
 * block a response, cannot fail one, and a sink outage costs at most some visibility.
 */
import type { TollKind } from "../decide.ts";

/** The verdicts a publisher's own runtime witnesses (and no one else does). */
export type ReportableVerdict = "served-free" | "agent-reread" | "denied" | "blocked";

/** One decision, as reported to the control plane. Mirrors the gate's `ObservationEvent`
 *  minus the fields the receiver owns: the row id and the publisher (which it takes from
 *  the authenticated key, never from the wire). */
export interface ObservationReport {
  /** The full URL the decision was made for. Its host must be one this key owns. */
  resource: string;
  /** The gated slug — empty for a gated non-article path. */
  slug: string;
  verdict: ReportableVerdict;
  classifiedAs: "human" | "agent";
  kind?: TollKind;
  /** What the request would have paid, in INTEGER micro-USDC. Never a float: this is the
   *  same money convention the settlement path uses, and it drives the "earnings missed"
   *  figure a publisher reads. */
  priceMicro?: number;
  /** epoch ms. */
  at: number;
  /** Who the caller was, as this runtime's classifier saw them — what makes a row bucket
   *  under "GPTBot" rather than "(unknown agent)". */
  agent?: {
    ua?: string;
    classifyReason?: string;
    verified?: boolean;
    verifiedAgent?: string;
    sigInvalid?: boolean;
  };
}

/** Fire-and-forget. Returns `void` deliberately — no caller may await it. */
export type ObservationReporter = (report: ObservationReport) => void;

/**
 * Report to the hosted `POST /observe` (nln_live_ authed, tenant-scoped).
 *
 * One request per decision, sent immediately and NOT buffered. Buffering would be the
 * obvious optimisation and is the wrong call here: the middleware's usual home is a
 * serverless runtime that freezes the instant a response is returned, so a queue drained
 * on a timer is a queue that silently never drains — the failure mode being "the audit
 * page is quietly incomplete", which is worse than a chatty client. A runtime that does
 * stay warm can wrap this and batch (the endpoint accepts an array).
 *
 * Every error is swallowed: a reporting failure must never surface to a reader.
 */
export function httpObservationSink(
  observeUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  onError: (err: unknown) => void = () => {},
): ObservationReporter {
  return (report) => {
    try {
      void fetchImpl(observeUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(report),
      })
        .then(() => undefined)
        .catch(onError);
    } catch (err) {
      onError(err);
    }
  };
}
