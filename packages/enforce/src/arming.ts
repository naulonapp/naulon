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

/** One (publisher, operator) pair as a host persists it. Hour keys are hour indexes (epoch ms / 1h). */
export interface ArmingPairState {
  publisherId: string;
  operatorId: string;
  armed: boolean;
  verifiedHours: Record<string, number>;
  lastVerifiedAt?: number;
  forgedSinceVerified: number;
  disarmedAt?: number;
}

export interface MemoryArmingStoreOptions {
  /** Called after every change to a pair, so a host can persist just the pairs that moved. */
  onChange?: (publisherId: string, operatorId: string) => void;
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

  constructor(private readonly opts: MemoryArmingStoreOptions = {}) {}

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
        // A hit reported late (a host batching reports) is counted but never rewinds the clock the
        // disarm rule measures silence from, nor clears forged claims that came after it.
        if (pair.lastVerifiedAt === undefined || now >= pair.lastVerifiedAt) {
          pair.lastVerifiedAt = now;
          pair.forgedSinceVerified = 0;
        }
        if (!pair.armed && verifiedIn(pair, now) >= ARM_VERIFIED_MIN) pair.armed = true;
      } else {
        pair.forgedSinceVerified++;
        if (pair.armed && pair.lastVerifiedAt !== undefined) {
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
      this.opts.onChange?.(publisherId, c.operatorId);
    }
  }

  exportPair(publisherId: string, operatorId: string): ArmingPairState | undefined {
    const p = this.pairs.get(this.key(publisherId, operatorId));
    if (!p) return undefined;
    return {
      publisherId,
      operatorId,
      armed: p.armed,
      verifiedHours: Object.fromEntries([...p.verified].map(([h, n]) => [String(h), n])),
      forgedSinceVerified: p.forgedSinceVerified,
      ...(p.lastVerifiedAt !== undefined ? { lastVerifiedAt: p.lastVerifiedAt } : {}),
      ...(p.disarmedAt !== undefined ? { disarmedAt: p.disarmedAt } : {}),
    };
  }

  /**
   * Restore persisted pairs. A malformed row or hour entry is skipped, never thrown.
   *
   * A pair already recorded in this store (claims seen before the host's load finished) is MERGED
   * with the stored one rather than replaced, so neither side's evidence is lost: hour counts add,
   * the later verified hit and the later disarm win, and the pair is armed if either side was or
   * the combined count reaches ARM_VERIFIED_MIN. A merged pair is announced through `onChange`.
   */
  importPairs(rows: readonly ArmingPairState[]): void {
    for (const row of rows) {
      if (!row.publisherId || !/^[a-z0-9-]{1,64}$/.test(row.operatorId)) continue;
      const verified = new Map<number, number>();
      for (const [h, n] of Object.entries(row.verifiedHours ?? {})) {
        const hour = Number(h);
        if (Number.isInteger(hour) && Number.isInteger(n) && n > 0) verified.set(hour, n);
      }
      const stored: Pair = {
        armed: row.armed === true,
        verified,
        forgedSinceVerified: Number.isInteger(row.forgedSinceVerified) ? row.forgedSinceVerified : 0,
        ...(typeof row.lastVerifiedAt === "number" ? { lastVerifiedAt: row.lastVerifiedAt } : {}),
        ...(typeof row.disarmedAt === "number" ? { disarmedAt: row.disarmedAt } : {}),
      };
      const k = this.key(row.publisherId, row.operatorId);
      const live = this.pairs.get(k);
      if (!live) {
        this.pairs.set(k, stored);
        continue;
      }
      for (const [h, n] of stored.verified) live.verified.set(h, (live.verified.get(h) ?? 0) + n);
      const lastStored = stored.lastVerifiedAt ?? -Infinity;
      const lastLive = live.lastVerifiedAt ?? -Infinity;
      // Forged claims since the last verified hit: the live count when live verified later,
      // otherwise both sides' forged claims followed the stored verified hit.
      if (lastStored > lastLive) live.forgedSinceVerified += stored.forgedSinceVerified;
      if (lastStored > lastLive) live.lastVerifiedAt = lastStored;
      if (stored.disarmedAt !== undefined && (live.disarmedAt ?? -Infinity) < stored.disarmedAt) live.disarmedAt = stored.disarmedAt;
      const now = live.lastVerifiedAt ?? stored.lastVerifiedAt ?? 0;
      // A disarm seen live after the stored verified hit is newer evidence than the stored armed flag.
      const disarmedSince = live.disarmedAt !== undefined && live.disarmedAt > lastStored;
      live.armed = live.armed || (stored.armed && !disarmedSince) || verifiedIn(live, now) >= ARM_VERIFIED_MIN;
      this.opts.onChange?.(row.publisherId, row.operatorId);
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
