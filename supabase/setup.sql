-- Run this once in the Supabase SQL Editor for the project used by Tea Chat.
-- Public profile photos contain no private account data; uploads are restricted
-- to a folder named for the authenticated user's Supabase ID.

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  constraint friend_requests_no_self check (sender_id <> recipient_id)
);

create unique index if not exists friend_requests_one_per_pair
  on public.friend_requests (least(sender_id, recipient_id), greatest(sender_id, recipient_id));

create index if not exists friend_requests_recipient_status
  on public.friend_requests (recipient_id, status);

alter table public.friend_requests enable row level security;
grant select, insert, update, delete on public.friend_requests to authenticated;

drop policy if exists "Participants can read friend requests" on public.friend_requests;
create policy "Participants can read friend requests"
  on public.friend_requests for select to authenticated
  using (auth.uid() = sender_id or auth.uid() = recipient_id);

drop policy if exists "Members can send friend requests" on public.friend_requests;
create policy "Members can send friend requests"
  on public.friend_requests for insert to authenticated
  with check (
    auth.uid() = sender_id
    and sender_id <> recipient_id
    and status = 'pending'
  );

drop policy if exists "Recipients can respond to requests" on public.friend_requests;
create policy "Recipients can respond to requests"
  on public.friend_requests for update to authenticated
  using (auth.uid() = recipient_id and status = 'pending')
  with check (auth.uid() = recipient_id and status in ('accepted', 'declined'));

drop policy if exists "Senders can retry declined requests" on public.friend_requests;
create policy "Senders can retry declined requests"
  on public.friend_requests for update to authenticated
  using (auth.uid() = sender_id and status = 'declined')
  with check (auth.uid() = sender_id and status = 'pending');

drop policy if exists "Participants can clear declined requests" on public.friend_requests;
create policy "Participants can clear declined requests"
  on public.friend_requests for delete to authenticated
  using (
    status = 'declined'
    and (auth.uid() = sender_id or auth.uid() = recipient_id)
  );

create or replace function public.keep_friend_request_participants()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.id is distinct from old.id
    or new.sender_id is distinct from old.sender_id
    or new.recipient_id is distinct from old.recipient_id
    or new.created_at is distinct from old.created_at then
    raise exception 'Friend request participants and creation time cannot be changed';
  end if;
  return new;
end;
$$;

drop trigger if exists keep_friend_request_participants on public.friend_requests;
create trigger keep_friend_request_participants
  before update on public.friend_requests
  for each row execute function public.keep_friend_request_participants();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'profile-photos',
  'profile-photos',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Members can upload their own profile photos" on storage.objects;
create policy "Members can upload their own profile photos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Members can update their own profile photos" on storage.objects;
create policy "Members can update their own profile photos"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Members can delete their own profile photos" on storage.objects;
create policy "Members can delete their own profile photos"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
