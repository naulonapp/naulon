-- naulon — claim a settlement leg BEFORE broadcasting it.
--
-- `drainPendingLegs` used to settle on-chain first and compare-and-set (`markSettled`) after. That
-- reads as idempotent but is not: the CAS dedupes COUNTING, not BROADCASTING. A crash — or just a
-- failed PATCH — between the two left a leg whose money had already moved recorded as
-- `settled = false`. Every later drain re-broadcast it, the token contract rejected the spent
-- EIP-3009 authorization, the leg counted `failed`, and it churned until `valid_before` elapsed and
-- fell out of the pending set. A real transfer, permanently recorded as never settled.
--
-- A database write and an on-chain broadcast cannot be one atomic act, so the window cannot be
-- closed — only inverted. The drain now CLAIMS a leg (a conditional PATCH, the same compare-and-set
-- shape as markSettled) before broadcasting, so a crash leaves it visibly claimed rather than
-- invisibly pending. `claimed_until` is a lease, not a boolean, so it is self-healing: a process
-- that dies mid-attempt releases its claim by the clock.
--
-- Column name matches tollgate/src/pendingLegs.ts (supabasePendingLegSink).
--
-- Apply with EITHER:
--   • Supabase SQL editor — paste this file and run, or
--   • the Supabase CLI:  supabase db push   (from the repo root)

alter table naulon_pending_legs
  add column if not exists claimed_until bigint;

comment on column naulon_pending_legs.claimed_until is
  'Epoch ms a drain holds this leg for a settle attempt. NULL = unclaimed. A past value is a lapsed lease and the leg is claimable again. Claimed does NOT mean settled.';

-- pending() now also filters on claimability, so the partial index backing it must cover the same
-- predicate — otherwise each drain degrades to a sequential scan as the table grows.
drop index if exists naulon_pending_legs_pending_idx;
create index if not exists naulon_pending_legs_pending_idx
  on naulon_pending_legs (valid_before, claimed_until) where settled = false;
