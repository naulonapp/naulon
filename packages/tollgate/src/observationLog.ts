/**
 * The tollgate's binding to the shared observation ledger — the audit plane's
 * write side. Sibling of `eventLog.ts`. The sink is chosen by OBSERVATIONS_BACKEND
 * and defaults to a no-op, so emitting is free and records nothing unless a deploy
 * opts in. Callers here fire-and-forget: an observation must never delay or fail a
 * request (it's telemetry, not the toll).
 */
import { getObservationSink, type ObservationEvent } from "@naulon/shared";

const sink = getObservationSink();

/**
 * Record one gated-request observation, best-effort. Never throws and never
 * blocks the response — a logging failure must not turn a served read into an
 * error. The default no-op sink makes this a cheap no-cost call when off.
 */
export function observe(observation: ObservationEvent): void {
  void sink.record(observation).catch((err: unknown) => {
    console.error("[tollgate] observation write failed (ignored):", err);
  });
}
