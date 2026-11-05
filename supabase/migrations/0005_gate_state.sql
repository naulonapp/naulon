-- naulon_gate_state: the gate's own state, read and written by key.
--
-- What lives here: the secrets a gate generates on first boot (nonce secret, licence signing key,
-- testnet relayer key), its owner, its publisher settings, and the digest of every site
-- credential it issued. Used when NAULON_STATE_BACKEND=supabase, so several instances share one
-- copy; a single box keeps the same rows as files under NAULON_DATA_DIR instead.
--
-- First boot writes with insert ... on conflict do nothing and reads the row back, so instances
-- that boot together converge on the first value written and never on two.
--
-- The values include private keys. Only the service role may touch the table, and delete is
-- granted because a revoked site credential and a consumed setup token are removed, not kept.

create table if not exists public.naulon_gate_state (
  key        text primary key check (key ~ '^[a-z][a-z0-9_.:-]{0,190}$'),
  value      text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.naulon_gate_state enable row level security;

revoke all on public.naulon_gate_state from public, anon, authenticated;
grant select, insert, update, delete on public.naulon_gate_state to service_role;
revoke truncate on public.naulon_gate_state from service_role;
