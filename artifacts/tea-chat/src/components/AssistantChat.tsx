import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  ImagePlus,
  LoaderCircle,
  Menu,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  Attachment as StreamAttachment,
  Channel as StreamChannel,
  MessageResponse,
  StreamChat,
} from 'stream-chat';
import type { SupabaseClient } from '@supabase/supabase-js';
import './AssistantChat.css';

type AssistantChatProps = {
  client: StreamChat | null;
  userId: string;
  supabase: SupabaseClient;
  theme: 'light' | 'dark';
};

type PendingRequest = {
  channelId: string;
  messageId: string;
  imageDataUrl?: string;
};

type AssistantEvent = {
  delta?: unknown;
  error?: unknown;
  done?: boolean;
};

function getChannelTitle(channel: StreamChannel): string {
  const data = channel.data as Record<string, unknown> | undefined;
  return typeof data?.name === 'string' && data.name.trim() ? data.name.trim() : 'Tea AI chat';
}

function getChannelPreview(channel: StreamChannel): string {
  const lastMessage = channel.state.messages.at(-1);
  return typeof lastMessage?.text === 'string' && lastMessage.text.trim()
    ? lastMessage.text.trim()
    : 'Start a conversation';
}

function getImageUrl(message: MessageResponse): string | null {
  for (const attachment of message.attachments ?? []) {
    const data = attachment as unknown as Record<string, unknown>;
    const candidate = data.image_url ?? data.asset_url ?? data.thumb_url;
    if (typeof candidate === 'string' && /^https:\/\//i.test(candidate)) return candidate;
  }
  return null;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('This photo could not be read.'));
    };
    reader.onerror = () => reject(new Error('This photo could not be read.'));
    reader.readAsDataURL(file);
  });
}

async function getAccessToken(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) {
    throw new Error('Your sign-in session expired. Please sign in again.');
  }
  return data.session.access_token;
}

