import { db, type MediaDescriptor } from '@/db/db';
import { api, ApiError, type UploadTicket } from '@/lib/api';
import { decryptMedia } from './mediaCrypto';

const PARALLEL_PARTS = 3;

export class UploadCancelledError extends Error {}

/**
 * Multipart upload straight to the bucket (DD-9, FR-5.5): parts go up in parallel, each with its
 * own progress, and an upload that was interrupted resumes from the parts the store already has.
 *
 * @param mediaId set when resuming an upload started earlier
 * @returns the server media id
 */
export async function uploadEncrypted(
  ciphertext: Uint8Array,
  options: {
    mediaId?: string;
    signal: AbortSignal;
    onStarted: (mediaId: string) => Promise<void>;
    onProgress: (fraction: number) => void;
  },
): Promise<string> {
  let ticket: UploadTicket | null = null;
  if (options.mediaId) {
    try {
      ticket = await api.resumeUpload(options.mediaId);
    } catch (error) {
      // Finished already (a lost response to complete) -- nothing left to send.
      if (error instanceof ApiError && error.code === 'VALIDATION_FAILED') return options.mediaId;
      // Reaped or unknown: start over below.
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
  }
  if (!ticket) {
    ticket = await api.startUpload(ciphertext.byteLength);
    await options.onStarted(ticket.mediaId);
  }

  const partCount = Math.ceil(ticket.sizeBytes / ticket.partSize);
  const loaded = new Map<number, number>();
  for (const done of ticket.alreadyUploaded) {
    loaded.set(done.partNumber, partBytes(done.partNumber, ticket, partCount));
  }
  const report = () =>
    options.onProgress(
      [...loaded.values()].reduce((sum, bytes) => sum + bytes, 0) / ticket.sizeBytes,
    );
  report();

  const etags = new Map<number, string>(ticket.alreadyUploaded.map((p) => [p.partNumber, p.etag]));
  const queue = [...ticket.parts];
  const worker = async () => {
    for (let part = queue.shift(); part; part = queue.shift()) {
      const start = (part.partNumber - 1) * ticket.partSize;
      const body = ciphertext.subarray(start, Math.min(start + ticket.partSize, ciphertext.byteLength));
      const etag = await putPart(part.url, body, options.signal, (bytes) => {
        loaded.set(part.partNumber, bytes);
        report();
      });
      etags.set(part.partNumber, etag);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_PARTS, queue.length) }, worker));

  await api.completeUpload(
    ticket.mediaId,
    [...etags.entries()].map(([partNumber, etag]) => ({ partNumber, etag })),
  );
  options.onProgress(1);
  return ticket.mediaId;
}

function partBytes(partNumber: number, ticket: UploadTicket, partCount: number): number {
  return partNumber < partCount ? ticket.partSize : ticket.sizeBytes - ticket.partSize * (partCount - 1);
}

/** XHR rather than fetch: fetch still cannot report upload progress. */
function putPart(
  url: string,
  body: Uint8Array,
  signal: AbortSignal,
  onBytes: (loaded: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (event) => onBytes(event.loaded);
    xhr.onload = () => {
      const etag = xhr.getResponseHeader('ETag');
      if (xhr.status >= 200 && xhr.status < 300 && etag) {
        onBytes(body.byteLength);
        resolve(etag);
      } else {
        reject(new Error(`Part upload failed (${xhr.status}${etag ? '' : ', no ETag exposed'})`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onabort = () => reject(new UploadCancelledError('Upload cancelled'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    if (signal.aborted) {
      xhr.abort();
      return;
    }
    xhr.send(body.slice());
  });
}

const inFlight = new Map<string, Promise<Blob>>();

/**
 * Fetches, verifies and decrypts an attachment, once. The decrypted blob is cached in IndexedDB,
 * so scrolling back never re-downloads, and concurrent requests for the same media share one
 * transfer.
 */
export function loadMedia(media: MediaDescriptor): Promise<Blob> {
  const { mediaId, key, digest } = media;
  if (!mediaId || !key || !digest) return Promise.reject(new Error('Attachment is not downloadable'));

  const existing = inFlight.get(mediaId);
  if (existing) return existing;

  const job = (async () => {
    const cached = await db.mediaBlobs.get(mediaId);
    if (cached) return cached.blob;

    const { url } = await api.mediaUrl(mediaId);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    const plaintext = await decryptMedia(await response.arrayBuffer(), key, digest);
    const blob = new Blob([plaintext], { type: media.mime });
    await db.mediaBlobs.put({ id: mediaId, blob, savedAt: Date.now() });
    return blob;
  })();

  inFlight.set(mediaId, job);
  void job.finally(() => inFlight.delete(mediaId)).catch(() => undefined);
  return job;
}
