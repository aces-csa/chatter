import { useState } from 'react';
import type { LocalMessage } from '@/db/db';
import { formatBytes, formatDuration } from '@/lib/media/labels';
import { realtimeService } from '@/realtime/RealtimeService';
import { useMediaBlob } from './useMediaBlob';
import Lightbox from './Lightbox';
import VoiceNotePlayer from './VoiceNotePlayer';
import { db } from '@/db/db';
import { loadMedia } from '@/lib/media/transfer';

/** Images download without asking below this; above it the user taps, as on mobile data. */
const AUTO_DOWNLOAD_BYTES = 8 * 1024 * 1024;

/** The attachment part of a bubble: image, video, audio or document, with upload/download state. */
export default function MediaView({ message, outgoing }: { message: LocalMessage; outgoing: boolean }) {
  if (message.media?.viewOnce) return <ViewOnce message={message} outgoing={outgoing} />;
  return <RegularMedia message={message} outgoing={outgoing} />;
}

/**
 * FR-5.8 view once. The recipient opens it one time; on closing, the decrypted copy and the key
 * are erased from this device, so it cannot be reopened, forwarded or saved from here. The
 * sender keeps no copy either. Screenshots remain possible -- the UI does not pretend otherwise.
 */
function ViewOnce({ message, outgoing }: { message: LocalMessage; outgoing: boolean }) {
  const media = message.media!;
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const label = media.kind === 'video' ? 'View once video' : 'View once photo';
  const spent = outgoing || media.viewOnceSpent || !media.key;

  async function open() {
    setBusy(true);
    try {
      setUrl(URL.createObjectURL(await loadMedia(media)));
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    if (url) URL.revokeObjectURL(url);
    setUrl(null);
    await db.transaction('rw', db.messages, db.mediaBlobs, async () => {
      if (media.mediaId) await db.mediaBlobs.delete(media.mediaId);
      await db.messages.update(message.clientMessageId, {
        media: { ...media, key: undefined, digest: undefined, thumbnail: undefined, viewOnceSpent: true },
      });
    });
  }

  return (
    <>
      <button
        onClick={() => !spent && void open()}
        disabled={spent || busy}
        className="mb-1 flex items-center gap-2 rounded-md bg-black/20 px-3 py-2 text-sm"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full border border-current text-xs">1</span>
        {spent ? (outgoing ? label : 'Opened') : busy ? 'Opening…' : label}
      </button>
      {url && <Lightbox url={url} kind={media.kind} name={media.name} onClose={() => void close()} noSave />}
    </>
  );
}

function RegularMedia({ message, outgoing }: { message: LocalMessage; outgoing: boolean }) {
  const media = message.media!;
  // Voice notes are small and meant to be played at once, so they always fetch ahead.
  const autoLoad = (media.kind === 'image' || media.voice === true) && media.size <= AUTO_DOWNLOAD_BYTES;
  const { url, state, load } = useMediaBlob(message, autoLoad);
  const [open, setOpen] = useState(false);

  const uploading = outgoing && message.upload && !message.upload.done && message.state !== 'FAILED';
  const overlay = uploading ? (
    <UploadOverlay
      progress={message.upload!.progress}
      onCancel={() => void realtimeService.cancelUpload(message.clientMessageId)}
    />
  ) : state === 'loading' ? (
    <Spinner />
  ) : state !== 'ready' ? (
    <DownloadButton size={media.size} failed={state === 'error'} onClick={load} />
  ) : null;

  if (media.kind === 'image' || media.kind === 'video') {
    const ratio = media.width && media.height ? media.height / media.width : 0.75;
    const width = Math.min(300, media.width ?? 300);
    return (
      <>
        <div
          className="relative mb-1 overflow-hidden rounded-md bg-black/30"
          style={{ width, height: Math.min(360, width * ratio) }}
        >
          {state === 'ready' && url && media.kind === 'image' ? (
            <button onClick={() => setOpen(true)} className="block h-full w-full" aria-label="Open photo">
              <img src={url} alt={media.name ?? 'Photo'} className="h-full w-full object-cover" />
            </button>
          ) : (
            media.thumbnail && (
              <img src={media.thumbnail} alt="" aria-hidden="true" className="h-full w-full scale-110 object-cover blur-md" />
            )
          )}
          {media.kind === 'video' && state === 'ready' && url && !uploading && (
            <button
              onClick={() => setOpen(true)}
              aria-label="Play video"
              className="absolute inset-0 flex items-center justify-center"
            >
              {media.thumbnail && <img src={media.thumbnail} alt="" className="absolute inset-0 h-full w-full object-cover" />}
              <span className="relative flex h-12 w-12 items-center justify-center rounded-full bg-black/60">
                <svg viewBox="0 0 24 24" className="ml-1 h-6 w-6 fill-white" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
              </span>
            </button>
          )}
          {overlay && <div className="absolute inset-0 flex items-center justify-center bg-black/20">{overlay}</div>}
          {media.kind === 'video' && media.durationMs && (
            <span className="absolute bottom-1 left-1.5 rounded bg-black/50 px-1 text-[11px] text-white">
              {formatDuration(media.durationMs)}
            </span>
          )}
        </div>
        {open && url && <Lightbox url={url} kind={media.kind} name={media.name} onClose={() => setOpen(false)} />}
      </>
    );
  }

  if (media.kind === 'audio' && media.voice) {
    return (
      <VoiceNotePlayer
        media={media}
        url={state === 'ready' && !uploading ? url : null}
        pending={overlay ?? <Spinner />}
      />
    );
  }

  if (media.kind === 'audio') {
    return (
      <div className="mb-1 flex min-w-[240px] items-center gap-2">
        {state === 'ready' && url && !uploading ? (
          <audio controls src={url} className="h-10 w-full" preload="metadata" />
        ) : (
          <>
            {overlay}
            <span className="text-sm text-text-secondary">
              {media.name ?? 'Audio'} {media.durationMs ? `· ${formatDuration(media.durationMs)}` : ''}
            </span>
          </>
        )}
      </div>
    );
  }

  // Document
  return (
    <div className="mb-1 flex min-w-[240px] items-center gap-3 rounded-md bg-black/15 p-2.5">
      <svg viewBox="0 0 24 24" className="h-8 w-8 shrink-0 fill-text-secondary" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm-1 7V3.5L18.5 9H13Z" />
      </svg>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{media.name ?? 'Document'}</p>
        <p className="text-xs text-text-secondary">
          {formatBytes(media.size)} · {(media.name?.split('.').pop() ?? media.mime).toUpperCase()}
        </p>
      </div>
      {state === 'ready' && url && !uploading ? (
        <a
          href={url}
          download={media.name ?? 'download'}
          aria-label={`Save ${media.name ?? 'document'}`}
          className="shrink-0 rounded-full p-1.5 text-text-secondary hover:bg-black/20"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true"><path d="M5 20h14v-2H5v2Zm7-18v12.2l-4.6-4.6L6 11l6 6 6-6-1.4-1.4-4.6 4.6V2h-2Z" /></svg>
        </a>
      ) : (
        overlay
      )}
    </div>
  );
}

function UploadOverlay({ progress, onCancel }: { progress: number; onCancel: () => void }) {
  const circumference = 2 * Math.PI * 18;
  return (
    <button
      onClick={onCancel}
      aria-label={`Uploading, ${Math.round(progress * 100)}%. Cancel`}
      className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-black/60"
    >
      <svg viewBox="0 0 44 44" className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx="22" cy="22" r="18" fill="none" stroke="currentColor" strokeWidth="3"
          className="text-white" strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)} />
      </svg>
      <svg viewBox="0 0 24 24" className="h-4 w-4 fill-white" aria-hidden="true">
        <path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z" />
      </svg>
    </button>
  );
}

function DownloadButton({ size, failed, onClick }: { size: number; failed: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex shrink-0 items-center gap-1.5 rounded-full bg-black/60 px-3 py-2 text-xs text-white"
      aria-label={failed ? 'Download failed, retry' : `Download, ${formatBytes(size)}`}
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true"><path d="M5 20h14v-2H5v2Zm7-18v12.2l-4.6-4.6L6 11l6 6 6-6-1.4-1.4-4.6 4.6V2h-2Z" /></svg>
      {failed ? 'Retry' : formatBytes(size)}
    </button>
  );
}

function Spinner() {
  return (
    <span
      className="block h-9 w-9 animate-spin rounded-full border-2 border-white/30 border-t-white"
      role="status"
      aria-label="Downloading"
    />
  );
}
