import { lazy, Suspense, type FormEvent, useEffect, useMemo, useState } from 'react';
import { StreamChat, type Channel as StreamChannel } from 'stream-chat';
import type { StreamToken } from '@workspace/api-client-react';
import {
  Channel,
  ChannelHeader,
  ChannelList,
  Chat,
  MessageInput,
  MessageList,
  Thread,
  Window,
  useChannelStateContext,
} from 'stream-chat-react';
import 'stream-chat-react/dist/css/v2/index.css';
import {
  ArrowLeft,
  Check,
  CircleAlert,
  Copy,
  Leaf,
  LogOut,
  MessageCirclePlus,
  Phone,
  Search,
  Video,
} from 'lucide-react';
import type { Call, StreamVideoClient } from '@stream-io/video-react-sdk';
import type { SupabaseClient, User } from '@supabase/supabase-js';

const VideoCallModal = lazy(() => import('./VideoCallModal'));

type WorkspaceProps = {
  user: User;
  streamToken: StreamToken;
  supabase: SupabaseClient;
  onSignOut: () => void;
};

export function TeaWorkspace({ user, streamToken, supabase, onSignOut }: WorkspaceProps) {
  const apiKey = import.meta.env.VITE_STREAM_API_KEY as string | undefined;
  const [client, setClient] = useState<StreamChat | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<StreamChannel[]>([]);
  const [activeChannel, setActiveChannel] = useState<StreamChannel | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newMemberId, setNewMemberId] = useState('');
  const [newChatError, setNewChatError] = useState('');
  const [working, setWorking] = useState(false);
  const [call, setCall] = useState<Call | null>(null);
  const [videoClient, setVideoClient] = useState<StreamVideoClient | null>(null);
  const [idCopied, setIdCopied] = useState(false);

  useEffect(() => {
    if (!apiKey) {
      setConnectionError('The chat service is not configured. Add VITE_STREAM_API_KEY to the frontend environment.');
      return;
    }
    let cancelled = false;
    const stream = StreamChat.getInstance(apiKey);
    setConnectionError('');
    void stream.connectUser(
      {
        id: streamToken.userId,
        name: streamToken.name,
        image: streamToken.image ?? undefined,
      },
      streamToken.token,
    ).then(() => {
      if (!cancelled) setClient(stream);
    }).catch((error: unknown) => {
      if (!cancelled) setConnectionError(error instanceof Error ? error.message : 'Could not connect to the chat service.');
    });
    return () => {
      cancelled = true;
      setClient(null);
      void stream.disconnectUser();
    };
  }, [apiKey, streamToken, connectionAttempt]);

  useEffect(() => {
    if (!client || !search.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void client.queryChannels(
        { type: 'messaging', members: { $in: [streamToken.userId] }, name: { $autocomplete: search.trim() } },
        { last_message_at: -1 },
        { limit: 15, state: true, watch: false },
      ).then((channels) => {
        if (!cancelled) setResults(channels);
      }).catch((error: unknown) => {
        if (!cancelled) setConnectionError(error instanceof Error ? error.message : 'Channel search is unavailable.');
      });
    }, 240);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [client, search, streamToken.userId]);

  useEffect(() => () => {
    void videoClient?.disconnectUser().catch(() => undefined);
  }, [videoClient]);

  async function selectSearchResult(channel: StreamChannel) {
    await channel.watch();
    setActiveChannel(channel);
    setMobileOpen(true);
  }

  async function startChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || !newMemberId.trim()) return;
    setWorking(true);
    setNewChatError('');
    try {
      const channel = client.channel('messaging', { members: [streamToken.userId, newMemberId.trim()] });
      await channel.watch();
      setActiveChannel(channel);
      setMobileOpen(true);
      setNewChatOpen(false);
      setNewMemberId('');
    } catch (error) {
      setNewChatError(error instanceof Error ? error.message : 'Could not start this conversation.');
    } finally {
      setWorking(false);
    }
  }

  async function startCall(sourceChannel: StreamChannel | null, audioOnly = false) {
    if (!apiKey || !sourceChannel) return;
    setWorking(true);
    try {
      let activeVideoClient = videoClient;
      if (!activeVideoClient) {
        const { createVideoClient } = await import('./VideoCallModal');
        activeVideoClient = await createVideoClient({
          apiKey,
          user: {
            id: streamToken.userId,
            name: streamToken.name,
            image: streamToken.image ?? undefined,
          },
          token: streamToken.token,
        });
        setVideoClient(activeVideoClient);
      }
      const callId = sourceChannel.id ?? sourceChannel.cid.replace(/[^a-zA-Z0-9_-]/g, '-');
      const nextCall = activeVideoClient.call('default', callId);
      await nextCall.getOrCreate();
      await nextCall.join({ create: true });
      if (audioOnly) await nextCall.camera.disable();
      setCall(nextCall);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : 'Could not start a call.');
    } finally {
      setWorking(false);
    }
  }

  const filters = useMemo(() => ({ type: 'messaging', members: { $in: [streamToken.userId] } }), [streamToken.userId]);
  const sort = useMemo(() => ({ last_message_at: -1 as const }), []);
  const options = useMemo(() => ({ state: true, presence: true, limit: 25 }), []);
  const metadataName = user.user_metadata?.full_name;
  const displayName =
    typeof metadataName === 'string' && metadataName.trim()
      ? metadataName.trim()
      : user.email || streamToken.name;
  const initials = displayName.slice(0, 1).toUpperCase() || 'T';
  const avatarUrl = streamToken.image;

  async function copyUserId() {
    try {
      await navigator.clipboard.writeText(streamToken.userId);
      setIdCopied(true);
    } catch {
      setIdCopied(false);
    }
  }

  return (
    <main className="tea-app app-frame" data-testid="screen-workspace">
      <section className={`chat-frame${mobileOpen ? ' mobile-channel-open' : ''}`} data-testid="chat-workspace">
        <aside className="chat-sidebar">
          <div className="sidebar-top">
            <div className="sidebar-brand-row">
              <div className="brand-mark" data-testid="brand-workspace"><span className="brand-glyph"><Leaf size={17} /></span><span>tea chat</span></div>
              <button className="icon-button" type="button" aria-label="Start a conversation" title="Start a conversation" onClick={() => { setNewChatOpen((value) => !value); setNewChatError(''); }} data-testid="button-new-chat"><MessageCirclePlus size={17} /></button>
            </div>
            <label className="search-wrap" htmlFor="channel-search"><Search size={15} /><input id="channel-search" type="search" placeholder="Find a conversation" value={search} onChange={(event) => setSearch(event.target.value)} data-testid="input-channel-search" /></label>
          </div>
          {newChatOpen && (
            <form onSubmit={startChat} style={{ margin: '0 16px 9px', padding: 13, background: '#f0f0e8', borderRadius: 10 }} data-testid="form-new-chat">
              <p className="new-chat-hint">Ask them to copy their Tea Chat ID from the lower-left of their app.</p>
              <label className="field-label" htmlFor="member-id">Their Tea Chat user ID</label>
              <div style={{ display: 'flex', gap: 7 }}>
                <input id="member-id" className="tea-input" style={{ height: 38, fontSize: 12 }} value={newMemberId} onChange={(event) => setNewMemberId(event.target.value)} placeholder="Paste Tea Chat ID" required data-testid="input-new-chat-user-id" />
                <button className="icon-button" type="submit" disabled={working || !client} aria-label="Create conversation" data-testid="button-create-chat"><ArrowLeft size={17} style={{ transform: 'rotate(180deg)' }} /></button>
              </div>
              {newChatError && <p className="auth-error" role="alert" style={{ margin: '9px 0 0' }} data-testid="status-new-chat-error">{newChatError}</p>}
            </form>
          )}
          <div className="sidebar-label">{search.trim() ? 'Matching conversations' : 'Your conversations'}</div>
          <div className="channel-list-shell" onClick={() => { setMobileOpen(true); if (!search.trim()) setActiveChannel(null); }} data-testid="list-conversations">
            {search.trim() ? (
              results.length ? results.map((channel) => {
                const channelName = (channel.data as Record<string, unknown> | undefined)?.name;
                const title = (typeof channelName === 'string' && channelName.trim() ? channelName.trim() : '') || Object.values(channel.state.members).filter((member) => member.user_id !== streamToken.userId).map((member) => member.user?.name || member.user_id).join(', ') || 'Conversation';
                return <button key={channel.cid} type="button" onClick={() => { void selectSearchResult(channel); }} style={{ width: 'calc(100% - 18px)', margin: '2px 9px', border: 0, borderRadius: 10, background: activeChannel?.cid === channel.cid ? '#e8eee5' : 'transparent', padding: '12px', textAlign: 'left', color: 'var(--ink)' }} data-testid={`button-search-channel-${channel.id}`}><strong style={{ display: 'block', fontSize: 13 }}>{title}</strong><span style={{ color: '#828c83', fontSize: 11 }}>{channel.state.messages.at(-1)?.text || 'Open conversation'}</span></button>;
              }) : <div style={{ padding: '14px 20px', color: '#879188', fontSize: 12 }} data-testid="status-search-empty">{client ? 'No matching conversations.' : 'Connecting to your conversations…'}</div>
            ) : client ? <ChannelList filters={filters} sort={sort} options={options} /> : (
              <div style={{ padding: 18 }} aria-label="Loading conversations" data-testid="status-channel-loading"><div style={{ height: 52, borderRadius: 10, background: '#eeeee7', marginBottom: 8 }} /><div style={{ height: 52, borderRadius: 10, background: '#eeeee7', marginBottom: 8 }} /><div style={{ height: 52, borderRadius: 10, background: '#eeeee7' }} /></div>
            )}
          </div>
          <div className="sidebar-bottom">
            <div className="user-avatar" data-testid="avatar-current-user">{avatarUrl ? <img src={avatarUrl} alt="" /> : initials}</div>
            <div className="user-meta"><strong data-testid="text-current-user">{displayName}</strong><span>Here for a good chat</span></div>
            <button className="copy-id-button" type="button" onClick={() => { void copyUserId(); }} title={idCopied ? 'Tea Chat ID copied' : 'Copy your Tea Chat ID'} aria-label={idCopied ? 'Tea Chat ID copied' : 'Copy your Tea Chat ID'} data-testid="button-copy-user-id">{idCopied ? <Check size={14} /> : <Copy size={14} />}<span>{idCopied ? 'Copied' : 'Copy ID'}</span></button>
            <button className="icon-button" type="button" onClick={() => { void supabase.auth.signOut(); onSignOut(); }} title="Sign out" aria-label="Sign out" data-testid="button-sign-out"><LogOut size={16} /></button>
          </div>
        </aside>
        <section className="chat-main" data-testid="panel-chat">
          <button className="mobile-back" type="button" onClick={() => setMobileOpen(false)} aria-label="Back to conversations" data-testid="button-mobile-back"><ArrowLeft size={17} /></button>
          {connectionError && <div style={{ position: 'absolute', zIndex: 8, top: 12, left: 62, right: 12 }} className="auth-error" role="alert" data-testid="status-stream-error"><CircleAlert size={14} style={{ verticalAlign: 'middle', marginRight: 5 }} />{connectionError}{apiKey && <button type="button" onClick={() => { setConnectionError(''); setConnectionAttempt((attempt) => attempt + 1); }} className="text-button" style={{ marginLeft: 9 }} data-testid="button-retry-stream-connect">Try again</button>}</div>}
          {client ? (
            <Chat client={client} theme="str-chat__theme-light">
              {activeChannel
                ? <Channel channel={activeChannel}><ConversationPanel disabled={working || !apiKey} onCall={(channel, audioOnly) => { void startCall(channel, audioOnly); }} /></Channel>
                : <Channel><ConversationPanel disabled={working || !apiKey} onCall={(channel, audioOnly) => { void startCall(channel, audioOnly); }} /></Channel>}
            </Chat>
          ) : !connectionError && (
            <div className="chat-empty-state" data-testid="empty-chat-loading">
              <div className="empty-note"><div className="cup-illustration"><div className="loading-leaf" /></div><h2>Warming the teapot</h2><p>Connecting your conversations, just a moment.</p></div>
            </div>
          )}
          {!client && connectionError && !apiKey && <div className="chat-empty-state"><div className="empty-note"><div className="cup-illustration"><CircleAlert size={25} /></div><h2>One small setup step</h2><p>{connectionError}</p></div></div>}
        </section>
      </section>
      {call && videoClient && (
        <Suspense fallback={<div className="call-loading" role="status">Connecting your call…</div>}>
          <VideoCallModal
            call={call}
            client={videoClient}
            onLeave={() => { void call.leave(); setCall(null); }}
          />
        </Suspense>
      )}
    </main>
  );
}

