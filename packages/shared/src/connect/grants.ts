/**
 * What a gate remembers about connects: authorization codes on their way to a token, and the site
 * credentials it issued. Kept in the gate's state store, so the console that shows the owner the
 * Approve button and the gate that redeems the code agree without talking to each other.
 *
 * Nothing secret is stored as itself. A code and a credential are stored under their SHA-256, so a
 * copy of the store is not a copy of anyone's access.
 *
 * Single use is enforced with the store's one atomic primitive: redeeming a code first claims a
 * `connect.used:` marker with `createIfAbsent`. Two requests racing with the same code cannot both
 * win, and the loser is told the code was used, which is what RFC 6749 §4.1.2 asks for.
 */
import type { GateStateStore } from "../state/store.ts";
import { codeChallengeOf, credentialDigest, isSiteCredential, mintSiteCredential, randomBase62, redirectMatches } from "./flow.ts";

export const CODE_TTL_MS = 10 * 60_000;
/** How stale "last asked this gate" may be. An owner deciding whether a credential is still in use
 *  needs the hour, not the second, and a write per enforce request would put the store on every
 *  reader's path. WordPress makes the same trade for application passwords, at a day. */
export const SEEN_EVERY_MS = 60 * 60_000;
/** How often saving a code also clears out dead codes and markers. */
export const SWEEP_EVERY_MS = 10 * 60_000;
const CODE_PREFIX = "nln_code_";

export interface PendingCode {
  clientId: string;
  /** The name the client declared, as the owner saw it on the approve page. */
  clientName: string;
  redirectUri: string;
  site: string;
  codeChallenge: string;
  /** Who approved it, for the audit line. */
  approvedBy: string;
  expiresAt: number;
}

export interface SiteCredentialRecord {
  site: string;
  clientId: string;
  clientName: string;
  approvedBy: string;
  createdAt: number;
  /** Last four characters, so an owner can tell two credentials apart without seeing either. */
  hint: string;
}

const codeKey = (digest: string) => `connect.code:${digest}`;
const usedKey = (digest: string) => `connect.used:${digest}`;
const credKey = (digest: string) => `credential:${digest}`;
/** Kept apart from the credential record on purpose: the gate writes it while serving a request,
 *  and a write to the record itself could land after the owner revoked it and bring it back. A
 *  stray `seen` key with no credential beside it grants nothing, and the sweep removes it. */
const seenKey = (digest: string) => `connect.seen:${digest}`;

export async function saveCode(store: GateStateStore, pending: Omit<PendingCode, "expiresAt">, now = Date.now()): Promise<string> {
  const code = CODE_PREFIX + randomBase62(43);
  const record: PendingCode = { ...pending, expiresAt: now + CODE_TTL_MS };
  await store.put(codeKey(credentialDigest(code)), JSON.stringify(record));
  // Every row the sweep removes exists because a code was saved, so saving one is where the sweep
  // runs. That keeps it working where no timer can live (a serverless gate), and an idle gate has
  // nothing to sweep.
  await sweepConnectAtMostEvery(store, now);
  return code;
}

const lastSweep = new WeakMap<GateStateStore, number>();

async function sweepConnectAtMostEvery(store: GateStateStore, now: number): Promise<void> {
  const last = lastSweep.get(store);
  if (last !== undefined && now - last < SWEEP_EVERY_MS) return;
  lastSweep.set(store, now);
  try {
    await sweepConnect(store, now);
  } catch (err) {
    // A failed sweep leaves garbage, never a wrong answer: an expired code is refused by its own
    // deadline. So the approval goes through, and the failure is said out loud.
    console.warn("[naulon] connect sweep failed; expired codes stay until the next one:", err);
  }
}

export type RedeemError = "invalid_grant" | "invalid_client";
export type Redeemed = { ok: true; code: PendingCode } | { ok: false; error: RedeemError; reason: string };

export async function redeemCode(
  store: GateStateStore,
  presented: { code: string; codeVerifier: string; redirectUri: string; clientId: string },
  now = Date.now(),
): Promise<Redeemed> {
  if (!presented.code.startsWith(CODE_PREFIX)) return { ok: false, error: "invalid_grant", reason: "not a code" };
  const digest = credentialDigest(presented.code);
  const raw = await store.get(codeKey(digest));
  if (!raw) return { ok: false, error: "invalid_grant", reason: "unknown or used code" };
  // Unique per attempt: racers in the same millisecond must not write identical markers, or every
  // one of them would read its own value back and believe it won.
  const marker = `${now}.${randomBase62(16)}`;
  if ((await store.createIfAbsent(usedKey(digest), marker)) !== marker) {
    return { ok: false, error: "invalid_grant", reason: "code already used" };
  }
  await store.delete(codeKey(digest));
  const code = JSON.parse(raw) as PendingCode;
  if (code.expiresAt <= now) return { ok: false, error: "invalid_grant", reason: "code expired" };
  if (code.clientId !== presented.clientId) return { ok: false, error: "invalid_client", reason: "code was issued to another client" };
  if (!redirectMatches(code.redirectUri, presented.redirectUri)) return { ok: false, error: "invalid_grant", reason: "redirect_uri does not match" };
  let challenge: string;
  try {
    challenge = codeChallengeOf(presented.codeVerifier);
  } catch {
    return { ok: false, error: "invalid_grant", reason: "malformed code_verifier" };
  }
  if (challenge !== code.codeChallenge) return { ok: false, error: "invalid_grant", reason: "code_verifier does not match" };
  return { ok: true, code };
}

