/**
 * Per-install proof that the client-IP setup works, before a forged claim may cost anyone a read.
 *
 * An install arms for an operator after it has seen that operator's real crawler at a verified
 * address ARM_VERIFIED_MIN times within ARM_WINDOW_MS. A misconfigured install (one that reads a
 * proxy's address as the caller) sees every real crawler as forged, so it never arms.
 *
 * Disarming must tell a proxy change apart from an attack, because both produce forged claims.
 * What differs is the real crawler: after a proxy change it stops verifying, under an attack it
 * keeps verifying at its usual pace. So an armed pair disarms only when DISARM_MIN_FORGED forged
 * claims have arrived since the last verified one AND verified hits have been silent for
 * DISARM_SILENCE_FACTOR times their usual gap, clamped to [DISARM_SILENCE_MIN_MS,
 * DISARM_SILENCE_MAX_MS]. A forger cannot disarm it by volume; a broken proxy disarms it within
 * hours on a busy site and within three days on a quiet one.
 *
 * State per (install, operator) is hourly counts plus two scalars, so memory does not grow with
 * request volume. The store is a seam: the memory one forgets on restart, which only delays
 * arming. A host with durable state implements `ArmingStore` and passes it to `createApp`.
 */
import type { IdentityResult } from "./identity.ts";

export const ARM_VERIFIED_MIN = 20;
export const ARM_WINDOW_MS = 14 * 86_400_000;
export const DISARM_MIN_FORGED = 3;
export const DISARM_SILENCE_FACTOR = 3;
export const DISARM_SILENCE_MIN_MS = 3 * 3_600_000;
export const DISARM_SILENCE_MAX_MS = 72 * 3_600_000;

const HOUR_MS = 3_600_000;
const MAX_PAIRS = 50_000;

export interface ArmingStatus {
  operatorId: string;
  armed: boolean;
  verifiedInWindow: number;
  forgedSinceVerified: number;
  lastVerifiedAt?: number;
  disarmedAt?: number;
}

export interface ArmingStore {
  /** Synchronous: it sits on the request path. */
  isArmed(publisherId: string, operatorId: string): boolean;
  /** Fire-and-forget: must never throw into a request. */
  record(publisherId: string, result: IdentityResult, now: number): void;
  status(publisherId: string, now: number): ArmingStatus[];
}

interface Pair {
  armed: boolean;
  /** hour index → verified hits in that hour, within ARM_WINDOW_MS */
  verified: Map<number, number>;
  lastVerifiedAt?: number;
  forgedSinceVerified: number;
  disarmedAt?: number;
}

function verifiedIn(pair: Pair, now: number): number {
  const oldest = Math.floor((now - ARM_WINDOW_MS) / HOUR_MS);
  let n = 0;
  for (const [h, c] of pair.verified) {
    if (h < oldest) pair.verified.delete(h);
    else n += c;
  }
  return n;
}

/** How long verified hits must be silent before forged ones are read as a proxy change. */
export function silenceThresholdMs(verifiedInWindow: number): number {
  const usualGap = ARM_WINDOW_MS / Math.max(1, verifiedInWindow);
  return Math.min(DISARM_SILENCE_MAX_MS, Math.max(DISARM_SILENCE_MIN_MS, DISARM_SILENCE_FACTOR * usualGap));
}

export class MemoryArmingStore implements ArmingStore {
  private readonly pairs = new Map<string, Pair>();

  private key(p: string, op: string): string {
    return `${p}\u0000${op}`;
  }

  isArmed(publisherId: string, operatorId: string): boolean {
    return this.pairs.get(this.key(publisherId, operatorId))?.armed ?? false;
  }

  record(publisherId: string, result: IdentityResult, now: number): void {
    const seen = new Set<string>();
    for (const c of result.claims) {
      if (seen.has(c.operatorId)) continue;
      seen.add(c.operatorId);
      if (c.check !== "ip-verified" && c.check !== "forged") continue;
      const k = this.key(publisherId, c.operatorId);
      let pair = this.pairs.get(k);
      if (pair) {
        // Re-insert so Map order tracks recency and eviction drops the least recently seen pair.
        this.pairs.delete(k);
      } else {
        if (this.pairs.size >= MAX_PAIRS) {
          const oldest = this.pairs.keys().next().value;
          if (oldest !== undefined) this.pairs.delete(oldest);
        }
        pair = { armed: false, verified: new Map(), forgedSinceVerified: 0 };
      }
      this.pairs.set(k, pair);

      if (c.check === "ip-verified") {
        const h = Math.floor(now / HOUR_MS);
        pair.verified.set(h, (pair.verified.get(h) ?? 0) + 1);
        pair.lastVerifiedAt = now;
        pair.forgedSinceVerified = 0;
        if (!pair.armed && verifiedIn(pair, now) >= ARM_VERIFIED_MIN) pair.armed = true;
        continue;
      }

      pair.forgedSinceVerified++;
      if (!pair.armed || pair.lastVerifiedAt === undefined) continue;
      const silence = now - pair.lastVerifiedAt;
      if (pair.forgedSinceVerified >= DISARM_MIN_FORGED && silence >= silenceThresholdMs(verifiedIn(pair, now))) {
        pair.armed = false;
        pair.disarmedAt = now;
        pair.verified.clear();
        pair.forgedSinceVerified = 0;
        delete pair.lastVerifiedAt;
      }
    }
  }

  status(publisherId: string, now: number): ArmingStatus[] {
    const prefix = `${publisherId}\u0000`;
    const out: ArmingStatus[] = [];
    for (const [k, p] of this.pairs) {
      if (!k.startsWith(prefix)) continue;
      out.push({
        operatorId: k.slice(prefix.length),
        armed: p.armed,
        verifiedInWindow: verifiedIn(p, now),
        forgedSinceVerified: p.forgedSinceVerified,
        ...(p.lastVerifiedAt !== undefined ? { lastVerifiedAt: p.lastVerifiedAt } : {}),
        ...(p.disarmedAt !== undefined ? { disarmedAt: p.disarmedAt } : {}),
      });
    }
    return out;
  }
}
