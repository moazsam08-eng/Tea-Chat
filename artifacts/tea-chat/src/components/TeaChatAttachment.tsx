import { useRef, useState, type ComponentProps } from 'react';
import type { Attachment as StreamAttachment } from 'stream-chat';
import {
  Attachment as StreamAttachmentRenderer,
  Audio as StreamAudio,
  FileAttachment as StreamFileAttachment,
  VoiceRecording as StreamVoiceRecording,
} from 'stream-chat-react';
import { Pause, Phone, Play, Video } from 'lucide-react';

type CallMode = 'audio' | 'video';
type CallHistoryAttachment = StreamAttachment & {
  tea_call_mode?: CallMode;
};

const FALLBACK_WAVEFORM = [17, 32, 24, 44, 28, 51, 35, 22, 42, 30, 56, 25, 39, 19, 47, 33, 23, 53, 29, 40, 18, 34, 48, 25, 39, 21, 45, 31, 54, 27, 38, 20, 46, 30, 55, 24, 42, 18, 34, 49, 27, 40, 21, 51, 31, 43];

function formatAudioTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const wholeSeconds = Math.floor(seconds);
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, '0')}`;
}

function audioSource(attachment: StreamAttachment) {
  const candidate = attachment.asset_url;
  return typeof candidate === 'string' && candidate.trim() ? candidate : undefined;
}

function TeaVoiceNote({ attachment }: { attachment: StreamAttachment }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const source = audioSource(attachment);
  const loadedDuration = Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : 0;
  const storedDuration = typeof attachment.duration === 'number' && Number.isFinite(attachment.duration)
    ? attachment.duration
    : 0;
  const duration = loadedDuration || storedDuration;
  const progress = duration > 0 ? Math.min(currentTime / duration, 1) : 0;
  const suppliedWaveform = Array.isArray(attachment.waveform_data)
    ? attachment.waveform_data.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    : [];
  const waveform = suppliedWaveform.length ? suppliedWaveform : FALLBACK_WAVEFORM;
  const maxWave = Math.max(...waveform, 1);

  async function togglePlayback() {
    const audio = audioRef.current;
    if (!audio || !source) return;
    setPlaybackFailed(false);
    if (!audio.paused) {
      audio.pause();
      setPlaying(false);
      return;
    }
    try {
      await audio.play();
      setPlaying(true);
    } catch {
      setPlaybackFailed(true);
      setPlaying(false);
    }
  }

  function seekTo(value: number) {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    audio.currentTime = (value / 100) * audio.duration;
    setCurrentTime(audio.currentTime);
  }

  return (
    <div className="tea-voice-note" data-testid="tea-voice-note">
      {source && (
        <audio
          ref={audioRef}
          src={source}
          preload="metadata"
          onLoadedMetadata={(event) => {
            const loaded = event.currentTarget.duration;
            setMediaDuration(Number.isFinite(loaded) ? loaded : 0);
          }}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); setCurrentTime(0); }}
        />
      )}
      <button
        className="tea-voice-note__play"
        type="button"
        aria-label={playing ? 'Pause voice note' : 'Play voice note'}
        disabled={!source}
        onClick={() => { void togglePlayback(); }}
      >
        {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
      </button>
      <div className="tea-voice-note__body">
        <div className="tea-voice-note__wave-wrap">
          <div className="tea-voice-note__wave" aria-hidden="true">
            {waveform.map((value, index) => (
              <span
                key={index}
                className={index / waveform.length <= progress ? 'played' : ''}
                style={{ height: `${Math.max(18, Math.round((value / maxWave) * 100))}%` }}
              />
            ))}
          </div>
          {duration > 0 && source && (
            <input
              className="tea-voice-note__seek"
              type="range"
              min="0"
              max="100"
              step="1"
              value={Math.round(progress * 100)}
              aria-label="Seek voice note"
              onChange={(event) => seekTo(Number(event.currentTarget.value))}
            />
          )}
        </div>
        <div className="tea-voice-note__meta">
          <span>{playbackFailed ? 'Could not play this voice note' : 'Voice note'}</span>
          <time>{formatAudioTime(playing ? currentTime : duration)}</time>
        </div>
      </div>
    </div>
  );
}

function isAudioAttachment(attachment: StreamAttachment) {
  const mime = typeof attachment.mime_type === 'string' ? attachment.mime_type.toLowerCase() : '';
  const fileName = [attachment.title, attachment.asset_url]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return mime.startsWith('audio/') || /\.(mp3|m4a|wav|ogg|webm|aac)(?:[?#\s]|$)/i.test(fileName);
}

function TeaFileAttachment(props: ComponentProps<typeof StreamFileAttachment>) {
  return isAudioAttachment(props.attachment)
    ? <TeaVoiceNote attachment={props.attachment} />
    : <StreamFileAttachment {...props} />;
}

function TeaAudioAttachment({ og }: ComponentProps<typeof StreamAudio>) {
  return <TeaVoiceNote attachment={og} />;
}

function TeaVoiceRecording({ attachment }: ComponentProps<typeof StreamVoiceRecording>) {
  return <TeaVoiceNote attachment={attachment} />;
}

function isCallHistoryAttachment(attachment: unknown): attachment is CallHistoryAttachment {
  return Boolean(
    attachment
    && typeof attachment === 'object'
    && 'type' in attachment
    && attachment.type === 'tea_call_log',
  );
}

function CallHistoryCard({ attachment }: { attachment: CallHistoryAttachment }) {
  const mode: CallMode = attachment.tea_call_mode === 'video' ? 'video' : 'audio';
  const Icon = mode === 'video' ? Video : Phone;
  return (
    <div className="tea-call-history" data-testid="tea-call-history">
      <span className="tea-call-history__icon"><Icon size={16} /></span>
      <span className="tea-call-history__copy">
        <strong>{mode === 'video' ? 'Video call' : 'Voice call'}</strong>
        <span>Call request</span>
      </span>
    </div>
  );
}

export function TeaChatAttachment(props: ComponentProps<typeof StreamAttachmentRenderer>) {
  const callHistory = props.attachments.filter(isCallHistoryAttachment);
  const otherAttachments = props.attachments.filter((attachment) => !isCallHistoryAttachment(attachment));

  return (
    <>
      {callHistory.map((attachment, index) => (
        <CallHistoryCard key={`${attachment.type}-${attachment.tea_call_mode}-${index}`} attachment={attachment} />
      ))}
      {otherAttachments.length > 0 && (
        <StreamAttachmentRenderer
          {...props}
          attachments={otherAttachments}
          Audio={TeaAudioAttachment}
          File={TeaFileAttachment}
          VoiceRecording={TeaVoiceRecording}
        />
      )}
    </>
  );
}
