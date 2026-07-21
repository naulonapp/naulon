/**
 * Env loading + validation. Fail loud at boot if a required var is missing,
 * rather than mid-payment. Secrets never get a default.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { FLEET_DIRECTORY_URL } from "./fleet.ts";

// Find the repo root by walking UP from the cwd until we hit the workspace root
// (marked by package-lock.json). We anchor on cwd, not import.meta.url, because
// this package is symlinked into node_modules/@naulon/shared — under
// `npm run -w` the module URL can resolve to the symlink path, sending an
// import.meta.url-relative lookup into node_modules/ instead of the repo. Every
// entrypoint (make, npm -w, tests) runs with cwd inside the repo, so walking up
// from cwd is reliable and symlink-immune. Falls back to cwd if no marker found.
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "package-lock.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}
const REPO_ROOT = findRepoRoot();

// Anchor .env to the repo root, not cwd — npm workspaces run each package script
// with cwd set to the package dir, so a cwd-relative lookup would miss the root
// .env and silently fall back to defaults (mock mode, ephemeral keys).
// Tests are hermetic — they must not pick up a developer's local .env (which may
// set PAYMENT_MODE=gateway, real creds, etc.). Everything else loads the root .env.
// `quiet: true` is REQUIRED, not cosmetic: dotenv >=17 prints an "injected env …"
// tip banner to STDOUT on every load. Any consumer whose stdout is a protocol
// channel — notably @naulon/wayfarer-mcp, an MCP stdio server where stdout must
// carry nothing but JSON-RPC — has its stream corrupted by that banner before the
// first frame. Loading config must never write to stdout.
if (process.env.NODE_ENV !== "test") {
  loadDotenv({ path: join(REPO_ROOT, ".env"), quiet: true });
}

// Anchor the ledger to the repo root, not the current working directory — npm
// workspaces change cwd per package, so a cwd-relative default would split the
// ledger across folders. Uses REPO_ROOT (cwd-walked) for the same symlink-immune
// reason as the .env load above.
const DEFAULT_EVENTS_PATH = join(REPO_ROOT, "data/events.jsonl");
const DEFAULT_OBSERVATIONS_PATH = join(REPO_ROOT, "data/observations.jsonl");
const DEFAULT_PAYOUTS_PATH = join(REPO_ROOT, "data/payouts.jsonl");
const DEFAULT_LICENSE_STORE = join(REPO_ROOT, "data/wayfarer-licenses.json");
const DEFAULT_CREDITS_FIXTURES = join(REPO_ROOT, "examples/meridian/credits.json");
const DEFAULT_SETTLEMENT_OUTBOX = join(REPO_ROOT, "data/settlement-outbox.jsonl");
const DEFAULT_SETTLEMENT_DELIVERY_STATE = join(REPO_ROOT, "data/settlement-delivery.jsonl");

// Exported so config validation (e.g. the licensing superRefine) is unit-testable
// without mutating process.env / the getConfig() singleton.
export const configSchema = z.object({
  // Payment rail. "mock" settles offline (no creds); "gateway" uses the real
  // Circle Gateway batching SDK (needs a funded BUYER_PRIVATE_KEY).
  PAYMENT_MODE: z.enum(["mock", "gateway"]).default("mock"),

  // Settlement network — which Circle Gateway chain the gate tolls on. Selects the
  // whole rail (x402 quote, settlement body, discovery manifest, buyer client, and
  // the testnet-vs-mainnet facilitator) from one switch. Default arcTestnet so a
  // misconfigured deploy settles on testnet, never silently on mainnet. See
  // shared/networks.ts for the per-network constants.
  SETTLEMENT_NETWORK: z.enum(["arcTestnet", "baseSepolia", "base"]).default("arcTestnet"),

  // Circle Gateway. GATEWAY_API_URL overrides the facilitator endpoint; the
  // testnet facilitator needs no key.
  CIRCLE_API_KEY: z.string().optional(),
  // Test-environment facilitator bearer. Circle issues one test + one live key per
  // account (the split is by ENVIRONMENT, not chain). getFacilitator picks this for a
  // testnet leg and CIRCLE_API_KEY for a mainnet leg — so one process serves both.
  // Unset ⇒ testnet falls back to CIRCLE_API_KEY (and the testnet facilitator works keyless).
  CIRCLE_API_KEY_TESTNET: z.string().optional(),
  GATEWAY_API_URL: z.string().url().optional(),
  // Arc MAINNET has no public RPC during the private preview — a settle on `arc`
  // requires this. Fail-loud at settle time (not boot), so testnet deploys never need it.
  ARC_RPC_URL: z.string().url().optional(),

  // Relayer key for the Arc self-relay (memo) settlement path. Required ONLY when
  // PAYMENT_MODE=gateway AND the active network ships the Memo predeploy (Arc) —
  // on Base/Base Sepolia the rail is Circle Gateway and this is unused. The relayer
  // is an EOA (the Memo precompile is EOA-only) that signs the OUTER tx and pays gas
  // (native USDC on Arc, an operating cost); it NEVER touches the transferred funds
  // (buyer→author by the buyer's EIP-3009 authorization). Custody-free holds. A
  // settle-time guard (not boot) errors clearly if it's missing on a memo network.
  RELAYER_PRIVATE_KEY: z.string().optional(),
  // Arc MAINNET memo-rail gas EOA. NO fallback to the testnet relayer key: mainnet gas
  // is real money. An arc-mainnet memo settle without this fails loud (settle-time guard).
  RELAYER_PRIVATE_KEY_MAINNET: z.string().optional(),
  // Override the Arc USDC EIP-712 domain `name` if it is ever not the standard
  // "USD Coin" (PREFLIGHT: confirm against the on-chain name() before real settle).
  USDC_EIP712_NAME: z.string().optional(),

  // Validity window (seconds) we advertise in the x402 quote (validBefore = now +
  // this). Circle's Gateway facilitator rejects `verify` unless the REMAINING
  // validity at verify time is >= 7 days (604800s). The SDK client clamps short
  // windows up, but a non-SDK buyer that trusts our advertised value verbatim
  // fails `authorization_validity_too_short` if it is below the floor. Default 8
  // days = ~1 day of margin over the floor for signing->verify latency + clock
  // skew. Keep it >= 604900 (floor + the SDK's 100s buffer) — enforced below so a
  // future edit can't silently re-arm the 4d footgun this fix removed.
  X402_MAX_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(691_200)
    .refine((v) => v >= 604_900, {
      message:
        "must be >= 604900 (Circle Gateway's 7-day validity floor 604800 + the SDK's 100s buffer); below it a non-SDK buyer that signs our advertised window verbatim fails authorization_validity_too_short",
    }),

  // Tollgate
  TOLLGATE_PORT: z.coerce.number().int().positive().default(8402),
  // The site the gate sits in front of. Any publisher; not tied to one product.
  ORIGIN_URL: z.string().url().default("http://localhost:3000"),
  DEFAULT_PRICE_USDC: z.coerce.number().positive().default(0.001),
  // Citation tolls cost this multiple of a single read (a citation has downstream
  // reach — it grounds an answer many will see). Both resolve to the same author
  // payees; only the price differs. 1 = price a citation the same as a read.
  CITATION_MULTIPLIER: z.coerce.number().positive().default(5),
  // Which path prefixes count as gateable articles (comma-separated).
  ARTICLE_PATH_PREFIXES: z.string().default("essays,articles,posts"),

  // ── Hardening ──
  // HMAC secret that signs 402 payment nonces. If unset, the gate mints an
  // ephemeral one at boot (fine for a single instance; set it for multi-instance
  // or to keep outstanding nonces valid across restarts).
  TOLLGATE_SECRET: z.string().optional(),
  // How long an issued 402 nonce stays valid (seconds). Also the replay window.
  NONCE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // Per-client request ceiling. 0 disables rate limiting. Sustained rate is
  // RATE_LIMIT_RPM/min; short bursts up to RATE_LIMIT_BURST are absorbed.
  RATE_LIMIT_RPM: z.coerce.number().int().nonnegative().default(120),
  RATE_LIMIT_BURST: z.coerce.number().int().positive().default(40),
  // Trust X-Forwarded-For for the client IP. Only enable behind a proxy you
  // control — otherwise clients spoof their rate-limit identity. Default: off.
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Web Bot Auth: allow http:// + loopback key directories so a LOCAL signer
  // fixture can serve its directory from a loopback port. Test walks only —
  // never enable in production (the directory URL is attacker-supplied).
  BOT_AUTH_ALLOW_HTTP: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Web Bot Auth SIGNING identity (slice 3 — the toll's own species marker).
  // A base64url 32-byte Ed25519 seed (generate: scripts/wba-keygen.mjs). When
  // set, the gate serves + self-signs the key directory at
  // /.well-known/http-message-signatures-directory, and the wayfarer signs its
  // outbound requests. Unset ⇒ both surfaces are dark (byte-identical traffic).
  BOT_AUTH_SIGNING_KEY: z.string().optional(),
  // The directory host the wayfarer advertises in Signature-Agent — it must
  // actually serve OUR directory (e.g. "naulon.app"). An http://127.0.0.1:port
  // form is a local-walk fixture (needs the verifying gate's BOT_AUTH_ALLOW_HTTP).
  BOT_AUTH_SIGNATURE_AGENT: z.string().optional(),

  // Credits resolution — how the gate maps an article to its author(s).
  // If CREDITS_API_URL is set, the gate fetches `${url}/credits/:slug`.
  // Otherwise it reads a local JSON fixture (CREDITS_FIXTURES).
  CREDITS_API_URL: z.string().url().optional(),
  CREDITS_API_TOKEN: z.string().optional(),
  CREDITS_FIXTURES: z.string().default(DEFAULT_CREDITS_FIXTURES),
  // Shared HMAC secret for the naulon → publisher settlement emit (POST
  // ${ORIGIN_URL}/api/credits/settlement). Must match the publisher's value. When
  // unset the emit is dark — the gate still tolls and serves; it just doesn't
  // report earnings (keeps the no-creds mock loop working, per hard rule).
  CREDITS_SETTLEMENT_SECRET: z.string().optional(),
  // Crash-safe at-least-once delivery for the settlement emit. The hot path
  // tries once; a background drain re-sends anything not yet acked. The outbox
  // is an append-only log of acked event ids — durable across restarts, and
  // only an optimization (a lost outbox just re-POSTs, which IA dedupes).
  SETTLEMENT_OUTBOX_PATH: z.string().default(DEFAULT_SETTLEMENT_OUTBOX),
  // Bounded retry budget per event inside the drain (the hot path is always 1).
  SETTLEMENT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  // Per-attempt POST timeout (ms) — a hung IA must never stall the gate.
  SETTLEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
  // How often the background drain sweeps for unacked events. 0 disables it
  // (e.g. serverless, where a cron drives the drain instead of a live loop).
  SETTLEMENT_DRAIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(60_000),

  // ── Settlement DELIVERY STATE (the cross-sweep retry plane) ──
  // Where per-event delivery state (acked / attempts / next attempt / dead-letter)
  // lives. "file" = process-local JSONL beside the outbox (the self-host, no-creds
  // default — the gate must stay dark-by-default and creds-free). "supabase" = a
  // shared table, so a multi-instance fleet agrees on what has been delivered and
  // the drain selects only DUE work server-side instead of re-filtering the whole
  // lifetime ledger every tick. Same SettlementDeliveryStore seam either way.
  SETTLEMENT_DELIVERY_BACKEND: z.enum(["file", "supabase"]).default("file"),
  SETTLEMENT_DELIVERY_STATE_PATH: z.string().default(DEFAULT_SETTLEMENT_DELIVERY_STATE),
  // Cross-sweep attempt budget. Distinct from SETTLEMENT_MAX_ATTEMPTS, which is the
  // ladder WITHIN one sweep: this counts SWEEPS. Once an event has failed this many
  // sweeps it is DEAD-LETTERED — parked and surfaced to an operator, never dropped.
  // The money is still owed; a dead letter is a visibility state, not a deletion.
  SETTLEMENT_MAX_DELIVERY_ATTEMPTS: z.coerce.number().int().positive().default(10),
  // Exponential cross-sweep backoff: next = now + min(base * 2^(attempts-1), cap).
  // 1m → 2m → 4m → … capped at 6h, so a dead publisher is retried ~10 times over
  // roughly two days before it parks, instead of being re-POSTed every 60s forever.
  SETTLEMENT_RETRY_BASE_MS: z.coerce.number().int().positive().default(60_000),
  SETTLEMENT_RETRY_BACKOFF_CAP_MS: z.coerce.number().int().positive().default(21_600_000),
  // Hard cap on how many due events one sweep pulls. Bounds both the RPC and the
  // work a single tick does; the next tick picks up the remainder.
  SETTLEMENT_DRAIN_BATCH: z.coerce.number().int().positive().default(500),

  // Wayfarer
  BUYER_ADDRESS: z.string().optional(),
  BUYER_PRIVATE_KEY: z.string().optional(),
  WAYFARER_BUDGET_USDC: z.coerce.number().positive().default(0.1),
  // BUY-1.4 pay-path hardening. The buyer prices then pays in two separate requests,
  // so the toll can move between them. The MCP re-quotes at pay time and aborts if the
  // live total tops the quoted total by more than this tolerance (basis points). 0 =
  // strict: abort on ANY increase over the quoted total (the budget-safe default; a
  // price DROP is always fine). Raise it only to absorb known small price drift.
  WAYFARER_TOLL_TOLERANCE_BPS: z.coerce.number().int().nonnegative().default(0),
  // Floor (seconds) on the buyer's EIP-3009 validity window, stamped at pay time. If a
  // gate advertises a too-short maxTimeoutSeconds, the signed authorization could expire
  // before the relayer submits it (`authorization_validity_too_short`). The window only
  // widens to this floor, never shrinks. See memory `x402-validity-window-floor`.
  WAYFARER_MIN_VALIDITY_SECONDS: z.coerce.number().int().positive().default(60),
  // BUY-3 policy engine (server-config, never LLM-controlled). All optional — unset
  // ⇒ DEFAULT_POLICY. The MCP folds these into the DecisionPolicy it hands run().
  //   *_DOMAINS: comma-separated publisher hosts. ALLOW is an allowlist (deny-by-
  //   default for anything not listed); DENY always wins. CAP: max pays per host.
  //   APPROVAL_USDC: a toll at/above this becomes an "approve" (human gate), not a
  //   pay. KILL_SWITCH: halt all new spend (free re-reads of held licenses still ok).
  // Parse to a non-empty host list, or `undefined` when blank/malformed (e.g. ","):
  // a garbled value must read as "unset" (no restriction), never as an empty
  // allowlist that would silently skip every essay.
  WAYFARER_ALLOW_DOMAINS: z
    .string()
    .optional()
    .transform((v) => {
      const hosts = v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
      return hosts.length ? hosts : undefined;
    }),
  WAYFARER_DENY_DOMAINS: z
    .string()
    .optional()
    .transform((v) => {
      const hosts = v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
      return hosts.length ? hosts : undefined;
    }),
  WAYFARER_PER_DOMAIN_CAP: z.coerce.number().int().positive().optional(),
  WAYFARER_APPROVAL_USDC: z.coerce.number().positive().optional(),
  WAYFARER_KILL_SWITCH: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  OPENAI_API_KEY: z.string().optional(),
  // USDC the agent deposits into the Gateway Wallet at the start of a run.
  DEPOSIT_AMOUNT_USDC: z.string().default("1"),
  // The tollgate the agent pays. Required at use — tollgateBase() throws when unset
  // (no localhost fallback); the cloud injects a per-session gate instead.
  TOLLGATE_URL: z.string().url().optional(),
  // Where the agent discovers candidate essays (a catalog of {slug,title,summary}). Defaults
  // to the live naulon fleet directory — @naulon/wayfarer-mcp is naulon's branded client, so
  // zero-config discovery resolves here out of the box (turnkey), overridable for self-host.
  CATALOG_URL: z.string().url().default(FLEET_DIRECTORY_URL),
  // RSS/sitemap discovery. If set, the agent discovers from the publisher's live
  // feed instead of a CATALOG_URL. Precedence: RSS_URL > PUBLISHER_URL > CATALOG_URL,
  // then selectSource() throws — there is no bundled-demo fallback. rssSource reads
  // ${PUBLISHER_URL}/rss.xml unless RSS_URL overrides.
  PUBLISHER_URL: z.string().url().optional(),
  RSS_URL: z.string().url().optional(),
  // Optional — fills slug coverage RSS truncates (latest-N). Unused until sitemap
  // parsing lands; reserved here so the seam is config-complete.
  SITEMAP_URL: z.string().url().optional(),
  // Where the agent caches Citation Licenses it has been issued, so a live one
  // lets it re-read an essay free instead of paying again (across runs).
  WAYFARER_LICENSE_PATH: z.string().default(DEFAULT_LICENSE_STORE),

  // Dashboard
  DASHBOARD_PORT: z.coerce.number().int().positive().default(8403),
  // Interface the dashboard binds. Defaults to localhost: the earnings view has
  // no built-in auth and exposes author wallets + USD, so it must not face the
  // public internet directly. Set "0.0.0.0" only behind your own auth (reverse
  // proxy, access gateway). See README "Dashboard exposure".
  DASHBOARD_BIND: z.string().default("127.0.0.1"),
  // HTTP Basic credential ("user:pass") that gates the ops console when the
  // dashboard is bound wider than loopback. Unset + a non-loopback bind makes the
  // dashboard REFUSE to serve (fail-safe — it won't leak wallets by accident).
  DASHBOARD_AUTH: z.string().optional(),
  // Opt in to the PUBLIC earnings view: a read-only "authors are earning" page
  // with wallets masked and every operational panel hidden. Off by default — the
  // ops console (health, traffic, config, wallets) is never public.
  DASHBOARD_PUBLIC: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // The gate's base URL, so the dashboard can report gate health (GET /healthz).
  // Defaults to the local gate (TOLLGATE_PORT); unreachable → health shows "down".
  GATE_URL: z.string().url().default("http://127.0.0.1:8402"),

  // ── Storage backend ──
  // Where attributed events live. "jsonl" = an append-only local file (default,
  // no creds — great for dev/demo and a single-box deploy). "supabase" = a
  // Postgres table over Supabase's REST API, for serverless / multi-instance
  // hosts (e.g. Vercel) that have no shared disk. Same `EventSink` seam either way.
  EVENTS_BACKEND: z.enum(["jsonl", "supabase"]).default("jsonl"),
  // Where spent 402 nonces are remembered (replay protection). "memory" =
  // in-process (default; correct for a single instance). "supabase" = a shared
  // table, so replay protection holds across many serverless instances.
  NONCE_BACKEND: z.enum(["memory", "supabase"]).default("memory"),
  // Where buyer-authorized EXTRA settlement legs await their deferred on-chain settle
  // (the operator/co-author legs beyond the synchronous author leg). "memory" =
  // in-process (default; correct for a single instance / mock dev). "supabase" = a
  // shared table the deferred-settle drain reads, so pending authorizations survive a
  // restart and settle exactly-once across instances. Same PendingLegSink seam either way.
  PENDING_LEGS_BACKEND: z.enum(["memory", "supabase"]).default("memory"),
  // Supabase project — only needed when a *_BACKEND above is "supabase". The
  // service-role key is a secret; keep it in .env, never in the repo.
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_KEY: z.string().optional(),
  SUPABASE_EVENTS_TABLE: z.string().default("naulon_events"),
  SUPABASE_NONCES_TABLE: z.string().default("naulon_nonces"),
  SUPABASE_PENDING_LEGS_TABLE: z.string().default("naulon_pending_legs"),
  SUPABASE_SETTLEMENT_DELIVERY_TABLE: z.string().default("naulon_settlement_delivery"),
  SUPABASE_REVOCATIONS_TABLE: z.string().default("naulon_revocations"),
  // Where gated-request OBSERVATIONS go (the audit/observability plane — who was
  // served free / denied / paid). "off" (default) records nothing, so the open
  // core keeps its zero-overhead, nothing-stored posture; "jsonl" = a local file
  // (dev); "supabase" = a shared table a multi-tenant embedder reads for its audit
  // UI. Separate from EVENTS_BACKEND on purpose: observations are higher-volume,
  // lower-value, and TTL'd, so a deploy may want them in a different place (or off).
  OBSERVATIONS_BACKEND: z.enum(["off", "jsonl", "supabase"]).default("off"),
  SUPABASE_OBSERVATIONS_TABLE: z.string().default("naulon_observations"),

  // ── Citation License Tokens (CLT) ──
  // Signed receipts handed to a paying agent (see docs/citation-license.md).
  // On by default — they're additive (an extra response header) and the offline
  // path mints with an ephemeral key. A STABLE key is required (below) for real
  // payments or a supabase/multi-instance deploy.
  LICENSES_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Ed25519 private key (PKCS8 PEM or base64 DER) that signs licenses. SECRET.
  // Leave unset only for single-instance mock/dev (ephemeral key + boot warning).
  LICENSE_SIGNING_KEY: z.string().optional(),
  // Re-read window for a license, seconds. A CLT is an unrevocable bearer
  // credential on the offline tier, so the TTL is the kill switch — kept short.
  LICENSE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  // Issuer/audience string; defaults to `naulon:<gate host>` derived at runtime.
  LICENSE_ISSUER: z.string().optional(),
  // Embed the full payees graph (transparent, default) or just a hash + primary.
  LICENSE_PAYEES_MODE: z.enum(["full", "hashed"]).default("full"),
  // Consult the jti revocation seam on the online verify tier (P2). Off = the
  // offline JWKS tier only (exp-bounded). Needs shared state when on.
  LICENSE_ONLINE_CHECK: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Holder-of-key (P5): mint licenses bound to the payer wallet (RFC 7800 cnf),
  // and require a proof-of-possession (an EIP-191 wallet signature) on re-read.
  // Off by default — v1 licenses are short-TTL bearer tokens; turn this on to
  // close leak-replay (a captured token is then useless without the wallet key).
  // Needs a signing-capable buyer wallet (BUYER_PRIVATE_KEY, or the dev key on
  // the mock path) — the demo loop is unaffected while this is off.
  LICENSE_POP: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Freshness window (seconds) for a proof-of-possession: the gate accepts a
  // proof whose timestamp is within ±this of its clock, and remembers the proof
  // nonce for this long to stop replay. Shorter = tighter replay window; longer
  // = more clock-skew tolerance across instances.
  LICENSE_POP_WINDOW_SECONDS: z.coerce.number().int().positive().default(120),

  // Shared event ledger (jsonl backend). Tollgate appends here; dashboard +
  // attribution read it.
  EVENTS_PATH: z.string().default(DEFAULT_EVENTS_PATH),
  // Observation ledger (jsonl backend). Tollgate appends; the audit plane reads.
  OBSERVATIONS_PATH: z.string().default(DEFAULT_OBSERVATIONS_PATH),

  // Attribution & settlement.
  PAYOUTS_PATH: z.string().default(DEFAULT_PAYOUTS_PATH),
  // Don't settle a wallet until its accrued tolls reach this — amortizes the
  // per-transfer overhead across many sub-cent reads. Below it, carry forward.
  MIN_PAYOUT_USDC: z.coerce.number().positive().default(0.005),
  // How the single on-chain recipient is chosen when two co-authors tie for the
  // top share. "wallet" (default) breaks ties by address, so who gets the on-chain
  // leg is a pure function of who's credited — a reordered credits graph can't move
  // it. "input" keeps the credits-graph order. The full split is recorded either way.
  PRIMARY_PAYEE_TIEBREAK: z.enum(["wallet", "input"]).default("wallet"),
  // Pay co-authors directly on-chain (split-at-source) for multi-author articles
  // instead of routing the whole toll to the primary author. OFF by default → the
  // stock single-recipient toll (the rest of the split is recorded for the publisher
  // to reconcile off-protocol). ON → the primary's content-gating leg drops to its
  // own share and each other co-author gets a direct deferred buyer→author leg
  // (custody-free). Sets `PublisherConfig.coauthorSplit` for the single-tenant gate;
  // a multi-tenant resolver decides this per publisher instead.
  COAUTHOR_ONCHAIN_SPLIT: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
}).superRefine((cfg, ctx) => {
  // A "supabase" backend is useless without the project creds — fail loud at
  // boot, not mid-payment, naming exactly what's missing.
  const usesSupabase =
    cfg.EVENTS_BACKEND === "supabase" ||
    cfg.NONCE_BACKEND === "supabase" ||
    cfg.PENDING_LEGS_BACKEND === "supabase" ||
    cfg.SETTLEMENT_DELIVERY_BACKEND === "supabase" ||
    cfg.OBSERVATIONS_BACKEND === "supabase";
  if (usesSupabase) {
    for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"] as const) {
      if (!cfg[key]) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `required when EVENTS_BACKEND, NONCE_BACKEND or OBSERVATIONS_BACKEND is "supabase"`,
        });
      }
    }
  }

  // A CLT is a reusable, externally-verified token, so an ephemeral signing key
  // is only safe on a single-instance mock box. Require a stable key once real
  // money moves or any shared (supabase) backend / multi-instance is in play —
  // otherwise JWKS and the paid re-read go non-deterministic across instances.
  const needsStableKey =
    cfg.LICENSES_ENABLED && (cfg.PAYMENT_MODE !== "mock" || usesSupabase);
  if (needsStableKey && !cfg.LICENSE_SIGNING_KEY) {
    ctx.addIssue({
      code: "custom",
      path: ["LICENSE_SIGNING_KEY"],
      message:
        "required (stable Ed25519 key) when licensing is on with real payments or a supabase backend — " +
        "ephemeral keys break verification across instances. See docs/citation-license.md.",
    });
  }
  if (cfg.LICENSE_TTL_SECONDS > 3600) {
    ctx.addIssue({
      code: "custom",
      path: ["LICENSE_TTL_SECONDS"],
      message:
        "must be <= 3600: a CLT is an unrevocable bearer credential on the offline tier, so a short TTL is the kill switch.",
    });
  }
  if (cfg.LICENSE_POP_WINDOW_SECONDS > 600) {
    ctx.addIssue({
      code: "custom",
      path: ["LICENSE_POP_WINDOW_SECONDS"],
      message:
        "must be <= 600: the proof-of-possession window is a replay window — keep it tight (it only needs to cover clock skew + one round trip).",
    });
  }
});

export type Config = z.infer<typeof configSchema>;

let cached: Config | undefined;

export function getConfig(): Config {
  if (cached) return cached;
  const parsed = configSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}\nSee .env.example.`);
  }
  cached = parsed.data;
  return cached;
}

/**
 * Drop the memoized config so the next `getConfig()` re-reads `process.env`.
 * A test seam for the env-dependent branches the singleton otherwise freezes
 * (e.g. the Circle-key settlement guard) — not for production hot-reload.
 */
export function resetConfig(): void {
  cached = undefined;
}

/** Assert a set of keys are present (call at a component's boot once it knows what it needs). */
export function requireKeys(cfg: Config, keys: (keyof Config)[]): void {
  const missing = keys.filter((k) => cfg[k] === undefined || cfg[k] === "");
  if (missing.length) {
    throw new Error(`Missing required env: ${missing.join(", ")}. See .env.example.`);
  }
}
