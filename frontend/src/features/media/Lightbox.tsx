import { useEffect } from 'react';
import type { MediaKind } from '@/db/db';

/** Full-screen viewer for a photo or video. */
export default function Lightbox({
  url,
  kind,
  name,
  onClose,
  noSave = false,
}: {
  url: string;
  kind: MediaKind;
  name?: string;
  onClose: () => void;
  /** View-once media: no save button (the browser can still screenshot). */
  noSave?: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/95"
      role="dialog"
      aria-modal="true"
      aria-label={name ?? (kind === 'video' ? 'Video' : 'Photo')}
      onClick={onClose}
    >
      <div className="flex shrink-0 items-center justify-end gap-2 p-3" onClick={(e) => e.stopPropagation()}>
        {!noSave && <a
          href={url}
          download={name ?? (kind === 'video' ? 'video' : 'photo')}
          className="rounded-full p-2 text-white/80 hover:bg-white/10"
          aria-label="Save"
        >
          <svg viewBox="0 0 24 24" className="h-6 w-6 fill-current" aria-hidden="true"><path d="M5 20h14v-2H5v2Zm7-18v12.2l-4.6-4.6L6 11l6 6 6-6-1.4-1.4-4.6 4.6V2h-2Z" /></svg>
        </a>}
        <button onClick={onClose} className="rounded-full p-2 text-white/80 hover:bg-white/10" aria-label="Close">
          <svg viewBox="0 0 24 24" className="h-6 w-6 fill-current" aria-hidden="true">
            <path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z" />
          </svg>
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        {kind === 'video' ? (
          <video src={url} controls controlsList={noSave ? 'nodownload' : undefined} autoPlay className="max-h-full max-w-full" onClick={(e) => e.stopPropagation()} />
        ) : (
          <img src={url} alt={name ?? 'Photo'} className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} />
        )}
      </div>
    </div>
  );
}
