import { useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { sampleAudio } from './sample-audio';
import './_group.css';

const waveform = [17, 32, 24, 44, 28, 51, 35, 22, 42, 30, 56, 25, 39, 19, 47, 33, 23, 53, 29, 40, 18, 34, 48, 25, 39, 21, 45, 31, 54, 27, 38, 20, 46, 30, 55, 24, 42, 18, 34, 49, 27, 40, 21, 51, 31, 43];

function timeLabel(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

export function Redesign() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(5);
  const progress = duration ? Math.min(currentTime / duration, 1) : 0;

  async function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      try {
        await audio.play();
        setPlaying(true);
      } catch {
        setPlaying(false);
      }
    } else {
      audio.pause();
      setPlaying(false);
    }
  }

  return (
    <main className="tea-voice-note-preview">
      <h1 className="tea-voice-note-preview__heading">Tea Chat voice note · compact player</h1>
      <section className="tea-voice-note-preview__message" aria-label="Redesigned voice message">
        <p className="tea-voice-note-preview__sender">Moaz · Today at 9:26 AM</p>
        <div className="tea-voice-note">
          <audio
            ref={audioRef}
            src={sampleAudio}
            preload="metadata"
            onLoadedMetadata={(event) => {
              const loaded = event.currentTarget.duration;
              setDuration(Number.isFinite(loaded) && loaded > 0 ? loaded : 5);
            }}
            onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => { setPlaying(false); setCurrentTime(0); }}
          />
          <button
            className="tea-voice-note__play"
            type="button"
            aria-label={playing ? 'Pause voice note' : 'Play voice note'}
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
                    style={{ height: `${Math.max(18, Math.round((value / 56) * 100))}%` }}
                  />
                ))}
              </div>
              <input
                className="tea-voice-note__seek"
                type="range"
                min="0"
                max="100"
                step="1"
                value={Math.round(progress * 100)}
                aria-label="Seek voice note"
                onChange={(event) => {
                  const audio = audioRef.current;
                  if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
                  audio.currentTime = (Number(event.currentTarget.value) / 100) * audio.duration;
                  setCurrentTime(audio.currentTime);
                }}
              />
            </div>
            <div className="tea-voice-note__meta">
              <span>Voice note</span>
              <time>{timeLabel(playing ? currentTime : duration)}</time>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
