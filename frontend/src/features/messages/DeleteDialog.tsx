import { useState } from 'react';
import type { LocalMessage } from '@/db/db';
import { canDeleteForEveryone } from '@/lib/messageActions';
import { realtimeService } from '@/realtime/RealtimeService';
import { useAuthStore } from '@/state/authStore';
import { useUiStore } from '@/state/uiStore';
import Modal from '@/ui/Modal';

/**
 * FR-3.11. "For everyone" is offered only when every selected message qualifies -- yours, sent,
 * under two hours old -- because a half-applied bulk delete is worse than none.
 */
export default function DeleteDialog({ messages }: { messages: LocalMessage[] }) {
  const selfUserId = useAuthStore((s) => s.user?.id ?? '');
  const close = () => useUiStore.getState().setDeleting(null);
  const [busy, setBusy] = useState(false);
  const forEveryone = messages.every((m) => canDeleteForEveryone(m, selfUserId));
  const count = messages.length === 1 ? 'this message' : `${messages.length} messages`;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
      useUiStore.getState().setSelection(null);
      close();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Delete ${count}?`} onClose={close}>
      <div className="space-y-2">
        {forEveryone && (
          <button
            disabled={busy}
            onClick={() => void run(() => realtimeService.deleteForEveryone(messages))}
            className="w-full rounded-lg border border-stroke px-4 py-2.5 text-left text-sm text-red-300 hover:bg-panel-hover"
          >
            Delete for everyone
            <span className="block text-xs text-text-secondary">
              Removed from every device in this chat, and from the server. People may already have seen it.
            </span>
          </button>
        )}
        <button
          disabled={busy}
          onClick={() => void run(() => realtimeService.deleteForMe(messages))}
          className="w-full rounded-lg border border-stroke px-4 py-2.5 text-left text-sm text-red-300 hover:bg-panel-hover"
        >
          Delete for me
          <span className="block text-xs text-text-secondary">Only from this device.</span>
        </button>
        <button onClick={close} className="w-full py-2 text-sm text-text-secondary">
          Cancel
        </button>
      </div>
    </Modal>
  );
}
