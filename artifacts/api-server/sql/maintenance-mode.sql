-- Tea Chat seven-day maintenance mode state.
-- Run this once in the Supabase SQL Editor.
create table if not exists public.app_maintenance (
  id text primary key check (id = 'global'),
  started_at timestamptz not null
);

alter table public.app_maintenance enable row level security;

-- The application accesses this table only through the server-side service role key.
revoke all on table public.app_maintenance from anon, authenticated;
