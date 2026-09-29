import { useEffect, useMemo, useRef, useState } from 'react';
import type { MediaDescriptor } from '@/db/db';
import { formatDuration } from '@/lib/media/labels';
import { decodeWaveform } from '@/lib/media/voiceRecorder';

const SPEEDS = [1, 1.5, 2];

/**
 * Voice-note playback (FR-5.4): waveform with played progress, tap-to-seek, 1x/1.5x/2x.
 * The waveform comes from the message itself, so it draws before the audio has downloaded.
 */
export default function VoiceNotePlayer({
  media,
  url,
  pending,
}: {
  media: MediaDescriptor;
  /** Object URL once the audio is available locally. */
  url: string | null;
  /** Upload or download overlay shown in place of the play button. */
  pending: React.ReactNode;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const bars = useMemo(() => decodeWaveform(media.waveform), [media.waveform]);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [speed, setSpeed] = useState(1);
  const durationMs = media.durationMs ?? 0;

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = speed;
  }, [speed, url]);

  const progress = durationMs ? Math.min(1, position / durationMs) : 0;

  function toggle() {
    const element = audio.current;
    if (!element) return;
    if (element.paused) {
      void element.play();
    } else {
      element.pause();
    }
  }

  function seek(event: React.MouseEvent<HTMLDivElement>) {
    const element = audio.current;
    if (!element || !durationMs) return;
    const box = event.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    element.currentTime = (fraction * durationMs) / 1000;
    setPosition(fraction * durationMs);
  }

  function seekByKey(event: React.KeyboardEvent<HTMLDivElement>) {
    const element = audio.current;
    if (!element) return;
    const step = event.key === 'ArrowRight' ? 5 : event.key === 'ArrowLeft' ? -5 : 0;
    if (!step) return;
    event.preventDefault();
    element.currentTime = Math.max(0, element.currentTime + step);
  }

  return (
    <div className="mb-1 flex w-[260px] items-center gap-2.5">
      {url ? (
        <button
          onClick={toggle}
          aria-label={playing ? 'Pause voice message' : 'Play voice message'}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-secondary hover:bg-black/20"
        >
          {playing ? (
            <svg viewBox="0 0 24 24" className="h-6 w-6 fill-current" aria-hidden="true"><path d="M6 19h4V5H6v14Zm8-14v14h4V5h-4Z" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-6 w-6 fill-current" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
          )}
        </button>
      ) : (
        <span className="shrink-0">{pending}</span>
      )}

      <div className="min-w-0 flex-1">
        <div
          role="slider"
          tabIndex={url ? 0 : -1}
          aria-label="Playback position"
          aria-valuemin={0}
          aria-valuemax={Math.round(durationMs / 1000)}
          aria-valuenow={Math.round(position / 1000)}
          aria-valuetext={`${formatDuration(position) || '0:00'} of ${formatDuration(durationMs)}`}
          onClick={seek}
          onKeyDown={seekByKey}
          className="flex h-7 cursor-pointer items-center gap-[2px]"
        >
          {bars.map((height, i) => (
            <span
              key={i}
              className={`w-[2px] flex-1 rounded-full ${i / bars.length < progress ? 'bg-accent' : 'bg-text-secondary/50'}`}
              style={{ height: `${Math.round(height * 100)}%` }}
            />
          ))}
        </div>
        <div className="mt-0.5 flex items-center justify-between pr-14 text-[11px] text-text-secondary">
          <span>{formatDuration(playing || position ? position : durationMs) || '0:00'}</span>
        </div>
      </div>

      {url && (playing || position > 0) && (
        <button
          onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}
          aria-label={`Playback speed ${speed}x. Change speed`}
          className="shrink-0 rounded-full bg-black/25 px-2 py-0.5 text-xs font-medium"
        >
          {speed}×
        </button>
      )}

      {url && (
        <audio
          ref={audio}
          src={url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime * 1000)}
          onEnded={() => {
            setPlaying(false);
            setPosition(0);
          }}
        />
      )}
    </div>
  );
}
