-- Run once in the Supabase SQL Editor before enabling per-chat passcode locks.
-- Passcodes are hashed in Postgres; raw passcodes and hashes are never returned to the browser.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.chat_lock_codes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  code_hash text not null,
  code_type text not null check (code_type in ('numbers', 'letters', 'both')),
  updated_at timestamptz not null default now()
);

create table if not exists public.chat_locked_conversations (
  user_id uuid not null references auth.users(id) on delete cascade,
  channel_cid text not null check (char_length(channel_cid) between 1 and 255),
  created_at timestamptz not null default now(),
  primary key (user_id, channel_cid)
);

create table if not exists public.chat_lock_attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  failed_attempts smallint not null default 0 check (failed_attempts between 0 and 4),
  locked_until timestamptz
);

alter table public.chat_lock_codes enable row level security;
alter table public.chat_locked_conversations enable row level security;
alter table public.chat_lock_attempts enable row level security;
revoke all on table public.chat_lock_codes from public, anon, authenticated;
revoke all on table public.chat_locked_conversations from public, anon, authenticated;
revoke all on table public.chat_lock_attempts from public, anon, authenticated;

create or replace function public.get_chat_lock_code_type()
returns text
language sql
security definer
set search_path = pg_catalog, public, extensions
as $$
  select code_type from public.chat_lock_codes where user_id = auth.uid();
$$;

create or replace function public.list_locked_chat_cids()
returns table (channel_cid text)
language sql
security definer
set search_path = pg_catalog, public, extensions
as $$
  select channel_cid
  from public.chat_locked_conversations
  where user_id = auth.uid()
  order by created_at desc;
$$;

create or replace function public.set_chat_lock_code(p_code text, p_code_type text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing_hash text;
  v_existing_type text;
  v_auth_time double precision;
begin
  if v_user_id is null then
    raise exception 'Sign in to manage chat locks.' using errcode = '42501';
  end if;
  if p_code is null or p_code_type not in ('numbers', 'letters', 'both') then
    raise exception 'Choose a valid passcode type and passcode.' using errcode = '22023';
  end if;
  if (p_code_type = 'numbers' and p_code !~ '^[0-9]{4,32}$')
    or (p_code_type = 'letters' and p_code !~ '^[A-Za-z]{4,32}$')
    or (p_code_type = 'both' and p_code !~ '^[A-Za-z0-9]{4,32}$') then
    raise exception 'Passcodes must be 4 to 32 characters and match the selected type.' using errcode = '22023';
  end if;

  select code_hash, code_type
    into v_existing_hash, v_existing_type
    from public.chat_lock_codes
    where user_id = v_user_id
    for update;

  if v_existing_hash is not null
    and (v_existing_type is distinct from p_code_type or crypt(p_code, v_existing_hash) is distinct from v_existing_hash) then
    v_auth_time := nullif(auth.jwt() ->> 'auth_time', '')::double precision;
    if v_auth_time is null or to_timestamp(v_auth_time) < now() - interval '10 minutes' then
      raise exception 'Verify your account again before changing your lock code.' using errcode = '42501';
    end if;
  end if;

  insert into public.chat_lock_codes (user_id, code_hash, code_type, updated_at)
  values (v_user_id, crypt(p_code, gen_salt('bf', 12)), p_code_type, now())
  on conflict (user_id) do update
    set code_hash = excluded.code_hash,
        code_type = excluded.code_type,
        updated_at = excluded.updated_at;

  delete from public.chat_lock_attempts where user_id = v_user_id;
end;
$$;

create or replace function public.add_chat_lock(p_channel_cid text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_user_id uuid := auth.uid();
  v_lock_count integer;
begin
  if v_user_id is null then
    raise exception 'Sign in to manage chat locks.' using errcode = '42501';
  end if;
  if p_channel_cid is null or btrim(p_channel_cid) <> p_channel_cid
    or char_length(p_channel_cid) < 1 or char_length(p_channel_cid) > 255 then
    raise exception 'This conversation cannot be locked.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.chat_lock_codes where user_id = v_user_id) then
    raise exception 'Create a lock code before locking a conversation.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.chat_locked_conversations
    where user_id = v_user_id and channel_cid = p_channel_cid
  ) then
    select count(*) into v_lock_count
    from public.chat_locked_conversations where user_id = v_user_id;
    if v_lock_count >= 100 then
      raise exception 'You can lock up to 100 conversations.' using errcode = '22023';
    end if;
  end if;
  insert into public.chat_locked_conversations (user_id, channel_cid)
  values (v_user_id, p_channel_cid)
  on conflict (user_id, channel_cid) do nothing;
end;
$$;

create or replace function public.verify_chat_lock(p_channel_cid text, p_code text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_user_id uuid := auth.uid();
  v_code_hash text;
  v_failed_attempts smallint;
  v_locked_until timestamptz;
begin
  if v_user_id is null or p_channel_cid is null or p_code is null
    or char_length(p_code) < 1 or char_length(p_code) > 32 then
    return false;
  end if;

  select c.code_hash into v_code_hash
  from public.chat_lock_codes c
  join public.chat_locked_conversations l on l.user_id = c.user_id
  where c.user_id = v_user_id and l.channel_cid = p_channel_cid;
  if not found then return false; end if;

  insert into public.chat_lock_attempts (user_id) values (v_user_id)
  on conflict (user_id) do nothing;
  select failed_attempts, locked_until into v_failed_attempts, v_locked_until
  from public.chat_lock_attempts where user_id = v_user_id for update;

  if v_locked_until is not null and v_locked_until > now() then
    return false;
  end if;
  if v_locked_until is not null then
    update public.chat_lock_attempts
      set failed_attempts = 0, locked_until = null where user_id = v_user_id;
  end if;

  if crypt(p_code, v_code_hash) = v_code_hash then
    update public.chat_lock_attempts
      set failed_attempts = 0, locked_until = null where user_id = v_user_id;
    return true;
  end if;

  update public.chat_lock_attempts
    set failed_attempts = case when failed_attempts >= 4 then 0 else failed_attempts + 1 end,
        locked_until = case when failed_attempts >= 4 then now() + interval '5 minutes' else null end
    where user_id = v_user_id;
  return false;
end;
$$;

create or replace function public.remove_chat_lock(p_channel_cid text, p_code text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  if not public.verify_chat_lock(p_channel_cid, p_code) then
    return false;
  end if;
  delete from public.chat_locked_conversations
  where user_id = auth.uid() and channel_cid = p_channel_cid;
  return found;
end;
$$;

revoke all on function public.get_chat_lock_code_type() from public, anon;
revoke all on function public.list_locked_chat_cids() from public, anon;
revoke all on function public.set_chat_lock_code(text, text) from public, anon;
revoke all on function public.add_chat_lock(text) from public, anon;
revoke all on function public.verify_chat_lock(text, text) from public, anon;
revoke all on function public.remove_chat_lock(text, text) from public, anon;
grant execute on function public.get_chat_lock_code_type() to authenticated;
grant execute on function public.list_locked_chat_cids() to authenticated;
grant execute on function public.set_chat_lock_code(text, text) to authenticated;
grant execute on function public.add_chat_lock(text) to authenticated;
grant execute on function public.verify_chat_lock(text, text) to authenticated;
grant execute on function public.remove_chat_lock(text, text) to authenticated;
