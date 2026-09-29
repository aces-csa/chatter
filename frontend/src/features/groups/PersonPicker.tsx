import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type LocalUser } from '@/db/db';
import { api, ApiError } from '@/lib/api';

/**
 * Choose people: everyone this device already knows, plus a phone-number lookup for anyone
 * else. Found users are cached locally so they appear in the list from then on.
 */
export default function PersonPicker({
  selected,
  onChange,
  exclude,
}: {
  selected: string[];
  onChange: (userIds: string[]) => void;
  /** Already in the group, or yourself. */
  exclude: string[];
}) {
  const [phone, setPhone] = useState('+');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');

  const known = useLiveQuery(() => db.users.toArray(), [], [] as LocalUser[]);
  const candidates = useMemo(() => {
    const excluded = new Set(exclude);
    const needle = filter.trim().toLowerCase();
    return known
      .filter((user) => !excluded.has(user.id))
      .filter(
        (user) =>
          !needle ||
          user.displayName.toLowerCase().includes(needle) ||
          user.phoneE164.includes(needle),
      )
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [known, exclude, filter]);

  function toggle(userId: string) {
    onChange(
      selected.includes(userId) ? selected.filter((id) => id !== userId) : [...selected, userId],
    );
  }

  async function lookup(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const found = await api.syncContacts([phone.trim()]);
      if (found.length === 0) {
        setError('Nobody is registered with that number yet.');
        return;
      }
      await db.users.bulkPut(found);
      const addable = found.filter((user) => !exclude.includes(user.id)).map((user) => user.id);
      if (addable.length === 0) {
        setError('Already in this group.');
        return;
      }
      onChange([...new Set([...selected, ...addable])]);
      setPhone('+');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Lookup failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <form onSubmit={lookup} className="flex gap-2">
        <input
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          placeholder="+919876543210"
          inputMode="tel"
          aria-label="Add by phone number"
          className="flex-1 rounded-lg border border-stroke bg-panel px-3 py-2 outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={busy || phone.trim().length < 4}
          className="rounded-lg border border-stroke px-3 text-sm hover:bg-panel-hover disabled:opacity-50"
        >
          Find
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-300">{error}</p>}

      {known.length > 5 && (
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter people you know"
          aria-label="Filter people"
          className="mt-3 w-full rounded-lg bg-panel px-3 py-2 text-sm outline-none"
        />
      )}

      <ul className="mt-3 space-y-0.5">
        {candidates.length === 0 && (
          <li className="px-1 py-2 text-sm text-text-secondary">
            Nobody else yet — find people by phone number above.
          </li>
        )}
        {candidates.map((user) => (
          <li key={user.id}>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-panel-hover">
              <input
                type="checkbox"
                checked={selected.includes(user.id)}
                onChange={() => toggle(user.id)}
                className="h-4 w-4 accent-accent"
              />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{user.displayName}</span>
                <span className="block truncate text-xs text-text-secondary">{user.phoneE164}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
