import React, { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { saveConversation } from '@/db/conversations';
import { useAuthStore } from '@/state/authStore';
import { useUiStore } from '@/state/uiStore';
import Modal from '@/ui/Modal';
import PersonPicker from './PersonPicker';

export default function NewGroupDialog() {
  const me = useAuthStore((s) => s.user);
  const close = () => useUiStore.getState().setNewGroupOpen(false);
  const [subject, setSubject] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const group = await api.createGroup(subject.trim(), members);
      await saveConversation(group);
      useUiStore.getState().setActiveConversation(group.id);
      close();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create the group.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New group" onClose={close}>
      <form onSubmit={create}>
        <label className="block text-sm text-text-secondary">
          Group subject
          <input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            maxLength={100}
            autoFocus
            required
            className="mt-1 w-full rounded-lg border border-stroke bg-panel px-3 py-2.5 text-text-primary outline-none focus:border-accent"
          />
        </label>

        <p className="mb-2 mt-4 text-sm text-text-secondary">
          Participants{members.length > 0 ? ` · ${members.length} selected` : ''}
        </p>
        <PersonPicker selected={members} onChange={setMembers} exclude={me ? [me.id] : []} />

        {error && <p className="mt-3 text-sm text-red-300">{error}</p>}

        <button
          type="submit"
          disabled={busy || !subject.trim() || members.length === 0}
          className="mt-4 w-full rounded-lg bg-accent py-2.5 font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create group'}
        </button>
      </form>
    </Modal>
  );
}
