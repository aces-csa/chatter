import type { MediaDescriptor } from '@/db/db';

/** Chat-list preview for an attachment: the caption if there is one, else what it is. */
export function mediaPreview(media: MediaDescriptor, caption: string): string {
  if (media.viewOnce) return media.kind === 'video' ? 'View once video' : 'View once photo';
  if (caption.trim()) return caption;
  switch (media.kind) {
    case 'image':
      return media.mime === 'image/gif' ? 'GIF' : 'Photo';
    case 'video':
      return 'Video';
    case 'audio':
      return media.voice ? `Voice message (${formatDuration(media.durationMs) || '0:00'})` : 'Audio';
    case 'document':
      return media.name ?? 'Document';
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number | undefined): string {
  if (!ms) return '';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