export function AssistantChat({ client, userId, supabase, theme }: AssistantChatProps) {
  const [open, setOpen] = useState(false);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [conversations, setConversations] = useState<StreamChannel[]>([]);
  const [activeChannel, setActiveChannel] = useState<StreamChannel | null>(null);
  const [messages, setMessages] = useState<MessageResponse[]>([]);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [draft, setDraft] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [error, setError] = useState('');
  const [pendingRequest, setPendingRequest] = useState<PendingRequest | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messageEndRef = useRef<HTMLDivElement>(null);

  const loadConversations = useCallback(async () => {
    if (!client) return [] as StreamChannel[];
    const channels = await client.queryChannels(
      { type: 'messaging', members: { $in: [userId] }, ai_assistant: true } as never,
      { last_message_at: -1 },
      { limit: 50, message_limit: 3, state: true, watch: false },
    );
    setConversations(channels);
    return channels;
  }, [client, userId]);

  useEffect(() => {
    if (!open || !client) return;
    let active = true;
    setLoadingConversations(true);
    void loadConversations().catch(() => {
      if (active) setError('Your AI chats could not be loaded. Please try again.');
    }).finally(() => {
      if (active) setLoadingConversations(false);
    });
    return () => { active = false; };
  }, [open, client, loadConversations]);

  useEffect(() => {
    if (!activeChannel) {
      setMessages([]);
      return;
    }
    setMessages([...activeChannel.state.messages]);
    const subscription = activeChannel.on('message.new', (event) => {
      const nextMessage = event.message;
      if (!nextMessage) return;
      setMessages((current) => current.some((message) => message.id === nextMessage.id)
        ? current
        : [...current, nextMessage]);
    });
    return () => { subscription.unsubscribe(); };
  }, [activeChannel]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streamingText, generating]);

  useEffect(() => () => {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
  }, [imagePreview]);

  async function openConversation(channel: StreamChannel) {
    setError('');
    try {
      await channel.watch();
      setActiveChannel(channel);
      setThreadsOpen(false);
    } catch {
      setError('That AI chat could not be opened. Please try again.');
    }
  }

  async function createConversation() {
    if (!client) {
      setError('Your chats are still connecting. Try again in a moment.');
      return;
    }
    setCreatingConversation(true);
    setError('');
    try {
      const token = await getAccessToken(supabase);
      const response = await fetch('/api/assistant/conversations', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: '{}',
      });
      const result = await response.json().catch(() => ({})) as { id?: unknown; error?: unknown };
      if (!response.ok || typeof result.id !== 'string') {
        throw new Error(typeof result.error === 'string' ? result.error : 'A new AI chat could not be created.');
      }
      const channel = client.channel('messaging', result.id);
      await channel.watch();
      setActiveChannel(channel);
      setMessages([...channel.state.messages]);
      setPendingRequest(null);
      setThreadsOpen(false);
      const next = await loadConversations().catch(() => conversations);
      if (!next.some((item) => item.id === channel.id)) setConversations((current) => [channel, ...current]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'A new AI chat could not be created.');
    } finally {
      setCreatingConversation(false);
    }
  }

  async function requestReply(channelId: string, messageId: string, imageDataUrl?: string) {
    setGenerating(true);
    setStreamingText('');
    setError('');
    try {
      const token = await getAccessToken(supabase);
      const response = await fetch('/api/assistant/conversations/' + encodeURIComponent(channelId) + '/respond', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, ...(imageDataUrl ? { imageDataUrl } : {}) }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: unknown };
        throw new Error(typeof result.error === 'string' ? result.error : 'Tea AI could not answer. Please try again.');
      }
      if (!response.body) throw new Error('The AI response stream is unavailable. Please try again.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let completed = false;
      const consumeFrame = (frame: string) => {
        const dataLines = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'));
        for (const line of dataLines) {
          const payloadText = line.slice(5).trim();
          if (!payloadText) continue;
          const payload = JSON.parse(payloadText) as AssistantEvent;
          if (typeof payload.error === 'string') throw new Error(payload.error);
          if (typeof payload.delta === 'string') setStreamingText((current) => current + payload.delta);
          if (payload.done) completed = true;
        }
      };
      try {
        while (true) {
          const result = await reader.read();
          buffer += decoder.decode(result.value ?? new Uint8Array(), { stream: !result.done });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? '';
          for (const frame of frames) consumeFrame(frame);
          if (result.done) break;
        }
        if (buffer.trim()) consumeFrame(buffer);
      } finally {
        reader.releaseLock();
      }
      if (!completed) throw new Error('The AI response ended early. Please try again.');
      setPendingRequest(null);
      await loadConversations().catch(() => undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Tea AI could not answer. Please try again.');
    } finally {
      setGenerating(false);
    }
  }

  async function sendMessage() {
    const text = draft.trim();
    if ((!text && !selectedFile) || sending || generating) return;
    if (text.length > 5000) {
      setError('Messages can be up to 5,000 characters.');
      return;
    }
    if (!client || !activeChannel?.id) {
      setError('Start a new AI chat before sending a message.');
      return;
    }
    setSending(true);
    setError('');
    try {
      const imageDataUrl = selectedFile ? await fileToDataUrl(selectedFile) : undefined;
      let attachments: StreamAttachment[] | undefined;
      if (selectedFile) {
        const upload = await activeChannel.sendImage(selectedFile, selectedFile.name, selectedFile.type);
        attachments = [{
          type: 'image',
          asset_url: upload.file,
          thumb_url: upload.file,
          title: selectedFile.name,
        } as StreamAttachment];
      }
      const sent = await activeChannel.sendMessage({ text, ...(attachments ? { attachments } : {}) });
      const nextRequest: PendingRequest = {
        channelId: activeChannel.id,
        messageId: sent.message.id,
        ...(imageDataUrl ? { imageDataUrl } : {}),
      };
      setPendingRequest(nextRequest);
      setDraft('');
      setSelectedFile(null);
      setImagePreview(null);
      await loadConversations().catch(() => undefined);
      await requestReply(nextRequest.channelId, nextRequest.messageId, nextRequest.imageDataUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Your message could not be sent. Please try again.');
    } finally {
      setSending(false);
    }
  }

  function chooseImage(file: File | undefined) {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Choose a JPEG, PNG, or WebP photo.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Photos must be 5 MB or smaller.');
      return;
    }
    setError('');
    setSelectedFile(file);
    setImagePreview(URL.createObjectURL(file));
  }

  function removeImage() {
    setSelectedFile(null);
    setImagePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  const activeTitle = activeChannel ? getChannelTitle(activeChannel) : 'Tea AI';

  return (
    <>
      <button
        className="tea-ai-launcher"
        type="button"
        aria-label="Open Tea AI chat"
        aria-expanded={open}
        onClick={() => { setOpen(true); setThreadsOpen(false); }}
        data-testid="button-open-ai-chat"
      >
        <Sparkles size={17} />
        <span>Ask AI</span>
      </button>

      {open && (
        <section
          className={'tea-ai-surface' + (theme === 'dark' ? ' tea-ai-dark' : '') + (threadsOpen ? ' threads-open' : '')}
          role="dialog"
          aria-modal="true"
          aria-label="Tea AI chat"
          data-testid="panel-ai-chat"
        >
          <aside className="tea-ai-sidebar">
            <div className="tea-ai-sidebar-head">
              <div className="tea-ai-brand"><span className="tea-ai-brand-icon"><Bot size={17} /></span><div><strong>Tea AI</strong><small>Your private assistant</small></div></div>
              <button className="tea-ai-icon-button tea-ai-sidebar-back" type="button" onClick={() => setThreadsOpen(false)} aria-label="Back to AI chat" title="Back to chat"><ArrowLeft size={16} /></button>
              <button className="tea-ai-icon-button" type="button" onClick={() => setOpen(false)} aria-label="Close AI chat" title="Close AI chat"><X size={17} /></button>
            </div>
            <button className="tea-ai-new-chat" type="button" onClick={() => { void createConversation(); }} disabled={creatingConversation || !client} data-testid="button-ai-new-chat">
              {creatingConversation ? <LoaderCircle size={15} className="tea-ai-spin" /> : <Plus size={16} />}
              <span>New chat</span>
            </button>
            <div className="tea-ai-thread-label">Your AI chats</div>
            <div className="tea-ai-thread-list" aria-label="AI chat history">
              {loadingConversations ? <div className="tea-ai-list-status"><LoaderCircle size={15} className="tea-ai-spin" /> Loading chats…</div> : null}
              {!loadingConversations && conversations.length === 0 ? <div className="tea-ai-list-status">Your AI conversations will show up here.</div> : null}
              {conversations.map((channel) => (
                <button
                  className={'tea-ai-thread' + (activeChannel?.id === channel.id ? ' is-active' : '')}
                  type="button"
                  key={channel.cid}
                  onClick={() => { void openConversation(channel); }}
                  aria-current={activeChannel?.id === channel.id ? 'page' : undefined}
                >
                  <strong>{getChannelTitle(channel)}</strong>
                  <span>{getChannelPreview(channel)}</span>
                </button>
              ))}
            </div>
            <div className="tea-ai-sidebar-note">Chats are saved to your Tea Chat account.</div>
          </aside>

          <div className="tea-ai-main">
            <header className="tea-ai-topbar">
              <button className="tea-ai-icon-button tea-ai-thread-toggle" type="button" onClick={() => setThreadsOpen((value) => !value)} aria-label="Show AI chat history" title="Chat history"><Menu size={17} /></button>
              <button className="tea-ai-mobile-back" type="button" onClick={() => setThreadsOpen(true)} aria-label="Back to AI chat history"><ArrowLeft size={16} /></button>
              <div className="tea-ai-title"><strong>{activeTitle}</strong><span>Ask in any language, or add a photo</span></div>
              <button className="tea-ai-icon-button tea-ai-main-close" type="button" onClick={() => setOpen(false)} aria-label="Close AI chat" title="Close AI chat"><X size={17} /></button>
            </header>

            <div className="tea-ai-messages" aria-live="polite">
              {!activeChannel ? (
                <div className="tea-ai-empty">
                  <div className="tea-ai-empty-icon"><Sparkles size={22} /></div>
                  <h2>A little help, in any language.</h2>
                  <p>Ask a question, work through an idea, or attach a photo for Tea AI to understand.</p>
                  <button type="button" onClick={() => { void createConversation(); }} disabled={creatingConversation || !client} data-testid="button-ai-start-chat">
                    {creatingConversation ? <LoaderCircle size={15} className="tea-ai-spin" /> : <Plus size={16} />}
                    Start a new chat
                  </button>
                </div>
              ) : messages.filter((message) => message.type === 'regular').map((message) => {
                const isMine = message.user?.id === userId;
                const imageUrl = getImageUrl(message);
                return (
                  <article className={'tea-ai-message' + (isMine ? ' is-mine' : '')} key={message.id}>
                    <div className="tea-ai-message-label">{isMine ? 'You' : 'Tea AI'}</div>
                    <div className="tea-ai-bubble">
                      {imageUrl ? <img className="tea-ai-message-image" src={imageUrl} alt="Photo shared in this AI chat" loading="lazy" /> : null}
                      {message.text ? <div className="tea-ai-message-text">{message.text}</div> : null}
                    </div>
                  </article>
                );
              })}
              {generating ? (
                <article className="tea-ai-message">
                  <div className="tea-ai-message-label">Tea AI</div>
                  <div className="tea-ai-bubble tea-ai-live-response">
                    {streamingText ? <div className="tea-ai-message-text">{streamingText}</div> : <span className="tea-ai-thinking"><LoaderCircle size={14} className="tea-ai-spin" /> Thinking…</span>}
                  </div>
                </article>
              ) : null}
              <div ref={messageEndRef} />
            </div>

            {error ? (
              <div className="tea-ai-error" role="alert">
                <span>{error}</span>
                {pendingRequest && !generating ? <button type="button" onClick={() => { void requestReply(pendingRequest.channelId, pendingRequest.messageId, pendingRequest.imageDataUrl); }}><RotateCcw size={13} />Retry</button> : null}
              </div>
            ) : null}

            {activeChannel ? (
              <form className="tea-ai-composer" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
                {imagePreview ? (
                  <div className="tea-ai-image-preview">
                    <img src={imagePreview} alt="Selected photo preview" />
                    <button type="button" onClick={removeImage} aria-label="Remove selected photo"><X size={13} /></button>
                  </div>
                ) : null}
                <div className="tea-ai-composer-row">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="tea-ai-hidden-input"
                    aria-label="Choose a photo"
                    onChange={(event) => {
                      chooseImage(event.currentTarget.files?.[0]);
                      event.currentTarget.value = '';
                    }}
                  />
                  <button className="tea-ai-icon-button tea-ai-image-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={sending || generating} aria-label="Attach a photo" title="Attach a photo" data-testid="button-ai-attach-image"><ImagePlus size={18} /></button>
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        void sendMessage();
                      }
                    }}
                    placeholder="Message Tea AI…"
                    aria-label="Message Tea AI"
                    maxLength={5000}
                    rows={1}
                    disabled={sending || generating}
                    data-testid="input-ai-message"
                  />
                  <button className="tea-ai-send-button" type="submit" disabled={sending || generating || (!draft.trim() && !selectedFile)} aria-label="Send message" data-testid="button-ai-send">
                    {sending ? <LoaderCircle size={17} className="tea-ai-spin" /> : <Send size={16} />}
                  </button>
                </div>
                <div className="tea-ai-composer-hint">Messages and photos go to Groq to generate replies. Don’t share sensitive information.</div>
              </form>
            ) : null}
          </div>
        </section>
      )}
    </>
  );
}
