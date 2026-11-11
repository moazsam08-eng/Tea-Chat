-- Daily plain-text message limit: 10 messages per user, per conversation, per Cairo day.
create table if not exists public.daily_text_message_limits (
  channel_cid text not null check (char_length(channel_cid) between 1 and 255),
  user_id uuid not null references auth.users(id) on delete cascade,
  local_date date not null,
  message_count smallint not null default 0 check (message_count between 0 and 10),
  updated_at timestamptz not null default now(),
  primary key (channel_cid, user_id)
);

alter table public.daily_text_message_limits enable row level security;
revoke all on table public.daily_text_message_limits from public, anon, authenticated;

create or replace function public.consume_daily_text_message(p_channel_cid text, p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_count integer;
begin
  if p_user_id is null or p_channel_cid is null
    or btrim(p_channel_cid) <> p_channel_cid
    or char_length(p_channel_cid) < 1 or char_length(p_channel_cid) > 255 then
    raise exception 'Invalid message limit request.' using errcode = '22023';
  end if;

  insert into public.daily_text_message_limits (channel_cid, user_id, local_date, message_count, updated_at)
  values (p_channel_cid, p_user_id, v_today, 1, now())
  on conflict (channel_cid, user_id) do update
    set local_date = excluded.local_date,
        message_count = case
          when daily_text_message_limits.local_date <> excluded.local_date then 1
          else daily_text_message_limits.message_count + 1
        end,
        updated_at = now()
    where daily_text_message_limits.local_date <> excluded.local_date
       or daily_text_message_limits.message_count < 10
  returning message_count into v_count;

  if v_count is not null then
    return v_count;
  end if;

  select message_count into v_count
  from public.daily_text_message_limits
  where channel_cid = p_channel_cid and user_id = p_user_id;

  return -1;
end;
$$;

create or replace function public.get_daily_text_message_count(p_channel_cid text)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_count integer;
begin
  if v_user_id is null then
    raise exception 'Sign in to view your message limit.' using errcode = '42501';
  end if;
  if p_channel_cid is null or char_length(p_channel_cid) < 1 or char_length(p_channel_cid) > 255 then
    raise exception 'Invalid conversation.' using errcode = '22023';
  end if;

  select message_count into v_count
  from public.daily_text_message_limits
  where channel_cid = p_channel_cid
    and user_id = v_user_id
    and local_date = v_today;

  return coalesce(v_count, 0);
end;
$$;

revoke all on function public.consume_daily_text_message(text, uuid) from public, anon, authenticated;
grant execute on function public.consume_daily_text_message(text, uuid) to service_role;
revoke all on function public.get_daily_text_message_count(text) from public, anon;
grant execute on function public.get_daily_text_message_count(text) to authenticated;
