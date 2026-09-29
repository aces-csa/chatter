import { useState } from 'react';
import type { LocalConversation } from '@/db/db';
import { api, ApiError } from '@/lib/api';
import { toEpochMillis } from '@/lib/time';
import { db } from '@/db/db';
import { isMuted } from '@/lib/notifications';
import { useUiStore } from '@/state/uiStore';
import Modal from '@/ui/Modal';

const CHOICES = [
  { duration: '8h', label: '8 hours' },
  { duration: '1w', label: '1 week' },
  { duration: 'always', label: 'Always' },
] as const;

/** FR-4.6 / FR-8.3. Muted chats still receive everything; they just do not notify. */
export default function MuteDialog({ conversation }: { conversation: LocalConversation }) {
  const close = () => useUiStore.getState().setMuteOpen(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const muted = isMuted(conversation.mutedUntil);

  async function apply(duration: '8h' | '1w' | 'always' | 'off') {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.mute(conversation.id, duration);
      await db.conversations.update(conversation.id, { mutedUntil: toEpochMillis(updated.mutedUntil) });
      close();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not change notifications for this chat.');
      setBusy(false);
    }
  }

  return (
    <Modal title={muted ? 'Notifications muted' : 'Mute notifications'} onClose={close}>
      {muted ? (
        <>
          <p className="text-sm text-text-secondary">
            {conversation.mutedUntil && conversation.mutedUntil > Date.parse('9000-01-01')
              ? 'Muted until you turn it back on.'
              : `Muted until ${new Date(conversation.mutedUntil!).toLocaleString()}.`}
          </p>
          <button
            onClick={() => void apply('off')}
            disabled={busy}
            className="mt-4 w-full rounded-lg bg-accent py-2.5 font-medium text-white disabled:opacity-50"
          >
            Unmute
          </button>
        </>
      ) : (
        <>
          <p className="mb-3 text-sm text-text-secondary">
            Other participants will not see that you muted this chat. Messages still arrive.
          </p>
          <div className="space-y-1">
            {CHOICES.map((choice) => (
              <button
                key={choice.duration}
                onClick={() => void apply(choice.duration)}
                disabled={busy}
                className="w-full rounded-lg px-3 py-2.5 text-left text-sm hover:bg-panel-hover disabled:opacity-50"
              >
                {choice.label}
              </button>
            ))}
          </div>
        </>
      )}
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
    </Modal>
  );
}
