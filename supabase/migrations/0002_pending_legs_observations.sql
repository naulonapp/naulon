-- naulon — Supabase schema for the two opt-in serverless backends 0001 missed.
--
-- config.ts offers PENDING_LEGS_BACKEND=supabase and OBSERVATIONS_BACKEND=supabase
-- (defaulting their table names to naulon_pending_legs / naulon_observations), but
-- 0001_naulon.sql never created either table — so turning those backends on failed
-- at runtime with a missing-relation error. This migration closes that gap.
--
-- Column/table names match tollgate/src/pendingLegs.ts (supabasePendingLegSink) and
-- shared/src/observationsink.ts (supabaseObservationSink). If you rename a table, set
-- SUPABASE_PENDING_LEGS_TABLE / SUPABASE_OBSERVATIONS_TABLE to match.
--
-- Apply with EITHER:
--   • Supabase SQL editor — paste this file and run, or
--   • the Supabase CLI:  supabase db push   (from the repo root)

-- ── Deferred extra-settlement legs (operator/co-author fee, async settle) ───
-- One row per buyer-authorized EXTRA leg awaiting a deferred on-chain settle. `id`
-- (the leg's EIP-3009 authorization nonce) is the primary key, which makes `record`
-- idempotent and is the on-chain replay key. The whole PendingLeg is stored as jsonb
-- `data` so the drain settles the exact buyer payload the gate recorded — no mapping
-- to drift. `settled` + `valid_before` are top-level columns because the drain's
-- pending() query filters on them server-side (settled=false AND valid_before>now,
-- oldest first); `publisher` is top-level so a scoped drain can settle one
-- publisher's legs. `markSettled` flips `settled` with a conditional PATCH (the DB
-- decides the winner of a concurrent settle), stamping `settlement_ref`.
create table if not exists naulon_pending_legs (
  id             text primary key,
  publisher      text,
  valid_before   bigint not null,
  settled        boolean not null default false,
  settlement_ref text,
  data           jsonb  not null,
  created_at     timestamptz not null default now()
);

-- The drain sweep: unsettled legs still inside their validity window, oldest first.
create index if not exists naulon_pending_legs_pending_idx
  on naulon_pending_legs (valid_before) where settled = false;
-- Scoped drain (one publisher's legs).
create index if not exists naulon_pending_legs_publisher_idx
  on naulon_pending_legs (publisher);

-- ── Observation ledger (the negative space the settlement ledger never sees) ─
-- One row per observation: crawlers served free, agents denied at the 402, agents
-- that paid. Opt-in (OBSERVATIONS_BACKEND=supabase) — the open core emits nothing
-- by default. `id` is the primary key (idempotent retry) — a uuid: the gate stamps
-- every ObservationEvent.id with crypto.randomUUID() (tollgate/src/app.ts), so the
-- column is `uuid`, NOT text (pending_legs.id above is text — that one is an EIP-3009
-- nonce, not a uuid). The whole ObservationEvent is stored as jsonb `data`, `at`
-- (epoch ms) is indexed for ordering + TTL sweeps, and `publisher` (= PublisherConfig.id,
-- null for single-tenant) is top-level so a downstream audit BFF filters one publisher's
-- observations server-side. The downstream owns this table's retention policy; the gate
-- only writes.
create table if not exists naulon_observations (
  id         uuid primary key,
  at         bigint not null,
  publisher  text,
  data       jsonb  not null,
  created_at timestamptz not null default now()
);

create index if not exists naulon_observations_at_idx on naulon_observations (at);
create index if not exists naulon_observations_publisher_idx on naulon_observations (publisher);

-- Access note: as with 0001, these tables are written with the SERVICE-ROLE key
-- (server-side only), which bypasses RLS. They are never exposed to a browser or the
-- anon key, so no row-level-security policies are defined. Do not expose them.