function ChannelTools({ disabled, onCall }: { disabled: boolean; onCall: (channel: StreamChannel, audioOnly: boolean) => void }) {
  const { channel } = useChannelStateContext();
  return <>
    <button className="icon-button" type="button" disabled={disabled || !channel} onClick={() => { if (channel) onCall(channel, false); }} aria-label="Start a video call" title="Start a video call" data-testid="button-video-call"><Video size={17} /></button>
    <button className="icon-button" type="button" disabled={disabled || !channel} onClick={() => { if (channel) onCall(channel, true); }} aria-label="Start an audio call" title="Start an audio call" data-testid="button-audio-call"><Phone size={16} /></button>
  </>;
}

function ConversationPanel({ disabled, onCall }: { disabled: boolean; onCall: (channel: StreamChannel, audioOnly: boolean) => void }) {
  const { channel } = useChannelStateContext();
  if (!channel) return (
    <div className="chat-empty-state" data-testid="empty-chat-selection">
      <div className="empty-note"><div className="cup-illustration"><Leaf size={27} strokeWidth={1.5} /></div><span className="eyebrow">A moment for yourself</span><h2>Pick up the conversation.</h2><p>Choose a chat from the list or start a new one. Your messages will be right here.</p></div>
    </div>
  );
  return <>
    <Window>
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid #e8e5db', paddingRight: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}><ChannelHeader /></div>
        <ChannelTools disabled={disabled} onCall={onCall} />
      </div>
      <MessageList />
      <MessageInput />
    </Window>
    <Thread />
  </>;
}
