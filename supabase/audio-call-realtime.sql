-- Tea Chat audio-call signaling.
-- This adds RLS policies only. It does not create, alter, or delete any app tables.
-- Apply once in the Supabase SQL Editor, then disable "Allow public access" in
-- Project Settings > Realtime Settings so all topics must use private channels.
--
-- Broadcast messages are sent over Realtime and are not persisted as call logs.
-- The recipient can read only their own inbox. A sender can publish to an
-- accepted friend's inbox, but cannot read that inbox.

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
  and (select realtime.topic()) like 'tea-audio:v1:inbox:%'
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
