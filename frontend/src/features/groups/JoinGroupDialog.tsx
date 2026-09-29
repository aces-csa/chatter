import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { saveConversation } from '@/db/conversations';
import { useUiStore } from '@/state/uiStore';
import Modal from '@/ui/Modal';

type Preview = Awaited<ReturnType<typeof api.invitePreview>>;

/** Opened from a /?join=CODE link. Shows the group before committing to it. */
export default function JoinGroupDialog({ code }: { code: string }) {
  const close = () => useUiStore.getState().setJoinCode(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .invitePreview(code)
      .then(setPreview)
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not open this invite link.'),
      );
  }, [code]);

  async function join() {
    setBusy(true);
    setError(null);
    try {
      const group = await api.joinViaInvite(code);
      await saveConversation(group);
      useUiStore.getState().setActiveConversation(group.id);
      close();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not join this group.');
      setBusy(false);
    }
  }

  function open() {
    if (preview) useUiStore.getState().setActiveConversation(preview.conversationId);
    close();
  }

  return (
    <Modal title="Group invite" onClose={close}>
      {!preview && !error && <p className="py-6 text-center text-sm text-text-secondary">Loading…</p>}
      {preview && (
        <div className="text-center">
          <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-panel-hover text-xl">
            {(preview.subject ?? '?').slice(0, 2).toUpperCase()}
          </div>
          <p className="text-lg font-medium">{preview.subject}</p>
          <p className="text-sm text-text-secondary">
            Group · {preview.memberCount} {preview.memberCount === 1 ? 'member' : 'members'}
          </p>
          {preview.description && (
            <p className="mt-3 whitespace-pre-wrap text-sm">{preview.description}</p>
          )}
          <p className="mt-4 text-xs text-text-secondary">
            You'll only be able to read messages sent after you join.
          </p>
          <button
            onClick={() => void (preview.alreadyMember ? open() : join())}
            disabled={busy}
            className="mt-4 w-full rounded-lg bg-accent py-2.5 font-medium text-white disabled:opacity-50"
          >
            {preview.alreadyMember ? 'Open group' : busy ? 'Joining…' : 'Join group'}
          </button>
        </div>
      )}
      {error && <p className="text-sm text-red-300">{error}</p>}
    </Modal>
  );
}
