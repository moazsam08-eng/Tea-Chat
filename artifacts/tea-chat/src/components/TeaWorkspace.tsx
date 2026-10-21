import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { StreamChat, type Attachment as StreamAttachment, type Channel as StreamChannel } from 'stream-chat';
import type { StreamToken } from '@workspace/api-client-react';
import {
  Channel,
  ChannelHeader,
  Chat,
  MessageInput,
  MessageList,
  Thread,
  Window,
  useChannelStateContext,
} from 'stream-chat-react';
import 'stream-chat-react/dist/css/v2/index.css';
import { encodeToMp3 } from 'stream-chat-react/mp3-encoder';
import {
  ArrowLeft,
  CircleAlert,
  Leaf,
  LogOut,
  MessageCirclePlus,
  Moon,
  Phone,
  Search,
  Sun,
  UserRound,
  Video,
} from 'lucide-react';
import type { Call, StreamVideoClient } from '@stream-io/video-react-sdk';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { PeoplePanel, type Person } from '@/components/PeoplePanel';
import { CallHistoryActionsContext, TeaChatAttachment } from '@/components/TeaChatAttachment';
import { useAudioCall } from '@/hooks/useAudioCall';
import { toast } from '@/hooks/use-toast';
import { ProfileSettingsModal } from '@/components/ProfileSettingsModal';
import { useTheme } from '@/components/ThemeContext';

const VideoCallModal = lazy(() => import('./VideoCallModal'));
const AudioCallModal = lazy(() => import('./AudioCallModal'));

type WorkspaceProps = {
  user: User;
  streamToken: StreamToken;
  supabase: SupabaseClient;
  onSignOut: () => void;
};

async function addCallHistoryEntry(channel: StreamChannel, mode: 'audio' | 'video', callId?: string) {
  const title = mode === 'audio' ? 'Voice call' : 'Video call';
  try {
    await channel.sendMessage({
      text: '',
      silent: true,
      attachments: [{
        type: 'tea_call_log',
        title,
        tea_call_mode: mode,
        ...(callId ? { tea_call_id: callId } : {}),
      } as StreamAttachment],
    });
  } catch (error) {
    toast({
      title: 'Call history could not be saved',
      description: error instanceof Error ? error.message : 'The call can still continue.',
      variant: 'destructive',
    });
  }
}

function getConversationTitle(channel: StreamChannel, currentUserId: string) {
  const customName = (channel.data as Record<string, unknown> | undefined)?.name;
  if (typeof customName === 'string' && customName.trim()) return customName.trim();
  const names = Object.values(channel.state.members)
    .filter((member) => member.user_id !== currentUserId)
    .map((member) => {
      const name = member.user?.name;
      return typeof name === 'string' && name.trim() ? name.trim() : 'Tea Chat member';
    });
  return names.length ? names.join(', ') : 'Conversation';
}

function getConversationImage(channel: StreamChannel, currentUserId: string) {
  const otherMember = Object.values(channel.state.members).find((member) => member.user_id !== currentUserId);
  return typeof otherMember?.user?.image === 'string' ? otherMember.user.image : null;
}

function getConversationPreview(channel: StreamChannel) {
  const latestMessage = channel.state.messages.at(-1);
  if (typeof latestMessage?.text === 'string' && latestMessage.text.trim()) return latestMessage.text.trim();
  if (latestMessage?.attachments?.length) return 'Sent an attachment';
  return 'Start a conversation';
}

