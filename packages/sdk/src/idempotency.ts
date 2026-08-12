/**
 * Exactly-once persistence for the webhook receiver — a SEPARATE concern from
 * `verifyPayload` (which proves authenticity only). Delivery is at-least-once by
 * design, and the skew window means an authentic POST is replayable for its whole
 * duration, so a receiver that writes money with no dedupe is a double-count
 * defect, not a choice. The receiver adapter therefore REQUIRES one of these.
 */
export interface IdempotencyStore {
  /**
   * Atomically claim `eventId`. Returns `true` the first time (proceed with the
   * work), `false` if it was already seen (a redelivery — short-circuit to 200).
   */
  claim(eventId: string): Promise<boolean>;
  /**
   * Give a claim back after the handler failed, so the next delivery attempt can
   * take it. OPTIONAL, and the reason it exists is worth reading: the claim is
   * taken BEFORE the handler runs (that ordering is what makes two concurrent
   * redeliveries safe). Without a release, a handler that throws leaves the event
   * claimed-but-unprocessed and every retry is deduped into silence.
   *
   * A store that can't release should instead claim inside the SAME transaction
   * that does the work — then a rollback releases it for you, which is strictly
   * better than either.
   */
  release?(eventId: string): Promise<void>;
}

/**
 * A process-local default so the type is always satisfiable in dev/tests.
 *
 * NOT DURABLE. It is lost on restart and useless across instances — any real
 * deployment MUST back `claim` with its database (a unique constraint on the event
 * id). Using this in production is a double-count footgun.
 */
export function memoryIdempotencyStore(): IdempotencyStore {
  const seen = new Set<string>();
  return {
    async claim(eventId) {
      if (seen.has(eventId)) return false;
      seen.add(eventId);
      return true;
    },
    async release(eventId) {
      seen.delete(eventId);
    },
  };
}