export async function issueCredential(
  store: GateStateStore,
  grant: { site: string; clientId: string; clientName: string; approvedBy: string },
  now = Date.now(),
): Promise<string> {
  const credential = mintSiteCredential();
  const record: SiteCredentialRecord = { ...grant, createdAt: now, hint: credential.slice(-4) };
  await store.put(credKey(credentialDigest(credential)), JSON.stringify(record));
  return credential;
}

export async function resolveCredential(store: GateStateStore, credential: string): Promise<SiteCredentialRecord | null> {
  if (!isSiteCredential(credential)) return null;
  const raw = await store.get(credKey(credentialDigest(credential)));
  return raw ? (JSON.parse(raw) as SiteCredentialRecord) : null;
}

/**
 * Remembers that a credential was just used, at most once per `SEEN_EVERY_MS` per credential per
 * process. The gate calls it after a credential resolves. It never waits on the store and never
 * fails the request it rides on: a missed write costs an owner an hour of precision, nothing more.
 */
export function seenRecorder(store: GateStateStore, o: { everyMs?: number; now?: () => number; warn?: (msg: string, err: unknown) => void } = {}): (credential: string) => void {
  const everyMs = o.everyMs ?? SEEN_EVERY_MS;
  const now = o.now ?? Date.now;
  const warn = o.warn ?? ((msg, err) => console.warn(msg, err));
  const written = new Map<string, number>();
  let warnedAt = -Infinity;
  return (credential) => {
    const digest = credentialDigest(credential);
    const at = now();
    const last = written.get(digest);
    if (last !== undefined && at - last < everyMs) return;
    written.set(digest, at);
    store.put(seenKey(digest), String(at)).catch((err: unknown) => {
      written.delete(digest);
      if (at - warnedAt < everyMs) return;
      warnedAt = at;
      warn("[naulon] could not record when a site credential was last used; the Sites page will show it as older than it is:", err);
    });
  };
}

/** RFC 7009: revoking an unknown token is not an error, so the caller cannot probe which exist. */
export async function revokeCredential(store: GateStateStore, credential: string): Promise<void> {
  if (!isSiteCredential(credential)) return;
  const digest = credentialDigest(credential);
  await store.delete(credKey(digest));
  await store.delete(seenKey(digest));
}

export interface ListedCredential extends SiteCredentialRecord {
  /** The record's key: the credential's SHA-256, safe to show and to send back to revoke. */
  id: string;
  /** When the gate last answered a request made with it, to within `SEEN_EVERY_MS`. Null: never. */
  lastSeenAt: number | null;
}

export async function listCredentials(store: GateStateStore): Promise<ListedCredential[]> {
  const seen = new Map((await store.list("connect.seen:")).map(({ key, value }) => [key.slice("connect.seen:".length), Number(value)]));
  return (await store.list("credential:")).map(({ key, value }) => {
    const id = key.slice("credential:".length);
    return { id, ...(JSON.parse(value) as SiteCredentialRecord), lastSeenAt: seen.get(id) ?? null };
  });
}

/** Drop codes past their deadline, used-markers old enough that their code expired too, and
 *  last-seen times whose credential was revoked. A marker
 *  must outlive its code, or a replay after the sweep would find neither and read as unknown, which
 *  is still a refusal, so the order only decides which message the replay gets. */
export async function sweepConnect(store: GateStateStore, now = Date.now()): Promise<number> {
  let removed = 0;
  for (const { key, value } of await store.list("connect.code:")) {
    if ((JSON.parse(value) as PendingCode).expiresAt <= now) {
      await store.delete(key);
      removed++;
    }
  }
  for (const { key, value } of await store.list("connect.used:")) {
    if (Number(value.split(".")[0]) + CODE_TTL_MS <= now) {
      await store.delete(key);
      removed++;
    }
  }
  for (const { key } of await store.list("connect.seen:")) {
    if ((await store.get(credKey(key.slice("connect.seen:".length)))) === null) {
      await store.delete(key);
      removed++;
    }
  }
  return removed;
}

/** The console's revoke button: it holds the record's id, never the credential itself. Returns what
 *  it removed, so the caller can name it, or null when there was nothing to remove. */
export async function revokeCredentialById(store: GateStateStore, id: string): Promise<SiteCredentialRecord | null> {
  if (!/^[0-9a-f]{64}$/.test(id)) return null;
  const held = await store.get(credKey(id));
  if (!held) return null;
  await store.delete(credKey(id));
  await store.delete(seenKey(id));
  return JSON.parse(held) as SiteCredentialRecord;
}
