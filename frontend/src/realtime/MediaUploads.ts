import { db } from '@/db/db';
import { api } from '@/lib/api';
import { encryptMedia } from '@/lib/media/mediaCrypto';
import { UploadCancelledError, uploadEncrypted } from '@/lib/media/transfer';

const PROGRESS_WRITE_MS = 250;

export function localBlobId(clientMessageId: string): string {
  return `local:${clientMessageId}`;
}

/**
 * Runs attachment uploads for outgoing messages. The message waits in the outbox, flagged
 * awaitingUpload, until its blob is in the bucket and shared with the conversation; only then
 * does the (small) message itself go out. A reload mid-upload resumes on the next start.
 */
export class MediaUploads {
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly onReady: () => void) {}

  async resumeAll(): Promise<void> {
    const unfinished = await db.messages
      .filter((m) => !!m.upload && !m.upload.done && m.state === 'PENDING')
      .toArray();
    unfinished.forEach((m) => this.run(m.clientMessageId));
  }

  stopAll(): void {
    // Aborting in-flight parts is safe: the next start resumes from what the store holds.
    this.running.forEach((controller) => controller.abort());
    this.running.clear();
  }

  run(clientMessageId: string): void {
    if (this.running.has(clientMessageId)) return;
    const controller = new AbortController();
    this.running.set(clientMessageId, controller);
    void this.upload(clientMessageId, controller.signal)
      .catch(async (error) => {
        if (error instanceof UploadCancelledError || controller.signal.aborted) return;
        console.warn('[media] upload failed', clientMessageId, error);
        await db.transaction('rw', db.messages, db.outbox, async () => {
          await db.messages.update(clientMessageId, {
            state: 'FAILED',
            'upload.error': String(error instanceof Error ? error.message : error),
          });
          await db.outbox.delete(clientMessageId);
        });
      })
      .finally(() => this.running.delete(clientMessageId));
  }

  /** Stops the upload and removes the message; the half-uploaded blob is discarded server-side. */
  async cancel(clientMessageId: string): Promise<void> {
    this.running.get(clientMessageId)?.abort();
    this.running.delete(clientMessageId);
    const message = await db.messages.get(clientMessageId);
    if (message?.media?.mediaId && !message.upload?.done) {
      await api.discardMedia(message.media.mediaId).catch(() => undefined);
    }
    await db.transaction('rw', db.messages, db.outbox, db.mediaBlobs, async () => {
      await db.messages.delete(clientMessageId);
      await db.outbox.delete(clientMessageId);
      await db.mediaBlobs.delete(localBlobId(clientMessageId));
    });
  }

  private async upload(clientMessageId: string, signal: AbortSignal): Promise<void> {
    const message = await db.messages.get(clientMessageId);
    if (!message?.media?.key || !message.upload || message.upload.done) return;
    const local = await db.mediaBlobs.get(localBlobId(clientMessageId));
    if (!local) throw new Error('The file for this message is no longer on this device');

    const encrypted = await encryptMedia(await local.blob.arrayBuffer(), message.media.key, message.upload.iv);
    await db.messages.update(clientMessageId, { 'media.digest': encrypted.digest });

    let lastWrite = 0;
    const mediaId = await uploadEncrypted(encrypted.ciphertext, {
      mediaId: message.media.mediaId,
      signal,
      onStarted: async (id) => {
        await db.messages.update(clientMessageId, { 'media.mediaId': id });
      },
      onProgress: (fraction) => {
        const now = Date.now();
        if (now - lastWrite < PROGRESS_WRITE_MS && fraction < 1) return;
        lastWrite = now;
        void db.messages.update(clientMessageId, { 'upload.progress': fraction });
      },
    });
    if (signal.aborted) throw new UploadCancelledError();

    await api.shareMedia(mediaId, message.conversationId);

    await db.transaction('rw', db.messages, db.outbox, db.mediaBlobs, async () => {
      // Re-key the cached plaintext under its server id, where every other device's copy lives.
      // View-once media keeps no copy at all once sent, not even for its sender.
      if (!message.media?.viewOnce) {
        await db.mediaBlobs.put({ id: mediaId, blob: local.blob, savedAt: Date.now() });
      }
      await db.mediaBlobs.delete(localBlobId(clientMessageId));
      await db.messages.update(clientMessageId, {
        'media.mediaId': mediaId,
        'upload.done': true,
        'upload.progress': 1,
        'upload.error': undefined,
      });
      await db.outbox.update(clientMessageId, { awaitingUpload: false, nextAttemptAt: 0 });
    });
    this.onReady();
  }
}
