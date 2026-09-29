import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type LocalMessage, type LocalUser } from '@/db/db';
import { api, ApiError } from '@/lib/api';
import { snippetOf } from '@/lib/messageActions';
import { useUiStore } from '@/state/uiStore';
import Modal from '@/ui/Modal';

type Row = { userId: string; deliveredAt?: string; readAt?: string };

/** FR-4.8: who received and who read one of your messages, and when. */
export default function MessageInfoDialog({ message }: { message: LocalMessage }) {
  const close = () => useUiStore.getState().setMessageInfo(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const users = useLiveQuery(() => db.users.toArray(), [], [] as LocalUser[]);

  useEffect(() => {
    if (!message.messageId) return;
    api.messageInfo(message.conversationId, message.messageId)
      .then(setRows)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not load message info'));
  }, [message]);

  const nameOf = (id: string) => users.find((u) => u.id === id)?.displayName ?? 'Unknown';
  const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '—');
  const read = rows?.filter((r) => r.readAt) ?? [];
  const delivered = rows?.filter((r) => !r.readAt && r.deliveredAt) ?? [];
  const pending = rows?.filter((r) => !r.deliveredAt) ?? [];

  const section = (title: string, list: Row[], time: (r: Row) => string) =>
    list.length > 0 && (
      <div className="mt-3">
        <p className="text-xs font-medium uppercase tracking-wide text-accent">{title}</p>
        <ul className="mt-1 space-y-1">
          {list.map((r) => (
            <li key={r.userId} className="flex justify-between gap-3 text-sm">
              <span className="truncate">{nameOf(r.userId)}</span>
              <span className="shrink-0 text-xs text-text-secondary">{time(r)}</span>
            </li>
          ))}
        </ul>
      </div>
    );

  return (
    <Modal title="Message info" onClose={close}>
      <p className="line-clamp-3 rounded-lg bg-panel px-3 py-2 text-sm">{snippetOf(message)}</p>
      {!rows && <p className="mt-3 text-sm text-text-secondary">{error ?? 'Loading…'}</p>}
      {section('Read by', read, (r) => fmt(r.readAt))}
      {section('Delivered to', delivered, (r) => fmt(r.deliveredAt))}
      {section('Not delivered yet', pending, () => '')}
      {rows && (
        <p className="mt-3 text-xs text-text-secondary">
          Read times are hidden for people who turned read receipts off — and for everyone, if you did.
        </p>
      )}
    </Modal>
  );
}
