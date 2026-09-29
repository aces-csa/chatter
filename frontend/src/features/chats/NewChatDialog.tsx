import React, { useState } from 'react';
import { api, ApiError, type UserDto } from '@/lib/api';
import { db } from '@/db/db';
import { useUiStore } from '@/state/uiStore';
import { saveConversation } from '@/db/conversations';

export default function NewChatDialog() {
  const [phone, setPhone] = useState('+');
  const [results, setResults] = useState<UserDto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => useUiStore.getState().setNewChatOpen(false);
  const setActive = useUiStore((s) => s.setActiveConversation);

  async function search(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const found = await api.syncContacts([phone.trim()]);
      setResults(found);
      if (found.length === 0) {
        setError('Nobody is registered with that number yet.');
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Lookup failed.');
    } finally {
      setBusy(false);
    }
  }

  async function startChat(user: UserDto) {
    setBusy(true);
    setError(null);
    try {
      const conversation = await api.createDirect(user.id);
      await db.users.put(user);
      await saveConversation(conversation);
      setActive(conversation.id);
      close();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not start that conversation.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      role="dialog"
      aria-modal="true"
      aria-label="New chat"
      onClick={close}
    >
      <div
        className="w-full max-w-md rounded-xl border border-stroke bg-panel-alt p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-medium">New chat</h2>
          <button onClick={close} aria-label="Close" className="text-text-secondary hover:text-text-primary">
            <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true">
              <path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z" />
            </svg>
          </button>
        </div>

        <form onSubmit={search} className="flex gap-2">
          <input
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="+919876543210"
            inputMode="tel"
            autoFocus
            className="flex-1 rounded-lg border border-stroke bg-panel px-3 py-2.5 outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-accent px-4 font-medium text-white disabled:opacity-50"
          >
            Find
          </button>
        </form>

        {error && <p className="mt-3 text-sm text-red-300">{error}</p>}

        {results && results.length > 0 && (
          <ul className="mt-4 space-y-1">
            {results.map((user) => (
              <li key={user.id}>
                <button
                  onClick={() => void startChat(user)}
                  disabled={busy}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-panel-hover"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-panel-hover text-sm">
                    {user.displayName.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{user.displayName}</span>
                    <span className="block truncate text-sm text-text-secondary">
                      {user.phoneE164}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
