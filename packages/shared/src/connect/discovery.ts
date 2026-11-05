/**
 * The discovery document every naulon gate serves at `/.well-known/naulon`, hosted or self-hosted.
 *
 * A runtime is configured with one thing, the gate's URL, and reads every endpoint from here. The
 * shape follows OAuth authorization server metadata (RFC 8414): the `issuer` must equal the URL the
 * client asked, or the document is discarded (§3.3), so a document served from one origin can never
 * point a runtime at another origin's endpoints without that origin being the one it was given.
 *
 * This file is the one owner of the shape. The gate builds it with `buildDiscovery`; every client
 * reads it with `parseDiscovery`. The Python and PHP runtimes are held to the same answers by
 * `connect.fixtures.json`.
 */
import { z } from "zod";

export const DISCOVERY_PATH = "/.well-known/naulon";
export const CONNECT_PROTOCOL = "naulon/1";
/** The gate a runtime uses when it is given none. */
export const DEFAULT_GATE = "https://gate.naulon.app";
/** Where a runtime serves the proof that it is running on the host being connected. */
export const CHALLENGE_PATH = "/.well-known/naulon-challenge/";

export interface NaulonDiscovery {
  issuer: string;
  protocol: typeof CONNECT_PROTOCOL;
  /** Base of the in-app enforce API: `${enforce_api}/enforce-config`, `/quote`, and the rest. */
  enforce_api: string;
  /** Where the site's owner approves a connect. A browser page, so it may live on another origin. */
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  jwks_uri: string;
  challenge_path: typeof CHALLENGE_PATH;
  code_challenge_methods_supported: ["S256"];
  client_id_metadata_document_supported: true;
  /** Whether this gate is part of the naulon network (listed in the fleet directory). */
  network: { member: boolean };
}

/** An origin with no path, no query and no credentials, e.g. `https://gate.example.com`. */
export function originOf(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname))) return null;
  return u.origin;
}

/** Plain http is accepted only for a gate on this machine, which is how a local walk runs. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

export interface DiscoveryInput {
  /** The gate's public origin. */
  issuer: string;
  /** Defaults to the gate's own `/connect/authorize`; the hosted fleet points at its portal. */
  authorizationEndpoint?: string;
  networkMember?: boolean;
}

export function buildDiscovery(input: DiscoveryInput): NaulonDiscovery {
  const issuer = originOf(input.issuer);
  if (!issuer) throw new Error(`discovery issuer must be an https origin, got ${JSON.stringify(input.issuer)}`);
  return {
    issuer,
    protocol: CONNECT_PROTOCOL,
    enforce_api: `${issuer}/_naulon`,
    authorization_endpoint: input.authorizationEndpoint ?? `${issuer}/connect/authorize`,
    token_endpoint: `${issuer}/_naulon/connect/token`,
    revocation_endpoint: `${issuer}/_naulon/connect/revoke`,
    jwks_uri: `${issuer}/.well-known/naulon-jwks.json`,
    challenge_path: CHALLENGE_PATH,
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
    network: { member: input.networkMember ?? false },
  };
}

const endpoint = z.string().refine((s) => originOf(s) !== null, "must be an https URL");

const DOC = z.object({
  issuer: z.string(),
  protocol: z.literal(CONNECT_PROTOCOL),
  enforce_api: endpoint,
  authorization_endpoint: endpoint,
  token_endpoint: endpoint,
  revocation_endpoint: endpoint,
  jwks_uri: endpoint,
  challenge_path: z.literal(CHALLENGE_PATH),
  code_challenge_methods_supported: z.array(z.string()).refine((m) => m.includes("S256"), "S256 is required"),
  client_id_metadata_document_supported: z.literal(true),
  network: z.object({ member: z.boolean() }),
});

export type DiscoveryResult = { ok: true; doc: NaulonDiscovery } | { ok: false; error: string };

/**
 * Read a discovery document fetched from `gate`. Unknown fields are ignored, so a newer gate stays
 * readable. The API endpoints (enforce, token, revocation, keys) must share the issuer's origin: a
 * gate may send the owner's browser elsewhere to approve, never a runtime's credentials.
 */
export function parseDiscovery(body: unknown, gate: string): DiscoveryResult {
  const expected = originOf(gate);
  if (!expected) return { ok: false, error: "the gate URL must be https" };
  const parsed = DOC.safeParse(body);
  if (!parsed.success) return { ok: false, error: `not a naulon discovery document: ${parsed.error.issues[0]?.path.join(".") || "body"}` };
  const d = parsed.data;
  if (d.issuer !== expected) return { ok: false, error: `issuer ${d.issuer} does not match ${expected}` };
  for (const key of ["enforce_api", "token_endpoint", "revocation_endpoint", "jwks_uri"] as const) {
    if (originOf(d[key]) !== expected) return { ok: false, error: `${key} is not on ${expected}` };
  }
  return {
    ok: true,
    doc: { ...d, protocol: CONNECT_PROTOCOL, challenge_path: CHALLENGE_PATH, code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true },
  };
}
