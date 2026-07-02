/**
 * Exactly-once persistence for the settlement receiver — a SEPARATE concern from
 * `verifySettlement` (which proves authenticity only). The skew window means an
 * authentic POST is replayable for its whole duration (5 minutes), so a money
 * receiver without dedupe is a double-payout defect, not a choice. The receiver
 * adapter therefore REQUIRES one of these.
 */
export interface IdempotencyStore {
  /**
   * Atomically claim `eventId`. Returns `true` the first time (proceed with the
   * payout), `false` if it was already seen (a replay — short-circuit to 200).
   */
  claim(eventId: string): Promise<boolean>;
}

/**
 * A process-local default so the type is always satisfiable in dev/tests.
 *
 * NOT DURABLE. It is lost on restart and useless across instances — any real
 * deployment MUST back `claim` with its database (a unique constraint on the event
 * id). Using this in production is a double-payout footgun.
 */
export function memoryIdempotencyStore(): IdempotencyStore {
  const seen = new Set<string>();
  return {
    async claim(eventId) {
      if (seen.has(eventId)) return false;
      seen.add(eventId);
      return true;
    },
  };
}
