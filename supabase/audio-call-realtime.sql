-- Tea Chat audio-call signaling.
-- This changes policies only; it does not create, alter, or delete app tables.
-- Apply or reapply this file in the Supabase SQL Editor after policy changes.
-- Keep 'Allow public access' disabled so all signaling uses private channels.
-- Broadcast messages are not persisted as call logs.
-- Receivers can read only their own inbox. Callers publish to a friend's inbox
-- over HTTP Broadcast without subscribing to or reading that inbox.

drop policy if exists "Tea Chat audio calls: receive own inbox" on realtime.messages;
create policy "Tea Chat audio calls: receive own inbox"
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and (select realtime.topic()) = 'tea-audio:v1:inbox:' || (select auth.uid())::text
);

drop policy if exists "Tea Chat audio calls: send to accepted friends" on realtime.messages;
create policy "Tea Chat audio calls: send to accepted friends"
on realtime.messages
for insert
to authenticated
with check (
  realtime.messages.extension = 'broadcast'
  and (select realtime.topic()) ~* '^tea-audio:v1:inbox:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and realtime.messages.payload ->> 'fromUserId' = (select auth.uid())::text
  and realtime.messages.payload ->> 'toUserId' = split_part((select realtime.topic()), ':', 4)
  and exists (
    select 1
    from public.friend_requests as friendship
    where friendship.status = 'accepted'
      and (
        (
          friendship.sender_id = (select auth.uid())
          and friendship.recipient_id::text = split_part((select realtime.topic()), ':', 4)
        )
        or (
          friendship.recipient_id = (select auth.uid())
          and friendship.sender_id::text = split_part((select realtime.topic()), ':', 4)
        )
      )
  )
);
