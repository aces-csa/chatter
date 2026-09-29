import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type LocalMessage } from '@/db/db';
import { formatBytes } from '@/lib/media/labels';
import { useUiStore } from '@/state/uiStore';
import Modal from '@/ui/Modal';

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')]+/gi;
type Tab = 'media' | 'docs' | 'links';

/**
 * FR-5.6: everything shared in a chat, in three tabs. Built from this device's messages -- the
 * server cannot list them, it does not know which messages carry media or links.
 */
export default function MediaGalleryDialog({ conversationId }: { conversationId: string }) {
  const close = () => useUiStore.getState().setGalleryOpen(false);
  const [tab, setTab] = useState<Tab>('media');
  const messages = useLiveQuery(
    () => db.messages.where('conversationId').equals(conversationId)
      .filter((m) => !m.control && !m.deletedForAll && !m.undecryptable).toArray(),
    [conversationId],
    [] as LocalMessage[],
  );
  const newest = [...messages].sort((a, b) => b.createdAt - a.createdAt);
  const media = newest.filter((m) => (m.media?.kind === 'image' || m.media?.kind === 'video') && !m.media.viewOnce);
  const docs = newest.filter((m) => m.media && (m.media.kind === 'document' || (m.media.kind === 'audio' && !m.media.voice)));
  const links = newest.flatMap((m) => (m.body.match(URL_PATTERN) ?? []).map((url) => ({ url, message: m })));

  const open = (m: LocalMessage) => {
    if (!m.messageId) return;
    close();
    useUiStore.getState().jumpToMessage(m.messageId);
  };

  return (
    <Modal title="Media, links and docs" onClose={close} wide>
      <div className="mb-3 flex rounded-lg bg-panel p-1 text-sm">
        {(['media', 'docs', 'links'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 rounded-md py-1.5 capitalize ${tab === t ? 'bg-panel-hover font-medium' : 'text-text-secondary'}`}>
            {t} ({t === 'media' ? media.length : t === 'docs' ? docs.length : links.length})
          </button>
        ))}
      </div>
      {tab === 'media' && (
        <div className="grid grid-cols-3 gap-1">
          {media.map((m) => (
            <button key={m.clientMessageId} onClick={() => open(m)} className="relative aspect-square overflow-hidden rounded bg-panel"
              aria-label={`${m.media!.kind === 'video' ? 'Video' : 'Photo'} from ${new Date(m.createdAt).toLocaleDateString()}`}>
              {m.media!.thumbnail && <img src={m.media!.thumbnail} alt="" className="h-full w-full object-cover" />}
              {m.media!.kind === 'video' && <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[10px] text-white">▶</span>}
            </button>
          ))}
        </div>
      )}
      {tab === 'docs' && (
        <ul className="space-y-1">
          {docs.map((m) => (
            <li key={m.clientMessageId}>
              <button onClick={() => open(m)} className="flex w-full justify-between gap-3 rounded px-2 py-2 text-left text-sm hover:bg-panel-hover">
                <span className="truncate">{m.media!.name ?? 'Document'}</span>
                <span className="shrink-0 text-xs text-text-secondary">{formatBytes(m.media!.size)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {tab === 'links' && (
        <ul className="space-y-1">
          {links.map(({ url, message }, i) => (
            <li key={`${message.clientMessageId}-${i}`} className="flex items-center justify-between gap-3 rounded px-2 py-2 text-sm hover:bg-panel-hover">
              {/* Opening a link is the user's choice; no preview is fetched (that would leak it). */}
              <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="truncate text-accent hover:underline">{url}</a>
              <button onClick={() => open(message)} className="shrink-0 text-xs text-text-secondary hover:underline">Show</button>
            </li>
          ))}
        </ul>
      )}
      {(tab === 'media' ? media : tab === 'docs' ? docs : links).length === 0 && (
        <p className="py-8 text-center text-sm text-text-secondary">Nothing here yet.</p>
      )}
    </Modal>
  );
}
