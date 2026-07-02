-- naulon — Supabase schema for the serverless storage backend.
--
-- Apply this once to the project you point SUPABASE_URL at. Two tables back the
-- two pieces of state the tollgate can't keep on a local disk when it runs as
-- many serverless instances: the attributed-event ledger, and the spent-nonce
-- set used for x402 replay protection.
--
-- Table/column names match shared/src/eventsink.ts and tollgate/src/nonce.ts.
-- If you rename a table, also set SUPABASE_EVENTS_TABLE / SUPABASE_NONCES_TABLE.
--
-- Apply with EITHER:
--   • Supabase SQL editor — paste this file and run, or
--   • the Supabase CLI:  supabase db push   (from the repo root)

-- ── Attributed-event ledger ────────────────────────────────────────────────
-- One row per paid read/citation. The whole AttributedEvent is stored as jsonb
-- in `data`, so readAll() returns the exact shape the gate wrote — no mapping to
-- drift. `id` is the primary key, which makes a retried write idempotent; `at`
-- (epoch ms) is indexed because the dashboard reads the ledger ordered by time.
-- `publisher` is a top-level column (= PublisherConfig.id, null for single-tenant)
-- so a scoped `readAll` can filter one publisher's events server-side — the
-- embedding seam a downstream resolver-based deploy uses. Indexed for that sweep.
create table if not exists naulon_events (
  id         text primary key,
  at         bigint not null,
  publisher  text,
  data       jsonb  not null,
  created_at timestamptz not null default now()
);
-- Idempotent for projects that already applied an earlier version of this file.
alter table naulon_events add column if not exists publisher text;

create index if not exists naulon_events_at_idx on naulon_events (at);
create index if not exists naulon_events_publisher_idx on naulon_events (publisher);

-- ── Spent-nonce set (x402 replay protection) ───────────────────────────────
-- `nonce` is the primary key: single-use is enforced by the unique constraint,
-- so consuming a nonce is one atomic INSERT (a conflict == replay). `exp_ms` is
-- the nonce's own expiry; rows past it are dead weight and can be swept (below).
create table if not exists naulon_nonces (
  nonce      text primary key,
  exp_ms     bigint not null,
  created_at timestamptz not null default now()
);

create index if not exists naulon_nonces_exp_idx on naulon_nonces (exp_ms);

-- ── License revocation denylist (CLT kill switch) ──────────────────────────
-- A revoked license `jti` (= event id). Enforced on the online verify tier and
-- the gate's own re-read path when LICENSE_ONLINE_CHECK=true. The offline JWKS
-- tier cannot consult this by design (see docs/citation-license.md); the short
-- token TTL bounds that residual window.
create table if not exists naulon_revocations (
  jti        text primary key,
  created_at timestamptz not null default now()
);

-- Optional housekeeping: drop expired nonces. Spent nonces never need to live
-- past their TTL (an expired nonce is rejected on signature/expiry before the
-- store is even consulted). Schedule this with pg_cron if you like, e.g.:
--   select cron.schedule('naulon-nonce-sweep', '*/15 * * * *',
--     $$delete from naulon_nonces where exp_ms < (extract(epoch from now()) * 1000)$$);
-- It's purely a space optimization; correctness doesn't depend on it.

-- Note on access: the tollgate/dashboard/attribution services talk to these
-- tables with the SERVICE-ROLE key (server-side only), which bypasses RLS. These
-- tables are never exposed to a browser or the anon key, so no row-level-security
-- policies are defined here. Do not expose them with the anon key.
