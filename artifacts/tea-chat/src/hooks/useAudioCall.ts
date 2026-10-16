import { useEffect, useRef, useState } from 'react';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { useToast } from '@/hooks/use-toast';

const INBOX_TOPIC_PREFIX = 'tea-audio:v1:inbox:';
const SIGNAL_EVENT = 'signal';
const CALL_RING_TIMEOUT_MS = 45_000;
const CALL_CONNECT_TIMEOUT_MS = 30_000;
const MAX_CHAT_MESSAGES = 100;
const MAX_CHAT_MESSAGE_LENGTH = 2_000;

export type AudioCallPeer = {
  id: string;
  name: string;
  image?: string | null;
};

export type AudioChatMessage = {
  id: string;
  fromUserId: string;
  text: string;
  createdAt: number;
};

export type AudioCallPhase = 'incoming' | 'calling' | 'connecting' | 'active';

export type AudioCallSnapshot = {
  callId: string;
  phase: AudioCallPhase;
  peer: AudioCallPeer;
  muted: boolean;
  chatOpen: boolean;
  messages: AudioChatMessage[];
  remoteStream: MediaStream | null;
  startedAt: number | null;
};

type SignalType =
  | 'invite'
  | 'accept'
  | 'reject'
  | 'busy'
  | 'cancel'
  | 'hangup'
  | 'candidate'
  | 'chat';

type AudioSignal = {
  type: SignalType;
  callId: string;
  fromUserId: string;
  toUserId: string;
  sentAt: number;
  peer?: AudioCallPeer;
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  message?: AudioChatMessage;
  reason?: 'declined' | 'no-answer' | 'microphone' | 'unavailable';
};

type CallRole = 'caller' | 'callee';

type AudioSession = {
  callId: string;
  peer: AudioCallPeer;
  role: CallRole;
  phase: AudioCallPhase;
  offer: RTCSessionDescriptionInit | null;
  pc: RTCPeerConnection | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  startedAt: number | null;
  muted: boolean;
  timeoutId: number | null;
  pendingRemoteCandidates: RTCIceCandidateInit[];
  pendingLocalCandidates: RTCIceCandidateInit[];
  localCandidatesReady: boolean;
  flushingLocalCandidates: boolean;
};

type UseAudioCallOptions = {
  supabase: SupabaseClient;
  userId: string;
  displayName: string;
  image: string | null;
};

function inboxTopic(userId: string) {
  return `${INBOX_TOPIC_PREFIX}${userId}`;
}

function newId() {
  return crypto.randomUUID();
}

function normalizeName(value: unknown) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, 80)
    : 'Tea Chat member';
}

