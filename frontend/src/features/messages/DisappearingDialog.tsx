import { useState } from 'react';
import type { LocalConversation } from '@/db/db';
import { api, ApiError } from '@/lib/api';
import { applyGroupDetails } from '@/db/conversations';
import { DISAPPEARING_CHOICES } from '@/lib/groupEvents';
import { useAuthStore } from '@/state/authStore';
import { useUiStore } from '@/state/uiStore';
import Modal from '@/ui/Modal';

const OPTIONS = [...DISAPPEARING_CHOICES, { seconds: 0, label: 'Off' }];

/** FR-3.14. Applies to messages sent after the change; earlier ones keep their own timers. */
export default function DisappearingDialog({ conversation }: { conversation: LocalConversation }) {
  const me = useAuthStore((s) => s.user);
  const close = () => useUiStore.getState().setDisappearingOpen(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = conversation.disappearingSeconds ?? 0;
  const role = conversation.members?.find((m) => m.userId === me?.id)?.role;
  const allowed =
    conversation.type === 'DIRECT' ||
    !conversation.onlyAdminsCanEditInfo ||
    role === 'OWNER' ||
    role === 'ADMIN';

  async function choose(seconds: number) {
    if (seconds === current) return close();
    setBusy(true);
    setError(null);
    try {
      await applyGroupDetails(await api.setDisappearing(conversation.id, seconds));
      close();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not change the timer.');
      setBusy(false);
    }
  }

  return (
    <Modal title="Disappearing messages" onClose={close}>
      <p className="mb-4 text-sm text-text-secondary">
        New messages in this chat will be deleted from every device, and from the server, once the
        timer runs out. Anyone can still take a screenshot or copy a message before it goes.
      </p>
      <fieldset disabled={busy || !allowed} className="space-y-1">
        <legend className="sr-only">Message timer</legend>
        {OPTIONS.map((option) => (
          <label
            key={option.seconds}
            className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-panel-hover"
          >
            <input
              type="radio"
              name="timer"
              checked={current === option.seconds}
              onChange={() => void choose(option.seconds)}
              className="h-4 w-4 accent-accent"
            />
            <span className="text-sm">{option.label}</span>
          </label>
        ))}
      </fieldset>
      {!allowed && (
        <p className="mt-3 text-sm text-text-secondary">Only admins can change this group's timer.</p>
      )}
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
    </Modal>
  );
}