export function TeaWorkspace({ user, streamToken, supabase, onSignOut }: WorkspaceProps) {
  const apiKey = import.meta.env.VITE_STREAM_API_KEY as string | undefined;
  const { theme, toggleTheme } = useTheme();
  const metadataName = user.user_metadata?.full_name;
  const initialName =
    typeof metadataName === 'string' && metadataName.trim()
      ? metadataName.trim()
      : user.email || streamToken.name;
  const [client, setClient] = useState<StreamChat | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [search, setSearch] = useState('');
  const [conversations, setConversations] = useState<StreamChannel[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationsError, setConversationsError] = useState('');
  const [activeChannel, setActiveChannel] = useState<StreamChannel | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileName, setProfileName] = useState(initialName);
  const [profileImage, setProfileImage] = useState<string | null>(streamToken.image);
  const [working, setWorking] = useState(false);
  const [call, setCall] = useState<Call | null>(null);
  const [videoClient, setVideoClient] = useState<StreamVideoClient | null>(null);
  const audioCall = useAudioCall({ supabase, userId: streamToken.userId, displayName: profileName, image: profileImage });

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

  const loadConversations = useCallback(async (showLoading = true) => {
    if (!client) return;
    if (showLoading) {
      setConversationsLoading(true);
      setConversationsError('');
    }
    try {
      const channels = await client.queryChannels(
        { type: 'messaging', members: { $in: [streamToken.userId] } },
        { last_message_at: -1 },
        { limit: 25, state: true, presence: true, watch: true, message_limit: 1 },
      );
      setConversations(channels);
      setConversationsError('');
    } catch (error: unknown) {
      setConversationsError(error instanceof Error ? error.message : 'Could not load your conversations. Please try again.');
    } finally {
      if (showLoading) setConversationsLoading(false);
    }
  }, [client, streamToken.userId]);

  useEffect(() => {
    if (!client) {
      setConversations([]);
      setConversationsLoading(false);
      return;
    }
    void loadConversations();
  }, [client, loadConversations]);

  useEffect(() => {
    if (!client) return;
    let refreshTimer: number | undefined;
    const refresh = () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => { void loadConversations(false); }, 200);
    };
    const subscriptions = [
      client.on('message.new', refresh),
      client.on('notification.message_new', refresh),
      client.on('notification.added_to_channel', refresh),
    ];
    return () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      subscriptions.forEach((subscription) => subscription.unsubscribe());
    };
  }, [client, loadConversations]);

  useEffect(() => () => {
    void videoClient?.disconnectUser().catch(() => undefined);
  }, [videoClient]);

  async function selectConversation(channel: StreamChannel) {
    try {
      await channel.watch();
      setActiveChannel(channel);
      setMobileOpen(true);
      setSearch('');
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : 'Could not open this conversation.');
    }
  }

  async function startChat(person: Person) {
    if (!client) return;
    setWorking(true);
    try {
      const channel = client.channel('messaging', { members: [streamToken.userId, person.id] });
      await channel.watch();
      setConversations((current) => [channel, ...current.filter((item) => item.cid !== channel.cid)]);
      setActiveChannel(channel);
      setMobileOpen(true);
      setPeopleOpen(false);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : 'Could not start this conversation.');
    } finally {
      setWorking(false);
    }
  }

  async function startCall(sourceChannel: StreamChannel | null, audioOnly = false) {
    if (!sourceChannel) return;
    if (audioOnly) {
      const members = Object.values(sourceChannel.state.members);
      const other = members.find((member) => member.user_id !== streamToken.userId);
      if (members.length !== 2 || !other?.user_id) {
        toast({ title: 'Audio calling is available only in one-to-one conversations.', variant: 'destructive' });
        return;
      }
      const peerUser = other.user;
      const peerName = typeof peerUser?.name === 'string' && peerUser.name.trim() ? peerUser.name.trim() : 'Tea Chat member';
      const peerImage = typeof peerUser?.image === 'string' ? peerUser.image : null;
      const callId = await audioCall.startCall({ id: other.user_id, name: peerName, image: peerImage });
      if (callId) await addCallHistoryEntry(sourceChannel, 'audio', callId);
      return;
    }
    if (!apiKey) return;
    setWorking(true);
    try {
      await addCallHistoryEntry(sourceChannel, 'video');
      let activeVideoClient = videoClient;
      if (!activeVideoClient) {
        const { createVideoClient } = await import('./VideoCallModal');
        activeVideoClient = await createVideoClient({
          apiKey,
          user: {
            id: streamToken.userId,
            name: profileName,
            image: profileImage ?? undefined,
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

  const displayName = profileName;
  const initials = displayName.slice(0, 1).toUpperCase() || 'T';
  const avatarUrl = profileImage;
  const callHistoryActions = audioCall.call?.phase === 'incoming'
    ? {
        callId: audioCall.call.callId,
        onAccept: () => { void audioCall.acceptCall(); },
        onDecline: audioCall.rejectCall,
      }
    : null;

  const visibleConversations = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return conversations;
    return conversations.filter((channel) =>
      getConversationTitle(channel, streamToken.userId).toLocaleLowerCase().includes(query) ||
      getConversationPreview(channel).toLocaleLowerCase().includes(query),
    );
  }, [conversations, search, streamToken.userId]);

  const chatFrame = (
    <section className={`chat-frame${mobileOpen ? ' mobile-channel-open' : ''}`} data-testid="chat-workspace">
      <aside className="chat-sidebar">
        <div className="sidebar-top">
          <div className="sidebar-brand-row">
            <div className="brand-mark" data-testid="brand-workspace"><span className="brand-glyph"><Leaf size={17} /></span><span>tea chat</span></div>
            <button className="icon-button" type="button" aria-label="Find people" title="Find people" onClick={() => setPeopleOpen((value) => !value)} data-testid="button-find-people"><MessageCirclePlus size={17} /></button>
          </div>
          {!peopleOpen && <label className="search-wrap" htmlFor="channel-search"><Search size={15} /><input id="channel-search" type="search" placeholder="Find a conversation" value={search} onChange={(event) => setSearch(event.target.value)} data-testid="input-channel-search" /></label>}
        </div>
        {peopleOpen && client ? (
          <PeoplePanel
            supabase={supabase}
            currentUserId={streamToken.userId}
            onClose={() => setPeopleOpen(false)}
            onStartChat={(person) => { void startChat(person); }}
          />
        ) : (
          <>
            <div className="sidebar-label">{search.trim() ? 'Matching conversations' : 'Your conversations'}</div>
            <div className="channel-list-shell" data-testid="list-conversations" aria-live="polite" aria-busy={!client || conversationsLoading}>
              {!client || conversationsLoading ? (
                <div style={{ padding: 18 }} role="status" aria-label="Loading conversations" data-testid="status-channel-loading"><div style={{ height: 52, borderRadius: 10, background: '#eeeee7', marginBottom: 8 }} /><div style={{ height: 52, borderRadius: 10, background: '#eeeee7', marginBottom: 8 }} /><div style={{ height: 52, borderRadius: 10, background: '#eeeee7' }} /></div>
              ) : conversationsError ? (
                <div className="conversation-list-error" role="alert" data-testid="status-conversations-error">{conversationsError}<button className="text-button" type="button" onClick={() => { void loadConversations(); }} data-testid="button-retry-conversations">Try again</button></div>
              ) : visibleConversations.length ? (
                <div className="conversation-list">
                  {visibleConversations.map((channel) => {
                    const title = getConversationTitle(channel, streamToken.userId);
                    const image = getConversationImage(channel, streamToken.userId);
                    const preview = getConversationPreview(channel);
                    const selected = activeChannel?.cid === channel.cid;
                    return (
                      <button key={channel.cid} className={'conversation-preview' + (selected ? ' is-active' : '')} type="button" onClick={() => { void selectConversation(channel); }} aria-pressed={selected} aria-label={'Open conversation with ' + title} data-testid="button-open-conversation">
                        <span className="conversation-preview-avatar">{image ? <img src={image} alt="" /> : <span>{title.slice(0, 1).toUpperCase() || 'T'}</span>}</span>
                        <span className="conversation-preview-copy"><strong className="conversation-preview-name">{title}</strong><span className="conversation-preview-message">{preview}</span></span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="conversation-list-empty" data-testid={search.trim() ? 'status-search-empty' : 'status-conversations-empty'}>{search.trim() ? 'No conversations match “' + search.trim() + '”.' : 'No conversations yet. Start one from Find people.'}</div>
              )}
            </div>
          </>
        )}
        <div className="sidebar-bottom">
          <div className="user-avatar" data-testid="avatar-current-user">{avatarUrl ? <img src={avatarUrl} alt="" /> : initials}</div>
          <div className="user-meta"><strong data-testid="text-current-user">{displayName}</strong><span>Here for a good chat</span></div>
          <button className="icon-button" type="button" onClick={() => setProfileOpen(true)} title="Edit profile" aria-label="Edit profile" data-testid="button-edit-profile"><UserRound size={16} /></button>
          <button className="icon-button theme-workspace-toggle" type="button" onClick={toggleTheme} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} aria-pressed={theme === 'dark'} data-testid="button-theme-toggle-workspace">{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
          <button className="icon-button" type="button" onClick={() => { void supabase.auth.signOut(); onSignOut(); }} title="Sign out" aria-label="Sign out" data-testid="button-sign-out"><LogOut size={16} /></button>
        </div>
      </aside>
      <section className="chat-main" data-testid="panel-chat">
        <button className="mobile-back" type="button" onClick={() => setMobileOpen(false)} aria-label="Back to conversations" data-testid="button-mobile-back"><ArrowLeft size={17} /></button>
        {connectionError && <div style={{ position: 'absolute', zIndex: 8, top: 12, left: 62, right: 12 }} className="auth-error" role="alert" data-testid="status-stream-error"><CircleAlert size={14} style={{ verticalAlign: 'middle', marginRight: 5 }} />{connectionError}{apiKey && <button type="button" onClick={() => { setConnectionError(''); setConnectionAttempt((attempt) => attempt + 1); }} className="text-button" style={{ marginLeft: 9 }} data-testid="button-retry-stream-connect">Try again</button>}</div>}
        {client ? (
          activeChannel
            ? <Channel channel={activeChannel} Attachment={TeaChatAttachment}><ConversationPanel disabled={working || !apiKey} onCall={(channel, audioOnly) => { void startCall(channel, audioOnly); }} /></Channel>
            : <Channel Attachment={TeaChatAttachment}><ConversationPanel disabled={working || !apiKey} onCall={(channel, audioOnly) => { void startCall(channel, audioOnly); }} /></Channel>
        ) : !connectionError && (
          <div className="chat-empty-state" data-testid="empty-chat-loading">
            <div className="empty-note"><div className="cup-illustration"><div className="loading-leaf" /></div><h2>Warming the teapot</h2><p>Connecting your conversations, just a moment.</p></div>
          </div>
        )}
        {!client && connectionError && !apiKey && <div className="chat-empty-state"><div className="empty-note"><div className="cup-illustration"><CircleAlert size={25} /></div><h2>One small setup step</h2><p>{connectionError}</p></div></div>}
      </section>
    </section>
  );

  return (
    <main className="tea-app app-frame" data-testid="screen-workspace">
      {client ? (
        <CallHistoryActionsContext.Provider value={callHistoryActions}>
          <Chat client={client} theme={theme === 'dark' ? 'str-chat__theme-dark' : 'str-chat__theme-light'}>{chatFrame}</Chat>
        </CallHistoryActionsContext.Provider>
      ) : chatFrame}
      {profileOpen && (
        <ProfileSettingsModal
          userId={streamToken.userId}
          name={profileName}
          image={profileImage}
          supabase={supabase}
          onClose={() => setProfileOpen(false)}
          onSaved={(profile) => { setProfileName(profile.name); setProfileImage(profile.image); }}
        />
      )}
      {audioCall.call && (
        <Suspense fallback={<div className="call-loading" role="status">Connecting your audio callÃ¢ÂÂ¦</div>}>
          <AudioCallModal
            call={audioCall.call}
            currentUserId={streamToken.userId}
            onAccept={() => { void audioCall.acceptCall(); }}
            onReject={audioCall.rejectCall}
            onEnd={audioCall.endCall}
            onToggleMute={audioCall.toggleMute}
            onToggleChat={audioCall.toggleChat}
            onSendMessage={audioCall.sendChatMessage}
          />
        </Suspense>
      )}
      {call && videoClient && (
        <Suspense fallback={<div className="call-loading" role="status">Connecting your callÃ¢ÂÂ¦</div>}>
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
  const audioRecordingConfig = useMemo(
    () => ({ transcoderConfig: { encoder: encodeToMp3 } }),
    [],
  );
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
      <MessageInput
        audioRecordingEnabled
        audioRecordingConfig={audioRecordingConfig}
        asyncMessagesMultiSendEnabled
      />
    </Window>
    <Thread />
  </>;
}
