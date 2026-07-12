/**
 * The agent's wallet of Citation Licenses. When the gate hands back a license on
 * a paid read, the agent keeps it; a live (unexpired) one lets it re-read that
 * essay free on a later run instead of paying again — the buyer-side half of the
 * "toll becomes an asset" thesis. Persisted to a small JSON file (WAYFARER_LICENSE_PATH).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getConfig } from "@naulon/shared";

export interface HeldLicense {
  slug: string;
  title: string;
  jti: string;
  /** exp (epoch seconds) decoded from the token, for the liveness check. */
  exp: number;
  /** The token's audience (= gate identity); the value a PoP proof must bind to. */
  aud: string;
  /** Holder-of-key: true when the license carries a `cnf` claim — a re-read needs
   * a wallet proof-of-possession, not just the token. */
  pop: boolean;
  /** The compact-JWS token to present on a re-read. */
  jws: string;
  /** The canonical URL this source was actually PAID at — captured at pay time so a
   * later `read_held` re-fetches the exact link (`/articles/<slug>`, a custom domain,
   * whatever the publisher serves) instead of reconstructing a `/essays/<slug>`
   * template that 404s off-shape. Optional: a license held from before this field
   * existed has none, and the re-read falls back to the template. NOT part of the
   * decoded token — it's the buyer's own bookkeeping, so `decodeHeld` never sets it. */
  url?: string;
}

const file = (): string => getConfig().WAYFARER_LICENSE_PATH;

/**
 * Decode a token's `jti`, `exp`, and `naulon.slug/title` WITHOUT verifying — this
 * is the agent reading its own captured receipt for bookkeeping, not trusting a
 * third party. (The agent separately verifies the signature against the gate's
 * JWKS when it captures the license; see agent.ts.) Returns null if unparseable.
 */
export function decodeHeld(jws: string): Omit<HeldLicense, "jws"> | null {
  try {
    const seg = jws.split(".")[1];
    if (!seg) return null;
    const claims = JSON.parse(Buffer.from(seg, "base64url").toString("utf8")) as {
      jti?: string;
      exp?: number;
      aud?: string;
      cnf?: { "naulon:addr"?: string };
      naulon?: { slug?: string; title?: string };
    };
    if (!claims.jti || !claims.exp || !claims.aud || !claims.naulon?.slug) return null;
    return {
      slug: claims.naulon.slug,
      title: claims.naulon.title ?? claims.naulon.slug,
      jti: claims.jti,
      exp: claims.exp,
      aud: claims.aud,
      pop: typeof claims.cnf?.["naulon:addr"] === "string",
    };
  } catch {
    return null;
  }
}

/** Is this held license still valid at `nowSec` (epoch seconds)? */
export function isLive(held: HeldLicense, nowSec: number): boolean {
  return held.exp > nowSec;
}

export async function loadHeld(): Promise<Map<string, HeldLicense>> {
  try {
    const raw = await readFile(file(), "utf8");
    const arr = JSON.parse(raw) as HeldLicense[];
    return new Map(arr.map((h) => [h.slug, h]));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
}

export async function saveHeld(held: Map<string, HeldLicense>): Promise<void> {
  const path = file();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify([...held.values()], null, 2), "utf8");
}

/**
 * The held-license backend as a seam. The stdio funnel uses the process-global
 * file (`fileHeldStore`); the hosted path (many buyer sessions in one process)
 * MUST inject a store scoped to the caller — else session B could re-read the
 * license session A paid for, since the file store is keyed by slug alone and
 * shared across every session in the process (a cross-buyer isolation leak).
 * The interface is deliberately the shape `loadHeld`/`saveHeld` already have, so
 * the file default and an injected store are interchangeable at every call site.
 */
export interface HeldStore {
  load(): Promise<Map<string, HeldLicense>>;
  save(held: Map<string, HeldLicense>): Promise<void>;
}

/** The OSS default: the process-global JSON file at `WAYFARER_LICENSE_PATH`. */
export const fileHeldStore: HeldStore = { load: loadHeld, save: saveHeld };

/**
 * An in-process, isolated held store — the hosted-path default. Each instance
 * owns a private Map; two instances never share state, so building one per MCP
 * session gives per-session isolation for free (session B's `load()` cannot see
 * what session A `save()`d). Ephemeral by design: a held license lives with the
 * session, not across process restarts — the right trade for a capped hot session.
 */
export function memoryHeldStore(seed?: Iterable<readonly [string, HeldLicense]>): HeldStore {
  const store = new Map<string, HeldLicense>(seed);
  return {
    load: async () => new Map(store),
    save: async (held) => {
      store.clear();
      for (const [k, v] of held) store.set(k, v);
    },
  };
}
