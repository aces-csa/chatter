import { useLiveQuery } from 'dexie-react-hooks';
import { db, type LocalMessage } from '@/db/db';
import { snippetOf } from '@/lib/messageActions';
import { useAuthStore } from '@/state/authStore';
import { useUiStore } from '@/state/uiStore';
import Modal from '@/ui/Modal';

/** FR-3.9: every starred message across chats, newest star first; tap to jump to it. */
export default function StarredDialog() {
  const me = useAuthStore((s) => s.user);
  const close = () => useUiStore.getState().setStarredOpen(false);
  const starred = useLiveQuery(
    () => db.messages.where('starredAt').above(0).sortBy('starredAt'),
    [],
    [] as LocalMessage[],
  );
  const users = useLiveQuery(() => db.users.toArray(), [], []);
  const conversations = useLiveQuery(() => db.conversations.toArray(), [], []);

  const nameOf = (id: string) => (id === me?.id ? 'You' : users.find((u) => u.id === id)?.displayName ?? 'Unknown');
  const chatName = (conversationId: string) => {
    const c = conversations.find((x) => x.id === conversationId);
    if (!c) return '';
    if (c.type === 'GROUP') return c.subject ?? 'Group';
    return nameOf(c.participantIds.find((id) => id !== me?.id) ?? '');
  };

  return (
    <Modal title="Starred messages" onClose={close} wide>
      {starred.length === 0 ? (
        <p className="py-8 text-center text-sm text-text-secondary">
          Star messages to find them here later. Stars stay on this device.
        </p>
      ) : (
        <ul className="space-y-1">
          {[...starred].reverse().map((m) => (
            <li key={m.clientMessageId}>
              <button
                onClick={() => m.messageId && useUiStore.getState().openMessage(m.conversationId, m.messageId)}
                className="w-full rounded-lg px-3 py-2 text-left hover:bg-panel-hover"
              >
                <span className="flex justify-between gap-2 text-xs text-text-secondary">
                  <span className="truncate">
                    {nameOf(m.senderId)} · {chatName(m.conversationId)}
                  </span>
                  <span className="shrink-0">{new Date(m.createdAt).toLocaleDateString()}</span>
                </span>
                <span className="line-clamp-2 text-sm">{snippetOf(m)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
