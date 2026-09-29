import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type LocalConversation, type LocalMessage } from '@/db/db';
import { realtimeService } from '@/realtime/RealtimeService';
import { useAuthStore } from '@/state/authStore';
import { useUiStore } from '@/state/uiStore';
import Modal from '@/ui/Modal';

/** FR-3.8: forward one or more messages to one or more chats. */
export default function ForwardDialog({ messages }: { messages: LocalMessage[] }) {
  const me = useAuthStore((s) => s.user);
  const close = () => useUiStore.getState().setForwarding(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const conversations = useLiveQuery(() => db.conversations.toArray(), [], [] as LocalConversation[]);
  const users = useLiveQuery(() => db.users.toArray(), [], []);
  const nameFor = useMemo(() => {
    const byId = new Map(users.map((u) => [u.id, u.displayName]));
    return (c: LocalConversation) =>
      c.type === 'GROUP'
        ? c.subject ?? 'Group'
        : byId.get(c.participantIds.find((id) => id !== me?.id) ?? '') ?? 'Unknown contact';
  }, [users, me?.id]);

  // Only chats you can actually post in; recent first.
  const candidates = conversations
    .filter((c) => !c.left)
    .filter((c) => {
      if (!c.onlyAdminsCanPost) return true;
      const role = c.members?.find((m) => m.userId === me?.id)?.role;
      return role === 'OWNER' || role === 'ADMIN';
    })
    .filter((c) => nameFor(c).toLowerCase().includes(filter.trim().toLowerCase()))
    .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await realtimeService.forward(messages, chosen);
      useUiStore.getState().setSelection(null);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not forward.');
      setBusy(false);
    }
  }

  return (
    <Modal title={`Forward ${messages.length === 1 ? 'message' : `${messages.length} messages`}`} onClose={close}>
      <input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Search chats"
        aria-label="Search chats"
        autoFocus
        className="mb-2 w-full rounded-lg bg-panel px-3 py-2 text-sm outline-none"
      />
      <ul className="max-h-80 space-y-0.5 overflow-y-auto">
        {candidates.map((c) => (
          <li key={c.id}>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-panel-hover">
              <input
                type="checkbox"
                checked={chosen.includes(c.id)}
                onChange={() =>
                  setChosen(chosen.includes(c.id) ? chosen.filter((id) => id !== c.id) : [...chosen, c.id])
                }
                className="h-4 w-4 accent-accent"
              />
              <span className="truncate text-sm">{nameFor(c)}</span>
            </label>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
      <button
        onClick={() => void send()}
        disabled={busy || chosen.length === 0}
        className="mt-3 w-full rounded-lg bg-accent py-2.5 font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Forwarding…' : `Forward${chosen.length ? ` to ${chosen.length}` : ''}`}
      </button>
    </Modal>
  );
}
