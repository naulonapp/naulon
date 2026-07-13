/**
 * The cloud MemoSigner (BUY-2). Wires the wayfarer memo buyer to naulon's hosted, grant-checked
 * signer instead of a local private key: each EIP-3009 leg is POSTed to `/_naulon/buyer-wallet/
 * sign-memo`, which holds the encrypted session key, enforces the grant (cap + TTL), and returns just
 * the signature. So the MCP process never touches a private key — the custody-free hosted path.
 *
 * The endpoint + token are SERVER-CONFIG (env), never LLM tool args — the model cannot point the
 * signer elsewhere or raise its own spend ceiling. The chainId is taken from the request's own domain,
 * so it can never drift from what wayfarer is paying against.
 */
import type { AgentWallet, MemoSigner } from "@naulon/wayfarer";

/** The grant CAP/budget refused the spend — funding the session is the remedy. The message STARTS with the
 *  raw code (`grant_exceeded`) so memo.ts's message-prefix classifier maps it to `needs_topup`, not a
 *  retryable `origin_error` (mirrors in-process-signer.ts, which already throws code-prefixed messages). */
export class GrantExceededError extends Error {
  constructor(public readonly remainingMicro?: number) {
    super(`grant_exceeded${remainingMicro !== undefined ? ` (remaining ${remainingMicro})` : ""}`);
    this.name = "GrantExceededError";
  }
}

/** The grant WINDOW lapsed though funds may be intact — RENEWING the session is the remedy, not a top-up.
 *  Distinct class + code-prefixed message so the hosted agent renews rather than funds. */
export class GrantExpiredError extends Error {
  constructor(public readonly remainingMicro?: number) {
    super(`grant_expired${remainingMicro !== undefined ? ` (remaining ${remainingMicro})` : ""}`);
    this.name = "GrantExpiredError";
  }
}

/** Any other non-ok response from the signer BFF (bad_from, no_session, chain_mismatch, 5xx, …). */
export class SignerError extends Error {
  constructor(
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(`sign-memo failed: ${status}${code ? ` ${code}` : ""}`);
    this.name = "SignerError";
  }
}

export interface CloudSignerOpts {
  /** Cloud base URL, no trailing slash (e.g. https://api.naulon.app). */
  endpoint: string;
  /** Per-session bearer token — server-config, never a tool arg. */
  token: string;
  /** The provisioned session EOA address (the `from` every leg signs as). */
  address: `0x${string}`;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Build the cloud signer from environment — the hosted path is opt-in via SERVER-CONFIG, never a tool
 * arg. All three of NAULON_CLOUD_ENDPOINT / NAULON_CLOUD_TOKEN / NAULON_BUYER_SESSION_ADDRESS must be
 * present (and the address well-formed) or we return undefined and the caller falls back to the
 * BYO-key path. This keeps the OSS default (local key) exactly as-is when the cloud isn't configured.
 */
export function cloudSignerFromEnv(
  env: Record<string, string | undefined> = process.env,
): MemoSigner | undefined {
  const endpoint = env.NAULON_CLOUD_ENDPOINT;
  const token = env.NAULON_CLOUD_TOKEN;
  const address = env.NAULON_BUYER_SESSION_ADDRESS;
  if (!endpoint || !token || !address) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  return cloudMemoSigner({ endpoint, token, address: address as `0x${string}` });
}

export function cloudMemoSigner(opts: CloudSignerOpts): MemoSigner {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    address: opts.address,
    async signTypedData(args) {
      const m = args.message;
      const res = await doFetch(`${opts.endpoint}/_naulon/buyer-wallet/sign-memo`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
        // BigInt can't be JSON-serialized — send the EIP-3009 fields as decimal strings. The BFF
        // rebuilds the domain + types authoritatively; we send only the leg's message primitives.
        body: JSON.stringify({
          chainId: Number(args.domain.chainId),
          message: {
            from: m.from,
            to: m.to,
            value: m.value.toString(),
            validAfter: m.validAfter.toString(),
            validBefore: m.validBefore.toString(),
            nonce: m.nonce,
          },
        }),
      });
      if (res.status === 402) {
        // The BFF returns 402 for BOTH grant stops (sign.ts:57/60). Read `error` to pick the remedy:
        // grant_expired ⇒ renew (funds intact); grant_exceeded / anything else ⇒ top up (fund the session).
        const body = (await res.json().catch(() => ({}))) as { error?: string; remainingMicro?: number };
        throw body.error === "grant_expired"
          ? new GrantExpiredError(body.remainingMicro)
          : new GrantExceededError(body.remainingMicro);
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new SignerError(res.status, body.error);
      }
      const body = (await res.json().catch(() => ({}))) as { signature?: `0x${string}` };
      if (!body.signature) throw new SignerError(res.status, "no_signature");
      return body.signature;
    },
  };
}

/**
 * The cloud PoP signer (Phase 4 / C2). A held re-read of a cnf-bound license must prove control of
 * the paying wallet by signing an EIP-191 holder-of-key challenge. On the custody-free hosted path the
 * paying identity is the session EOA, whose key lives encrypted in the cloud — so the proof is signed
 * by `/_naulon/buyer-wallet/sign-pop` (the session key) rather than a local key. Returns an
 * `AgentWallet` so `buildPopProof` consumes it exactly like the env wallet.
 *
 * Unlike `/sign-memo` this leg is GRANT-FREE: a PoP is a free re-read, not a spend, so there is no cap
 * to debit. The BFF still authenticates the bearer, checks the `address` matches the session, AND
 * constrains the signed bytes to a canonical `naulon-pop` challenge — the session key can never be
 * coerced into signing an arbitrary message. The endpoint + token are SERVER-CONFIG, never a tool arg.
 */
export function cloudPopSigner(opts: CloudSignerOpts): AgentWallet {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    address: opts.address,
    mock: false,
    signMessage: async (message: string): Promise<string> => {
      const res = await doFetch(`${opts.endpoint}/_naulon/buyer-wallet/sign-pop`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
        body: JSON.stringify({ address: opts.address, message }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new SignerError(res.status, body.error);
      }
      const body = (await res.json().catch(() => ({}))) as { signature?: string };
      if (!body.signature) throw new SignerError(res.status, "no_signature");
      return body.signature;
    },
  };
}
