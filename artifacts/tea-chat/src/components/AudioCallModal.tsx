import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Leaf,
  MessageCircle,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Send,
  X,
} from 'lucide-react';
import type { AudioCallSnapshot, AudioChatMessage } from '@/hooks/useAudioCall';
import './AudioCallModal.css';

type AudioCallModalProps = {
  call: AudioCallSnapshot;
  currentUserId: string;
  onAccept: () => void;
  onReject: () => void;
  onEnd: () => void;
  onToggleMute: () => void;
  onToggleChat: () => void;
  onSendMessage: (text: string) => Promise<boolean>;
};

function formatDuration(startedAt: number, now: number) {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function MessageBubble({
  message,
  own,
}: {
  message: AudioChatMessage;
  own: boolean;
}) {
  return (
    <li className={`audio-call-message${own ? ' own' : ''}`} data-testid={`audio-chat-message-${message.id}`}>
      <p>{message.text}</p>
      <time dateTime={new Date(message.createdAt).toISOString()}>
        {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </time>
    </li>
  );
}

export default function AudioCallModal({
  call,
  currentUserId,
  onAccept,
  onReject,
  onEnd,
  onToggleMute,
  onToggleChat,
  onSendMessage,
}: AudioCallModalProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const messageListRef = useRef<HTMLUListElement>(null);
  const [draft, setDraft] = useState('');
  const [now, setNow] = useState(Date.now());
  const initials = call.peer.name.trim().slice(0, 1).toUpperCase() || 'T';

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.srcObject = call.remoteStream;
    if (call.remoteStream) void audio.play().catch(() => undefined);
    return () => {
      audio.srcObject = null;
    };
  }, [call.remoteStream]);

  useEffect(() => {
    if (call.phase !== 'active' || call.startedAt === null) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [call.phase, call.startedAt]);

  useEffect(() => {
    const list = messageListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [call.messages, call.chatOpen]);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const sent = await onSendMessage(draft);
    if (sent) setDraft('');
  }

  const isIncoming = call.phase === 'incoming';
  const isCalling = call.phase === 'calling';
  const isConnecting = call.phase === 'connecting';
  const isActive = call.phase === 'active';
  const status = isIncoming
    ? 'Incoming audio call'
    : isCalling
      ? 'Calling…'
      : isConnecting
        ? 'Connecting…'
        : 'Connected';

  return (
    <div className="audio-call-overlay" data-testid="dialog-audio-call">
      <section
        className={`audio-call-panel${call.chatOpen && isActive ? ' with-chat' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="audio-call-title"
      >
        <audio ref={audioRef} autoPlay playsInline aria-label={`Audio from ${call.peer.name}`} />
        <header className="audio-call-header">
          <div className="audio-call-brand"><span><Leaf size={16} /></span>tea chat</div>
          <button
            className="audio-call-dismiss"
            type="button"
            onClick={isIncoming ? onReject : onEnd}
            aria-label={isIncoming ? 'Reject incoming call' : 'End call'}
            data-testid="button-dismiss-audio-call"
          >
            <X size={17} />
          </button>
        </header>

        <div className="audio-call-layout">
          <main className="audio-call-main">
            <div className="audio-call-person">
              <div className={`audio-call-avatar${isActive ? ' connected' : ''}`}>
                {call.peer.image
                  ? <img src={call.peer.image} alt="" />
                  : <span>{initials}</span>}
              </div>
              <span className={`audio-call-status${isActive ? ' connected' : ''}`} role="status">
                <span className="audio-call-status-dot" />
                {status}
              </span>
              <h2 id="audio-call-title">{call.peer.name}</h2>
              {isActive && call.startedAt !== null && (
                <p className="audio-call-duration" data-testid="text-call-duration">
                  {formatDuration(call.startedAt, now)}
                </p>
              )}
              {!isActive && (
                <p className="audio-call-caption">
                  {isIncoming
                    ? 'Pick up when you’re ready.'
                    : isCalling
                      ? 'Your call is ringing through.'
                      : 'Setting up a private audio connection.'}
                </p>
              )}
            </div>

            {isIncoming ? (
              <div className="audio-call-actions incoming">
                <button
                  className="audio-call-control accept"
                  type="button"
                  onClick={onAccept}
                  aria-label="Accept call"
                  data-testid="button-accept-audio-call"
                >
                  <Phone size={19} />
                  <span>Accept</span>
                </button>
                <button
                  className="audio-call-control end"
                  type="button"
                  onClick={onReject}
                  aria-label="Reject call"
                  data-testid="button-reject-audio-call"
                >
                  <PhoneOff size={19} />
                  <span>Reject</span>
                </button>
              </div>
            ) : isCalling || isConnecting ? (
              <div className="audio-call-actions">
                <button
                  className="audio-call-control end"
                  type="button"
                  onClick={onEnd}
                  aria-label="Cancel call"
                  data-testid="button-cancel-audio-call"
                >
                  <PhoneOff size={19} />
                  <span>{isCalling ? 'Cancel call' : 'End call'}</span>
                </button>
              </div>
            ) : (
              <div className="audio-call-actions active">
                <button
                  className={`audio-call-control${call.muted ? ' muted' : ''}`}
                  type="button"
                  onClick={onToggleMute}
                  aria-label={call.muted ? 'Unmute microphone' : 'Mute microphone'}
                  aria-pressed={call.muted}
                  data-testid="button-toggle-audio-mute"
                >
                  {call.muted ? <MicOff size={19} /> : <Mic size={19} />}
                  <span>{call.muted ? 'Unmute' : 'Mute'}</span>
                </button>
                <button
                  className={`audio-call-control${call.chatOpen ? ' selected' : ''}`}
                  type="button"
                  onClick={onToggleChat}
                  aria-label={call.chatOpen ? 'Close in-call chat' : 'Open in-call chat'}
                  aria-pressed={call.chatOpen}
                  data-testid="button-toggle-in-call-chat"
                >
                  <MessageCircle size={19} />
                  <span>Chat</span>
                </button>
                <button
                  className="audio-call-control end"
                  type="button"
                  onClick={onEnd}
                  aria-label="End call"
                  data-testid="button-end-audio-call"
                >
                  <PhoneOff size={19} />
                  <span>End</span>
                </button>
              </div>
            )}
            <p className="audio-call-privacy">
              Audio is peer-to-peer. In-call messages disappear when the call ends.
            </p>
          </main>

          {call.chatOpen && isActive && (
            <aside className="audio-call-chat" aria-label="In-call text chat" data-testid="panel-in-call-chat">
              <div className="audio-call-chat-heading">
                <div><strong>In-call chat</strong><span>Only for this call</span></div>
                <button type="button" onClick={onToggleChat} aria-label="Close in-call chat">
                  <X size={16} />
                </button>
              </div>
              <ul className="audio-call-messages" ref={messageListRef} aria-live="polite" aria-relevant="additions">
                {call.messages.length ? call.messages.map((message) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    own={message.fromUserId === currentUserId}
                  />
                )) : (
                  <li className="audio-call-chat-empty">Messages here are temporary and never enter your conversations.</li>
                )}
              </ul>
              <form className="audio-call-chat-form" onSubmit={(event) => { void sendMessage(event); }}>
                <input
                  type="text"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  maxLength={2_000}
                  placeholder="Write a message…"
                  aria-label="In-call message"
                  data-testid="input-in-call-message"
                />
                <button type="submit" disabled={!draft.trim()} aria-label="Send in-call message" data-testid="button-send-in-call-message">
                  <Send size={16} />
                </button>
              </form>
            </aside>
          )}
        </div>
      </section>
    </div>
  );
}
