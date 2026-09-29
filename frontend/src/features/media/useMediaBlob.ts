import { useCallback, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type LocalMessage } from '@/db/db';
import { loadMedia } from '@/lib/media/transfer';
import { localBlobId } from '@/realtime/MediaUploads';

export type MediaLoadState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * An object URL for a message's attachment. Reads the local cache first (our own uploads and
 * anything already downloaded); otherwise downloads and decrypts on demand, or at once when
 * {@code autoLoad} is set.
 */
export function useMediaBlob(message: LocalMessage, autoLoad: boolean) {
  const media = message.media;
  const row = useLiveQuery(
    async () =>
      (media?.mediaId ? await db.mediaBlobs.get(media.mediaId) : undefined) ??
      (await db.mediaBlobs.get(localBlobId(message.clientMessageId))),
    [media?.mediaId, message.clientMessageId],
  );
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<MediaLoadState>('idle');

  useEffect(() => {
    if (!row) return;
    const objectUrl = URL.createObjectURL(row.blob);
    setUrl(objectUrl);
    setState('ready');
    return () => URL.revokeObjectURL(objectUrl);
  }, [row]);

  const load = useCallback(() => {
    if (!media?.mediaId || !media.key || !media.digest) return;
    setState('loading');
    // Success lands in IndexedDB, which the live query above picks up.
    loadMedia(media).catch((error) => {
      console.warn('[media] download failed', error);
      setState('error');
    });
  }, [media]);

  useEffect(() => {
    if (autoLoad && row === undefined && state === 'idle' && media?.mediaId && media.digest) {
      load();
    }
  }, [autoLoad, row, state, media?.mediaId, media?.digest, load]);

  return { url, state: row ? ('ready' as const) : state, load };
}
