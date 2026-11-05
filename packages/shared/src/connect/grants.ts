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

export async function saveCode(store: GateStateStore, pending: Omit<PendingCode, "expiresAt">, now = Date.now()): Promise<string> {
  const code = CODE_PREFIX + randomBase62(43);
  const record: PendingCode = { ...pending, expiresAt: now + CODE_TTL_MS };
  await store.put(codeKey(credentialDigest(code)), JSON.stringify(record));
  return code;
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

/** RFC 7009: revoking an unknown token is not an error, so the caller cannot probe which exist. */
export async function revokeCredential(store: GateStateStore, credential: string): Promise<void> {
  if (isSiteCredential(credential)) await store.delete(credKey(credentialDigest(credential)));
}

export async function listCredentials(store: GateStateStore): Promise<(SiteCredentialRecord & { id: string })[]> {
  return (await store.list("credential:")).map(({ key, value }) => ({ id: key.slice("credential:".length), ...(JSON.parse(value) as SiteCredentialRecord) }));
}

/** Drop codes past their deadline and used-markers old enough that their code expired too. A marker
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
  return removed;
}

/** The console's revoke button: it holds the record's id, never the credential itself. */
export async function revokeCredentialById(store: GateStateStore, id: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(id)) return false;
  const held = await store.get(credKey(id));
  if (!held) return false;
  await store.delete(credKey(id));
  return true;
}
