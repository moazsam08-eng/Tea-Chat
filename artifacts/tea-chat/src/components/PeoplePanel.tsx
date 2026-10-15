import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Check, MessageCircle, Search, UserPlus, Users, X } from 'lucide-react';

export type Person = {
  id: string;
  name: string;
  image: string | null;
};

type FriendRequest = {
  id: string;
  sender_id: string;
  recipient_id: string;
  status: 'pending' | 'accepted' | 'declined';
  created_at: string;
};

type PeoplePanelProps = {
  supabase: SupabaseClient;
  currentUserId: string;
  onClose: () => void;
  onStartChat: (person: Person) => void;
};

type PeopleTab = 'discover' | 'requests' | 'friends';

async function readError(response: Response) {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error || `Request failed (${response.status}).`;
}

export function PeoplePanel({ supabase, currentUserId, onClose, onStartChat }: PeoplePanelProps) {
  const [tab, setTab] = useState<PeopleTab>('discover');
  const [search, setSearch] = useState('');
  const [people, setPeople] = useState<Person[]>([]);
  const [requests, setRequests] = useState<FriendRequest[]>([]);
  const [requestProfiles, setRequestProfiles] = useState<Record<string, Person>>({});
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      async function load() {
        setLoading(true);
        setError('');
        setNextOffset(null);
        try {
          const { data: { session } } = await supabase.auth.getSession();
          if (!session) throw new Error('Your sign-in session expired. Please sign in again.');

          const [directoryResponse, requestResult] = await Promise.all([
            fetch(`/api/people?search=${encodeURIComponent(search.trim())}`, {
              headers: { Authorization: `Bearer ${session.access_token}` },
            }),
            supabase
              .from('friend_requests')
              .select('id,sender_id,recipient_id,status,created_at')
              .or(`sender_id.eq.${currentUserId},recipient_id.eq.${currentUserId}`),
          ]);

          if (!directoryResponse.ok) throw new Error(await readError(directoryResponse));
          if (requestResult.error) {
            throw new Error('Friend requests are not set up yet. Apply supabase/setup.sql in your Supabase project.');
          }

          const directory = await directoryResponse.json() as { users?: Person[]; nextOffset?: number | null };
          const rows = (requestResult.data ?? []) as FriendRequest[];
          const relatedIds = [...new Set(rows.map((row) => row.sender_id === currentUserId ? row.recipient_id : row.sender_id))];
          const directoryById = new Map((directory.users ?? []).map((person) => [person.id, person]));
          const missingIds = relatedIds.filter((id) => !directoryById.has(id));
          let relatedPeople: Person[] = [];
          if (missingIds.length) {
            const profilesResponse = await fetch(`/api/people?ids=${encodeURIComponent(missingIds.slice(0, 100).join(','))}`, {
              headers: { Authorization: `Bearer ${session.access_token}` },
            });
            if (profilesResponse.ok) {
              const body = await profilesResponse.json() as { users?: Person[] };
              relatedPeople = body.users ?? [];
            }
          }

          if (cancelled) return;
          setPeople(directory.users ?? []);
          setRequests(rows);
          setRequestProfiles(Object.fromEntries(relatedPeople.map((person) => [person.id, person])));
          setNextOffset(directory.nextOffset ?? null);
        } catch (reason) {
          if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not load people. Please try again.');
        } finally {
          if (!cancelled) setLoading(false);
        }
      }
      void load();
    }, search.trim() ? 180 : 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [currentUserId, refreshKey, search, supabase]);

  const profiles = useMemo(() => {
    const map = new Map<string, Person>(Object.entries(requestProfiles));
    for (const person of people) map.set(person.id, person);
    return map;
  }, [people, requestProfiles]);

  const incoming = requests.filter((request) => request.status === 'pending' && request.recipient_id === currentUserId);
  const outgoing = requests.filter((request) => request.status === 'pending' && request.sender_id === currentUserId);
  const friends = requests.filter((request) => request.status === 'accepted');

  async function loadMore() {
    if (nextOffset === null || loadingMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Your sign-in session expired. Please sign in again.');
      const response = await fetch(`/api/people?search=${encodeURIComponent(search.trim())}&offset=${nextOffset}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json() as { users?: Person[]; nextOffset?: number | null };
      setPeople((current) => {
        const byId = new Map(current.map((person) => [person.id, person]));
        for (const person of body.users ?? []) byId.set(person.id, person);
        return [...byId.values()];
      });
      setNextOffset(body.nextOffset ?? null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load more people.');
    } finally {
      setLoadingMore(false);
    }
  }

  async function sendRequest(person: Person) {
    setBusyId(person.id);
    setError('');
    try {
      const existing = requests.find((row) =>
        (row.sender_id === currentUserId && row.recipient_id === person.id) ||
        (row.sender_id === person.id && row.recipient_id === currentUserId),
      );
      if (existing?.status === 'declined') {
        const { error: deleteError } = await supabase
          .from('friend_requests')
          .delete()
          .eq('id', existing.id)
          .eq('status', 'declined');
        if (deleteError) throw new Error(deleteError.message);
      }
      const { error: insertError } = await supabase.from('friend_requests').insert({
        sender_id: currentUserId,
        recipient_id: person.id,
        status: 'pending',
      });
      if (insertError) throw new Error(insertError.message);
      setRefreshKey((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not send this friend request.');
    } finally {
      setBusyId('');
    }
  }

  async function respondToRequest(request: FriendRequest, status: 'accepted' | 'declined') {
    setBusyId(request.id);
    setError('');
    try {
      const { data, error: updateError } = await supabase
        .from('friend_requests')
        .update({ status })
        .eq('id', request.id)
        .eq('recipient_id', currentUserId)
        .eq('status', 'pending')
        .select('id');
      if (updateError) throw new Error(updateError.message);
      if (!data?.length) throw new Error('This request has already been answered.');
      setRefreshKey((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update this request.');
    } finally {
      setBusyId('');
    }
  }

  function relationFor(personId: string) {
    return requests.find((request) =>
      (request.sender_id === currentUserId && request.recipient_id === personId) ||
      (request.sender_id === personId && request.recipient_id === currentUserId),
    );
  }

  function profileForRequest(request: FriendRequest) {
    const id = request.sender_id === currentUserId ? request.recipient_id : request.sender_id;
    return profiles.get(id) ?? { id, name: 'Tea Chat member', image: null };
  }

  function personCard(person: Person) {
    const relation = relationFor(person.id);
    const actionBusy = busyId === person.id;
    return (
      <article className="person-card" key={person.id} data-testid={`person-card-${person.id}`}>
        <div className="person-avatar">
          {person.image ? <img src={person.image} alt="" /> : <span>{person.name.slice(0, 1).toUpperCase() || 'T'}</span>}
        </div>
        <div className="person-details"><strong>{person.name}</strong><span>Tea Chat member</span></div>
        {relation?.status === 'accepted' ? (
          <button className="person-action secondary-action" type="button" onClick={() => onStartChat(person)} data-testid={`button-message-${person.id}`}><MessageCircle size={14} />Message</button>
        ) : relation?.status === 'pending' && relation.sender_id === currentUserId ? (
          <span className="person-status">Request sent</span>
        ) : relation?.status === 'pending' ? (
          <button className="person-action secondary-action" type="button" onClick={() => { setTab('requests'); }} data-testid={`button-view-request-${person.id}`}>Respond</button>
        ) : (
          <button className="person-action primary-action" type="button" disabled={actionBusy} onClick={() => { void sendRequest(person); }} data-testid={`button-add-friend-${person.id}`}>
            <UserPlus size={14} />{actionBusy ? 'Sending…' : 'Add friend'}
          </button>
        )}
      </article>
    );
  }

  function requestCard(request: FriendRequest, received: boolean) {
    const person = profileForRequest(request);
    return (
      <article className="person-card" key={request.id} data-testid={`friend-request-${request.id}`}>
        <div className="person-avatar">
          {person.image ? <img src={person.image} alt="" /> : <span>{person.name.slice(0, 1).toUpperCase() || 'T'}</span>}
        </div>
        <div className="person-details"><strong>{person.name}</strong><span>{received ? 'Wants to connect' : 'Waiting for a reply'}</span></div>
        {received ? (
          <div className="request-actions">
            <button className="person-action primary-action" type="button" disabled={busyId === request.id} onClick={() => { void respondToRequest(request, 'accepted'); }} aria-label={`Accept ${person.name}'s friend request`} data-testid={`button-accept-request-${request.id}`}><Check size={14} />Accept</button>
            <button className="request-decline" type="button" disabled={busyId === request.id} onClick={() => { void respondToRequest(request, 'declined'); }} aria-label={`Decline ${person.name}'s friend request`} data-testid={`button-decline-request-${request.id}`}>Decline</button>
          </div>
        ) : <span className="person-status">Sent</span>}
      </article>
    );
  }

  return (
    <section className="people-panel" aria-label="People and friend requests" data-testid="panel-people">
      <div className="people-panel-heading">
        <div><span className="eyebrow">Tea Chat</span><h2>Find your people</h2></div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close people panel" data-testid="button-close-people"><X size={17} /></button>
      </div>
      <div className="people-tabs" role="tablist" aria-label="People sections">
        <button className={tab === 'discover' ? 'active' : ''} type="button" role="tab" aria-selected={tab === 'discover'} onClick={() => setTab('discover')} data-testid="tab-discover-people"><Search size={13} />Discover</button>
        <button className={tab === 'requests' ? 'active' : ''} type="button" role="tab" aria-selected={tab === 'requests'} onClick={() => setTab('requests')} data-testid="tab-friend-requests"><UserPlus size={13} />Requests{incoming.length > 0 && <span className="people-count">{incoming.length}</span>}</button>
        <button className={tab === 'friends' ? 'active' : ''} type="button" role="tab" aria-selected={tab === 'friends'} onClick={() => setTab('friends')} data-testid="tab-friends"><Users size={13} />Friends</button>
      </div>
      {tab === 'discover' && (
        <label className="people-search" htmlFor="people-search-input">
          <Search size={14} />
          <input id="people-search-input" type="search" placeholder="Search people by name" value={search} onChange={(event) => setSearch(event.target.value)} data-testid="input-search-people" />
        </label>
      )}
      <div className="people-content">
        {error && <p className="people-error" role="alert" data-testid="status-people-error">{error}</p>}
        {loading ? <p className="people-empty" role="status">Finding your people…</p> : tab === 'discover' ? (
          people.length ? <>
            <div className="people-list">{people.filter((person) => person.id !== currentUserId).map(personCard)}</div>
            {nextOffset !== null && <button className="load-more-people" type="button" onClick={() => { void loadMore(); }} disabled={loadingMore} data-testid="button-load-more-people">{loadingMore ? 'Loading…' : 'Show more people'}</button>}
          </> : <p className="people-empty">{search.trim() ? 'No members match that name yet.' : 'No other members have joined yet.'}</p>
        ) : tab === 'requests' ? (
          incoming.length || outgoing.length ? <div className="people-list">
            {incoming.length > 0 && <div className="people-subheading">Received</div>}
            {incoming.map((request) => requestCard(request, true))}
            {outgoing.length > 0 && <div className="people-subheading">Sent</div>}
            {outgoing.map((request) => requestCard(request, false))}
          </div> : <p className="people-empty">No friend requests right now.</p>
        ) : friends.length ? (
          <div className="people-list">{friends.map((request) => {
            const person = profileForRequest(request);
            return (
              <article className="person-card" key={request.id} data-testid={`friend-card-${request.id}`}>
                <div className="person-avatar">{person.image ? <img src={person.image} alt="" /> : <span>{person.name.slice(0, 1).toUpperCase() || 'T'}</span>}</div>
                <div className="person-details"><strong>{person.name}</strong><span>Tea Chat friend</span></div>
                <button className="person-action primary-action" type="button" onClick={() => onStartChat(person)} data-testid={`button-message-friend-${request.id}`}><MessageCircle size={14} />Message</button>
              </article>
            );
          })}</div>
        ) : <p className="people-empty">Your accepted connections will show up here.</p>}
      </div>
    </section>
  );
}
