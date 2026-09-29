import { useEffect, useState } from 'react';
import { MediaTooLargeError, prepareMedia, type PreparedMedia } from '@/lib/media/prepare';
import { formatBytes } from '@/lib/media/labels';
import { realtimeService } from '@/realtime/RealtimeService';
import { useUiStore } from '@/state/uiStore';
import Modal from '@/ui/Modal';
import { replyRefFor } from '@/lib/messageActions';

/**
 * Preview and caption before sending. Files are compressed and thumbnailed here, so what the
 * user sees is what goes out. Several files send as several messages; the caption rides on the
 * first, as on WhatsApp.
 */
export default function AttachmentDialog({
  conversationId,
  files,
}: {
  conversationId: string;
  files: File[];
}) {
  const close = () => useUiStore.getState().setPendingAttachments(null);
  const [prepared, setPrepared] = useState<PreparedMedia[] | null>(null);
  const [rejected, setRejected] = useState<string[]>([]);
  const [caption, setCaption] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [viewOnce, setViewOnce] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ok: PreparedMedia[] = [];
      const bad: string[] = [];
      for (const file of files) {
        try {
          ok.push(await prepareMedia(file));
        } catch (error) {
          bad.push(error instanceof MediaTooLargeError ? error.message : `${file.name} could not be read`);
        }
      }
      if (!cancelled) {
        setPrepared(ok);
        setRejected(bad);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [files]);

  const first = prepared?.[0];
  const canViewOnce = prepared?.length === 1 && (first?.descriptor.kind === 'image' || first?.descriptor.kind === 'video');
  useEffect(() => {
    if (!first || (first.descriptor.kind !== 'image' && first.descriptor.kind !== 'video')) return;
    const url = URL.createObjectURL(first.blob);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [first]);

  async function send() {
    if (!prepared?.length) return;
    setSending(true);
    try {
      const replyingTo = useUiStore.getState().replyingTo;
      const replyTo = replyingTo ? replyRefFor(replyingTo) : undefined;
      for (const [index, item] of prepared.entries()) {
        const sendable = canViewOnce && viewOnce
          ? // No thumbnail: a preview of a view-once photo would defeat it.
            { ...item, descriptor: { ...item.descriptor, viewOnce: true, thumbnail: undefined } }
          : item;
        await realtimeService.composeMedia(conversationId, sendable, index === 0 ? caption.trim() : '', {
          replyTo: index === 0 ? replyTo : undefined,
        });
      }
      useUiStore.getState().setReplyingTo(null);
      close();
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal title={files.length > 1 ? `Send ${files.length} files` : 'Send file'} onClose={close} wide>
      {!prepared && <p className="py-8 text-center text-sm text-text-secondary">Preparing…</p>}

      {first && previewUrl && first.descriptor.kind === 'image' && (
        <img src={previewUrl} alt="Preview" className="mx-auto max-h-72 rounded-md object-contain" />
      )}
      {first && previewUrl && first.descriptor.kind === 'video' && (
        <video src={previewUrl} controls className="mx-auto max-h-72 rounded-md" />
      )}

      {prepared && prepared.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {prepared.map((item, index) => (
            <li key={index} className="flex justify-between gap-3 text-text-secondary">
              <span className="truncate">{item.descriptor.name}</span>
              <span className="shrink-0">{formatBytes(item.descriptor.size)}</span>
            </li>
          ))}
        </ul>
      )}
      {rejected.map((reason) => (
        <p key={reason} className="mt-2 text-sm text-red-300">{reason}</p>
      ))}

      {canViewOnce && (
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={viewOnce} onChange={(e) => setViewOnce(e.target.checked)} className="h-4 w-4 accent-accent" />
          View once — they can open it one time, then it is gone from their device
        </label>
      )}
      {prepared && prepared.length > 0 && (
        <div className="mt-4 flex items-end gap-2">
          <input
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void send()}
            placeholder="Add a caption"
            aria-label="Caption"
            autoFocus
            maxLength={4096}
            className="flex-1 rounded-lg bg-panel px-3 py-2.5 text-sm outline-none"
          />
          <button
            onClick={() => void send()}
            disabled={sending}
            aria-label="Send"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-white disabled:opacity-50"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true"><path d="M2 21l21-9L2 3v7l15 2-15 2z" /></svg>
          </button>
        </div>
      )}
      <p className="mt-3 text-xs text-text-secondary">
        Encrypted on this device before upload. Up to 100 MB per file.
      </p>
    </Modal>
  );
}
