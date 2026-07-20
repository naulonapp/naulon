-- naulon_settlement_delivery — mutable per-event DELIVERY state for the settlement drain.
--
-- WHY A SEPARATE TABLE, AND NOT A COLUMN ON naulon_events
--
-- naulon_events is the settlement LEDGER: it records that money moved. It is deliberately
-- append-only (the hosted control plane grants service_role only select+insert and
-- explicitly revokes update/delete/truncate), because a row there is a financial fact.
-- Whether we have successfully REPORTED that fact to the publisher is a different
-- lifecycle entirely — mutable, retried, eventually terminal. Putting `acked` on the
-- ledger would have meant granting UPDATE on the money table to get retry bookkeeping,
-- which trades a real security property for a convenience. So delivery state gets its own
-- table, keyed by event id.
--
-- WHAT IT FIXES
--
--   1. Ack state used to live in a process-local JSONL outbox. Correct, but invisible to
--      the database: every sweep re-read the entire lifetime ledger and re-filtered it in
--      memory, and a multi-instance fleet had every box redundantly re-POSTing everything.
--   2. Retry was unbounded and invisible. A permanently-failing event got a fresh full
--      retry ladder every sweep, forever, with no persisted attempt count, no cross-sweep
--      backoff, no dead-letter and nothing surfaced.
--
-- DEAD-LETTERED MEANS PARKED AND VISIBLE, NEVER DROPPED. The money is still owed. There is
-- deliberately NO age cutoff anywhere in this design: silently abandoning owed money is the
-- one outcome worse than retrying forever. A dead letter stops the automatic ladder and
-- raises its hand; an operator clears dead_lettered_at and the next sweep picks it up.
--
-- TRANSITION FROM THE JSONL OUTBOX (first run after deploy)
--
-- The old outbox may hold acks this table does not know about. That is SAFE and needs no
-- backfill: an event with no row here is simply DUE, so the first sweep after deploy
-- re-POSTs it, the publisher dedupes it on eventId ({"deduped":true}), and this table
-- records the ack. The cost is one redundant POST per already-acked event, once. Losing an
-- ack has always been the safe direction — that is the property that makes at-least-once
-- delivery correct — so we spend it rather than build a migration path for a file that
-- lives on a container filesystem. Concretely: expect one larger-than-usual first sweep,
-- then steady state. The file backend (self-host) keeps reading the outbox unchanged.
--
-- Column names match tollgate/src/settlementDelivery.ts (supabaseSettlementDeliveryStore).
--
-- Additive and idempotent: safe to run against a live table with existing rows.

create table if not exists public.naulon_settlement_delivery (
  -- The AttributedEvent.id this state belongs to. Primary key → the store's upsert is
  -- idempotent and two instances cannot create competing rows for one event.
  -- Deliberately NOT a foreign key to naulon_events: the delivery plane must never be
  -- able to block or cascade into the money ledger.
  event_id          uuid primary key,
  -- The resolved publisher (tenant), denormalized from the event so the due-query and the
  -- operator's dead-letter read are index-scannable per tenant without joining the ledger.
  -- NULL for a single-tenant gate.
  publisher         text,
  -- Set once the publisher confirms the settlement. Terminal success: never re-sent.
  acked_at          timestamptz,
  -- How many SWEEPS have failed on this event. NOT the per-sweep retry ladder
  -- (SETTLEMENT_MAX_ATTEMPTS) — this counts sweeps, and drives the dead-letter threshold.
  attempts          int not null default 0,
  last_attempt_at   timestamptz,
  -- When this event becomes eligible again. Defaults to now() so a freshly-inserted row is
  -- immediately due. Each failure pushes it out: now + min(base * 2^(attempts-1), cap).
  next_attempt_at   timestamptz not null default now(),
  -- Set when the attempt budget ran out. Parked + surfaced to an operator; still owed.
  dead_lettered_at  timestamptz,
  -- Why the last attempt failed — what an operator reads to decide what to do. Never a
  -- secret: the drain writes a classification ("permanent: 400 malformed payload",
  -- "repeated 401 …"), not a response body.
  last_error        text,
  created_at        timestamptz not null default now()
);