function normalizeImage(value: unknown): string | null {
  return typeof value === 'string' && /^https:\/\//i.test(value)
    ? value.slice(0, 2_048)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDescription(value: unknown): value is RTCSessionDescriptionInit {
  return isRecord(value)
    && (value.type === 'offer' || value.type === 'answer')
    && typeof value.sdp === 'string';
}

function isCandidate(value: unknown): value is RTCIceCandidateInit {
  return isRecord(value) && typeof value.candidate === 'string';
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function signalFromBroadcast(value: unknown): unknown {
  if (!isRecord(value)) return null;
  return 'payload' in value ? value.payload : value;
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

export function useAudioCall({ supabase, userId, displayName, image }: UseAudioCallOptions) {
  const [call, setCall] = useState<AudioCallSnapshot | null>(null);
  const { toast: showToast } = useToast();
  const sessionRef = useRef<AudioSession | null>(null);
  const mountedRef = useRef(false);
  const inboxRef = useRef<RealtimeChannel | null>(null);
  const inboxReadyRef = useRef(false);
  const outboundChannelsRef = useRef(new Map<string, Promise<RealtimeChannel>>());
  const sendQueuesRef = useRef(new Map<string, Promise<void>>());
  const userInfoRef = useRef({ userId, displayName, image });
  const signalHandlerRef = useRef<(value: unknown) => void>(() => undefined);
  const sendToUserRef = useRef<(recipientId: string, signal: AudioSignal) => Promise<void>>(
    async () => { throw new Error('Call signaling is not ready.'); },
  );

  userInfoRef.current = { userId, displayName, image };

  function notify(message: string, destructive = false) {
    showToast({
      title: message,
      ...(destructive ? { variant: 'destructive' as const } : {}),
    });
  }

  function isCurrent(session: AudioSession) {
    return sessionRef.current === session;
  }

  function updateSnapshot(session: AudioSession, update: Partial<AudioCallSnapshot>) {
    if (!mountedRef.current || !isCurrent(session)) return;
    setCall((current) => current?.callId === session.callId
      ? { ...current, ...update }
      : current);
  }

  function publishSession(session: AudioSession) {
    if (!mountedRef.current || !isCurrent(session)) return;
    setCall({
      callId: session.callId,
      phase: session.phase,
      peer: session.peer,
      muted: session.muted,
      chatOpen: false,
      messages: [],
      remoteStream: session.remoteStream,
      startedAt: session.startedAt,
    });
  }

  function createSession(
    callId: string,
    peer: AudioCallPeer,
    role: CallRole,
    phase: AudioCallPhase,
    offer: RTCSessionDescriptionInit | null = null,
  ): AudioSession {
    return {
      callId,
      peer,
      role,
      phase,
      offer,
      pc: null,
      localStream: null,
      remoteStream: null,
      startedAt: null,
      muted: false,
      timeoutId: null,
      pendingRemoteCandidates: [],
      pendingLocalCandidates: [],
      localCandidatesReady: false,
      flushingLocalCandidates: false,
    };
  }

  function makeSignal(
    session: AudioSession,
    type: SignalType,
    details: Partial<AudioSignal> = {},
  ): AudioSignal {
    return {
      type,
      callId: session.callId,
      fromUserId: userInfoRef.current.userId,
      toUserId: session.peer.id,
      sentAt: Date.now(),
      ...details,
    };
  }

  function removeOutboundChannel(recipientId: string) {
    const queue = sendQueuesRef.current.get(recipientId);
    const remove = () => {
      const channelPromise = outboundChannelsRef.current.get(recipientId);
      if (channelPromise) {
        void channelPromise
          .then((channel) => supabase.removeChannel(channel))
          .catch(() => undefined);
      }
      outboundChannelsRef.current.delete(recipientId);
      sendQueuesRef.current.delete(recipientId);
    };
    if (queue) void queue.finally(remove);
    else remove();
  }

  function clearTimeoutFor(session: AudioSession) {
    if (session.timeoutId !== null) {
      window.clearTimeout(session.timeoutId);
      session.timeoutId = null;
    }
  }

  function terminateSession(
    session: AudioSession,
    options: {
      notify?: { type: 'reject' | 'cancel' | 'hangup'; reason?: AudioSignal['reason'] };
      toastMessage?: string;
    } = {},
  ) {
    if (!isCurrent(session)) return;
    sessionRef.current = null;
    clearTimeoutFor(session);

    if (session.pc) {
      session.pc.onicecandidate = null;
      session.pc.ontrack = null;
      session.pc.onconnectionstatechange = null;
      session.pc.oniceconnectionstatechange = null;
      session.pc.close();
      session.pc = null;
    }

    stopStream(session.localStream);
    session.localStream = null;
    session.remoteStream = null;
    session.pendingLocalCandidates = [];
    session.pendingRemoteCandidates = [];

    if (mountedRef.current) setCall(null);
    if (options.toastMessage) notify(options.toastMessage);

    if (options.notify) {
      const notification: AudioSignal = {
        type: options.notify.type,
        callId: session.callId,
        fromUserId: userInfoRef.current.userId,
        toUserId: session.peer.id,
        sentAt: Date.now(),
        ...(options.notify.reason ? { reason: options.notify.reason } : {}),
      };
      void sendToUserRef.current(session.peer.id, notification)
        .catch(() => undefined)
        .finally(() => removeOutboundChannel(session.peer.id));
    } else {
      removeOutboundChannel(session.peer.id);
    }
  }

  function armTimeout(
    session: AudioSession,
    delayMs: number,
    message: string,
    notify: { type: 'reject' | 'cancel' | 'hangup'; reason?: AudioSignal['reason'] },
  ) {
    clearTimeoutFor(session);
    session.timeoutId = window.setTimeout(() => {
      if (!isCurrent(session)) return;
      terminateSession(session, { notify, toastMessage: message });
    }, delayMs);
  }

  function appendMessage(session: AudioSession, message: AudioChatMessage) {
    if (!isCurrent(session)) return;
    setCall((current) => {
      if (!current || current.callId !== session.callId) return current;
      if (current.messages.some((existing) => existing.id === message.id)) return current;
      return {
        ...current,
        messages: [...current.messages.slice(-(MAX_CHAT_MESSAGES - 1)), message],
      };
    });
  }

  async function getOutboundChannel(recipientId: string): Promise<RealtimeChannel> {
    const existing = outboundChannelsRef.current.get(recipientId);
    if (existing) return existing;

    const channel = supabase.channel(inboxTopic(recipientId), {
      config: {
        private: true,
        broadcast: { ack: true, self: false },
      },
    });
    const pending = new Promise<RealtimeChannel>((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Could not connect to call signaling. Check the Supabase Realtime setup.'));
      }, 12_000);

      channel.subscribe((status, error) => {
        if (status === 'SUBSCRIBED' && !settled) {
          settled = true;
          window.clearTimeout(timeout);
          resolve(channel);
        } else if (
          (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')
          && !settled
        ) {
          settled = true;
          window.clearTimeout(timeout);
          reject(error instanceof Error
            ? error
            : new Error('Could not connect to call signaling. Check the Supabase Realtime setup.'));
        }
      });
    });

    let guarded: Promise<RealtimeChannel>;
    guarded = pending.catch((error: unknown) => {
      if (outboundChannelsRef.current.get(recipientId) === guarded) {
        outboundChannelsRef.current.delete(recipientId);
      }
      void supabase.removeChannel(channel);
      throw error;
    });
    outboundChannelsRef.current.set(recipientId, guarded);
    return guarded;
  }

  async function sendToUser(recipientId: string, signal: AudioSignal) {
    const previous = sendQueuesRef.current.get(recipientId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const channel = await getOutboundChannel(recipientId);
      const status = await channel.send({
        type: 'broadcast',
        event: SIGNAL_EVENT,
        payload: signal,
      });
      if (status !== 'ok') {
        throw new Error('Call signaling could not be delivered. Please try again.');
      }
    });
    sendQueuesRef.current.set(recipientId, next.catch(() => undefined));
    return next;
  }

  sendToUserRef.current = sendToUser;

  async function flushLocalCandidates(session: AudioSession) {
    if (!session.localCandidatesReady || session.flushingLocalCandidates || !isCurrent(session)) return;
    session.flushingLocalCandidates = true;
    try {
      while (session.pendingLocalCandidates.length && isCurrent(session)) {
        const candidate = session.pendingLocalCandidates.shift();
        if (!candidate) continue;
        await sendToUser(session.peer.id, makeSignal(session, 'candidate', { candidate }));
      }
    } catch (error) {
      if (isCurrent(session)) {
        terminateSession(session, {
          notify: { type: 'hangup' },
          toastMessage: error instanceof Error ? error.message : 'Call signaling failed.',
        });
      }
    } finally {
      session.flushingLocalCandidates = false;
      if (session.pendingLocalCandidates.length && isCurrent(session)) {
        void flushLocalCandidates(session);
      }
    }
  }

  function createPeerConnection(session: AudioSession) {
    const peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      iceTransportPolicy: 'all',
    });
    session.pc = peerConnection;

    peerConnection.onicecandidate = (event) => {
      if (!event.candidate || !isCurrent(session)) return;
      session.pendingLocalCandidates.push(event.candidate.toJSON());
      void flushLocalCandidates(session);
    };

    peerConnection.ontrack = (event) => {
      if (!isCurrent(session)) return;
      const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
      session.remoteStream = remoteStream;
      updateSnapshot(session, { remoteStream });
    };

    peerConnection.onconnectionstatechange = () => {
      if (!isCurrent(session)) return;
      if (peerConnection.connectionState === 'connected') {
        clearTimeoutFor(session);
        if (session.phase !== 'active') {
          session.phase = 'active';
          session.startedAt = Date.now();
          updateSnapshot(session, { phase: 'active', startedAt: session.startedAt });
        }
      } else if (peerConnection.connectionState === 'failed') {
        terminateSession(session, {
          notify: { type: 'hangup' },
          toastMessage: 'The audio connection could not be established.',
        });
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      if (!isCurrent(session)) return;
      if (
        peerConnection.iceConnectionState === 'connected'
        || peerConnection.iceConnectionState === 'completed'
      ) {
        clearTimeoutFor(session);
      } else if (peerConnection.iceConnectionState === 'disconnected') {
        armTimeout(
          session,
          12_000,
          'The audio connection was interrupted.',
          { type: 'hangup' },
        );
      } else if (peerConnection.iceConnectionState === 'failed') {
        terminateSession(session, {
          notify: { type: 'hangup' },
          toastMessage: 'The audio connection was interrupted.',
        });
      }
    };

    return peerConnection;
  }

  async function addMicrophone(session: AudioSession, peerConnection: RTCPeerConnection) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access requires a supported browser and a secure connection.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    if (!isCurrent(session)) {
      stopStream(stream);
      return false;
    }
    session.localStream = stream;
    stream.getAudioTracks().forEach((track) => peerConnection.addTrack(track, stream));
    return true;
  }

  async function applyRemoteCandidates(session: AudioSession) {
    const peerConnection = session.pc;
    if (!peerConnection?.remoteDescription) return;
    while (session.pendingRemoteCandidates.length && isCurrent(session)) {
      const candidate = session.pendingRemoteCandidates.shift();
      if (candidate) await peerConnection.addIceCandidate(candidate);
    }
  }

  async function handleSignal(rawValue: unknown) {
    const value = signalFromBroadcast(rawValue);
    if (!isRecord(value)) return;
    const signal = value as Partial<AudioSignal>;
    const currentUserId = userInfoRef.current.userId;
    if (
      !isUuid(signal.callId)
      || !isUuid(signal.fromUserId)
      || signal.toUserId !== currentUserId
      || signal.fromUserId === currentUserId
      || typeof signal.type !== 'string'
    ) return;

    if (signal.type === 'invite') {
      if (!isDescription(signal.offer) || signal.offer.type !== 'offer') return;
      if (typeof signal.sentAt !== 'number' || Date.now() - signal.sentAt > CALL_RING_TIMEOUT_MS) return;
      const current = sessionRef.current;
      if (current) {
        const busySignal: AudioSignal = {
          type: 'busy',
          callId: signal.callId,
          fromUserId: currentUserId,
          toUserId: signal.fromUserId,
          sentAt: Date.now(),
        };
        void sendToUser(signal.fromUserId, busySignal)
          .catch(() => undefined)
          .finally(() => removeOutboundChannel(signal.fromUserId));
        return;
      }

      const incomingPeer = isRecord(signal.peer)
        ? {
            id: signal.fromUserId,
            name: normalizeName(signal.peer.name),
            image: normalizeImage(signal.peer.image),
          }
        : { id: signal.fromUserId, name: 'Tea Chat member', image: null };
      const session = createSession(
        signal.callId,
        incomingPeer,
        'callee',
        'incoming',
        signal.offer,
      );
      sessionRef.current = session;
      publishSession(session);
      armTimeout(
        session,
        CALL_RING_TIMEOUT_MS,
        'This call expired.',
        { type: 'reject', reason: 'no-answer' },
      );
      return;
    }

    const session = sessionRef.current;
    if (
      !session
      || session.callId !== signal.callId
      || session.peer.id !== signal.fromUserId
    ) return;

    if (signal.type === 'candidate') {
      if (!isCandidate(signal.candidate)) return;
      if (session.pc?.remoteDescription) {
        try {
          await session.pc.addIceCandidate(signal.candidate);
        } catch {
          if (isCurrent(session)) {
            terminateSession(session, {
              notify: { type: 'hangup' },
              toastMessage: 'A network candidate could not be added.',
            });
          }
        }
      } else if (session.pendingRemoteCandidates.length < 256) {
        session.pendingRemoteCandidates.push(signal.candidate);
      }
      return;
    }

    if (signal.type === 'accept' && session.role === 'caller') {
      if (session.phase !== 'calling') return;
      if (!isDescription(signal.answer) || signal.answer.type !== 'answer' || !session.pc) return;
      clearTimeoutFor(session);
      session.phase = 'connecting';
      updateSnapshot(session, { phase: 'connecting' });
      armTimeout(
        session,
        CALL_CONNECT_TIMEOUT_MS,
        'The call could not connect.',
        { type: 'hangup' },
      );
      try {
        await session.pc.setRemoteDescription(signal.answer);
        await applyRemoteCandidates(session);
      } catch {
        if (isCurrent(session)) {
          terminateSession(session, {
            notify: { type: 'hangup' },
            toastMessage: 'The call setup failed. Please try again.',
          });
        }
      }
      return;
    }

    if (signal.type === 'reject') {
      terminateSession(session, {
        toastMessage: signal.reason === 'no-answer' ? 'No answer.' : 'Call declined.',
      });
      return;
    }
    if (signal.type === 'busy') {
      terminateSession(session, { toastMessage: 'Theyâre already on another call.' });
      return;
    }
    if (signal.type === 'cancel') {
      terminateSession(session);
      return;
    }
    if (signal.type === 'hangup') {
      terminateSession(session, { toastMessage: 'Call ended.' });
      return;
    }
    if (signal.type === 'chat' && session.phase === 'active' && isRecord(signal.message)) {
      const message = signal.message as Partial<AudioChatMessage>;
      if (
        typeof message.id === 'string'
        && message.fromUserId === session.peer.id
        && typeof message.text === 'string'
        && message.text.length <= MAX_CHAT_MESSAGE_LENGTH
        && typeof message.createdAt === 'number'
      ) {
        appendMessage(session, {
          id: message.id,
          fromUserId: message.fromUserId,
          text: message.text,
          createdAt: message.createdAt,
        });
      }
    }
  }

  signalHandlerRef.current = (value) => { void handleSignal(value); };

  async function startCall(peer: AudioCallPeer) {
    const currentUserId = userInfoRef.current.userId;
    if (!peer.id || peer.id === currentUserId || !isUuid(peer.id)) {
      notify('This conversation does not have a valid call recipient.', true);
      return;
    }
    if (sessionRef.current) {
      notify('Finish the current call before starting another.');
      return;
    }
    if (!inboxReadyRef.current) {
      notify('Call signaling is not connected yet. Please try again in a moment.', true);
      return;
    }

    const normalizedPeer = {
      id: peer.id,
      name: normalizeName(peer.name),
      image: normalizeImage(peer.image),
    };
    const session = createSession(newId(), normalizedPeer, 'caller', 'calling');
    sessionRef.current = session;
    publishSession(session);

    try {
      const peerConnection = createPeerConnection(session);
      if (!await addMicrophone(session, peerConnection) || !isCurrent(session)) return;
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      if (!isCurrent(session) || !peerConnection.localDescription) return;

      const invite: AudioSignal = makeSignal(session, 'invite', {
        peer: {
          id: currentUserId,
          name: normalizeName(userInfoRef.current.displayName),
          image: normalizeImage(userInfoRef.current.image),
        },
        offer: peerConnection.localDescription.toJSON(),
      });
      await sendToUser(normalizedPeer.id, invite);
      if (!isCurrent(session)) return;

      session.localCandidatesReady = true;
      armTimeout(
        session,
        CALL_RING_TIMEOUT_MS,
        'No answer.',
        { type: 'cancel' },
      );
      void flushLocalCandidates(session);
    } catch (error) {
      if (!isCurrent(session)) return;
      terminateSession(session, {
        notify: { type: 'cancel' },
        toastMessage: error instanceof Error ? error.message : 'Could not start the call.',
      });
    }
  }

  async function acceptCall() {
    const session = sessionRef.current;
    if (!session || session.role !== 'callee' || session.phase !== 'incoming' || !session.offer) return;
    clearTimeoutFor(session);
    session.phase = 'connecting';
    updateSnapshot(session, { phase: 'connecting' });

    try {
      const peerConnection = createPeerConnection(session);
      if (!await addMicrophone(session, peerConnection) || !isCurrent(session)) return;
      await peerConnection.setRemoteDescription(session.offer);
      await applyRemoteCandidates(session);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      if (!isCurrent(session) || !peerConnection.localDescription) return;

      const accept: AudioSignal = makeSignal(session, 'accept', {
        answer: peerConnection.localDescription.toJSON(),
      });
      await sendToUser(session.peer.id, accept);
      if (!isCurrent(session)) return;

      session.localCandidatesReady = true;
      armTimeout(
        session,
        CALL_CONNECT_TIMEOUT_MS,
        'The call could not connect.',
        { type: 'hangup' },
      );
      void flushLocalCandidates(session);
    } catch (error) {
      if (!isCurrent(session)) return;
      terminateSession(session, {
        notify: { type: 'reject', reason: 'microphone' },
        toastMessage: error instanceof Error ? error.message : 'Could not connect the microphone.',
      });
    }
  }

  function rejectCall() {
    const session = sessionRef.current;
    if (!session) return;
    terminateSession(session, { notify: { type: 'reject', reason: 'declined' } });
  }

  function endCall() {
    const session = sessionRef.current;
    if (!session) return;
    if (session.phase === 'incoming') {
      terminateSession(session, { notify: { type: 'reject', reason: 'declined' } });
    } else if (session.phase === 'calling') {
      terminateSession(session, { notify: { type: 'cancel' } });
    } else {
      terminateSession(session, { notify: { type: 'hangup' } });
    }
  }

  function toggleMute() {
    const session = sessionRef.current;
    if (!session?.localStream || session.phase !== 'active') return;
    session.muted = !session.muted;
    session.localStream.getAudioTracks().forEach((track) => {
      track.enabled = !session.muted;
    });
    updateSnapshot(session, { muted: session.muted });
  }

  function toggleChat() {
    setCall((current) => current ? { ...current, chatOpen: !current.chatOpen } : current);
  }

  async function sendChatMessage(text: string) {
    const session = sessionRef.current;
    const trimmed = text.trim().slice(0, MAX_CHAT_MESSAGE_LENGTH);
    if (!session || session.phase !== 'active' || !trimmed) return false;

    const message: AudioChatMessage = {
      id: newId(),
      fromUserId: userInfoRef.current.userId,
      text: trimmed,
      createdAt: Date.now(),
    };
    try {
      await sendToUser(session.peer.id, makeSignal(session, 'chat', { message }));
      if (!isCurrent(session)) return false;
      appendMessage(session, message);
      return true;
    } catch (error) {
      if (isCurrent(session)) {
        notify(error instanceof Error ? error.message : 'Your call message could not be sent.', true);
      }
      return false;
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    inboxReadyRef.current = false;
    setCall(null);

    let cancelled = false;
    let inbox: RealtimeChannel | null = null;
    const { data: { subscription: authSubscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (session?.user.id === userId) {
          void supabase.realtime.setAuth(session.access_token);
        } else {
          inboxReadyRef.current = false;
        }
      },
    );

    async function connectInbox() {
      const { data: { session }, error } = await supabase.auth.getSession();
      if (cancelled) return;
      if (error || !session) {
        inboxReadyRef.current = false;
        if (mountedRef.current) {
          notify('Call signaling needs an active Supabase session. Sign in again, then retry.', true);
        }
        return;
      }
      if (session.user.id !== userId) {
        inboxReadyRef.current = false;
        if (mountedRef.current) {
          notify('Your Supabase session does not match this chat account. Sign out and back in.', true);
        }
        return;
      }

      await supabase.realtime.setAuth(session.access_token);
      if (cancelled) return;

      const channel = supabase.channel(inboxTopic(userId), {
        config: {
          private: true,
          broadcast: { ack: true, self: false },
        },
      });
      inbox = channel;
      inboxRef.current = channel;
      channel
        .on('broadcast', { event: SIGNAL_EVENT }, (payload) => {
          signalHandlerRef.current(payload);
        })
        .subscribe((status, error) => {
          if (cancelled) return;
          if (status === 'SUBSCRIBED') {
            inboxReadyRef.current = true;
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            inboxReadyRef.current = false;
            if (mountedRef.current) {
              notify(error instanceof Error
                ? error.message
                : 'Call signaling could not connect. Check the Supabase Realtime setup.', true);
            }
          }
        });
    }

    void connectInbox().catch((error: unknown) => {
      if (cancelled || !mountedRef.current) return;
      inboxReadyRef.current = false;
      notify(error instanceof Error
        ? error.message
        : 'Call signaling could not connect. Check the Supabase Realtime setup.', true);
    });

    return () => {
      cancelled = true;
      authSubscription.unsubscribe();
      mountedRef.current = false;
      inboxReadyRef.current = false;
      inboxRef.current = null;
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) {
        clearTimeoutFor(session);
        if (session.pc) {
          session.pc.onicecandidate = null;
          session.pc.ontrack = null;
          session.pc.onconnectionstatechange = null;
          session.pc.oniceconnectionstatechange = null;
          session.pc.close();
        }
        stopStream(session.localStream);
        session.localStream = null;
        session.remoteStream = null;
      }
      if (inbox) void supabase.removeChannel(inbox);
      outboundChannelsRef.current.forEach((channelPromise) => {
        void channelPromise
          .then((channel) => supabase.removeChannel(channel))
          .catch(() => undefined);
      });
      outboundChannelsRef.current.clear();
      sendQueuesRef.current.clear();
    };
  }, [supabase, userId]);

  return {
    call,
    startCall,
    acceptCall,
    rejectCall,
    endCall,
    toggleMute,
    toggleChat,
    sendChatMessage,
  };
}