-- The due-query's predicate: unacked, not dead-lettered, past its next attempt, for one
-- publisher. A partial index on exactly that predicate keeps the sweep off a sequential
-- scan as the table grows to one row per lifetime settlement.
create index if not exists naulon_settlement_delivery_due
  on public.naulon_settlement_delivery (publisher, next_attempt_at)
  where acked_at is null and dead_lettered_at is null;

-- The operator's stuck-money read: dead-lettered, unacked, newest first.
create index if not exists naulon_settlement_delivery_dead
  on public.naulon_settlement_delivery (publisher, dead_lettered_at desc)
  where dead_lettered_at is not null and acked_at is null;

-- Same isolation posture as naulon_events / naulon_pending_legs: RLS on + FORCED with ZERO
-- policies, so anon/authenticated get nothing and only service_role (which bypasses RLS)
-- can reach it. Fail closed. Unlike the events ledger this table DOES need update — that
-- is the whole point of separating it — so update is granted here and nowhere near the
-- money ledger. delete/truncate stay revoked: delivery history is evidence too.
alter table public.naulon_settlement_delivery enable row level security;
alter table public.naulon_settlement_delivery force row level security;
revoke all on public.naulon_settlement_delivery from anon, authenticated;
grant select, insert, update on public.naulon_settlement_delivery to service_role;
revoke delete, truncate on public.naulon_settlement_delivery from service_role;

comment on table public.naulon_settlement_delivery is
  'Mutable per-event settlement DELIVERY state (acked / attempts / backoff / dead-letter). Companion to the append-only naulon_events ledger, which must never be mutated. SERVICE-ROLE ONLY (RLS on+forced, no policies). Dead-lettered = parked and operator-visible, NEVER dropped: the money is still owed.';

comment on column public.naulon_settlement_delivery.dead_lettered_at is
  'Attempt budget exhausted. The event is PARKED, not abandoned — it stays retryable and an operator revive clears this and sets next_attempt_at=now(). There is no age cutoff in this design by deliberate choice.';

-- ── The due-selection function ───────────────────────────────────────────────────────
--
-- An event is DUE when it has NO delivery row at all, OR its row is unacked, not
-- dead-lettered, and past next_attempt_at. That is an ANTI-JOIN across two tables, which
-- PostgREST's query grammar cannot express in a URL — hence a SQL function called via
-- POST /rest/v1/rpc/naulon_settlement_due.
--
-- p_limit is REQUIRED and applied inside the function, so the result can never be
-- silently clipped by PostgREST's db-max-rows (the failure mode that let an unbounded
-- ledger read return its oldest N rows and call it complete). p_now is passed by the
-- caller rather than read as now() so the drain's clock is the one clock in play.

create or replace function public.naulon_settlement_due(
  p_publisher text,
  p_now       timestamptz,
  p_limit     int
)
returns table (data jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select e.data
  from public.naulon_events e
  left join public.naulon_settlement_delivery d on d.event_id = e.id
  where (p_publisher is null or e.publisher = p_publisher)
    and (
      d.event_id is null                      -- never attempted
      or (
        d.acked_at is null
        and d.dead_lettered_at is null
        and d.next_attempt_at <= p_now
      )
    )
  order by e.at asc, e.id asc                 -- (at, id): `at` alone ties within a ms
  limit p_limit;
$$;

comment on function public.naulon_settlement_due(text, timestamptz, int) is
  'Settlement events DUE for a delivery attempt: no delivery row, or an unacked, non-dead-lettered row past next_attempt_at. Oldest first, hard-limited by p_limit so the result is never clipped by db-max-rows.';

revoke all on function public.naulon_settlement_due(text, timestamptz, int) from public, anon, authenticated;
grant execute on function public.naulon_settlement_due(text, timestamptz, int) to service_role;
