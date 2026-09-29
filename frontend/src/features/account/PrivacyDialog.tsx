import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type LocalUser } from '@/db/db';
import { api, ApiError, type Audience, type PrivacySettings } from '@/lib/api';
import { blockedIds, loadBlocks, setBlocked } from '@/lib/chatState';
import { cachePrivacy } from '@/lib/quietHours';
import { useUiStore } from '@/state/uiStore';
import Modal from '@/ui/Modal';

const AUDIENCES: Array<{ value: Audience; label: string }> = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'contacts', label: 'My contacts' },
  { value: 'nobody', label: 'Nobody' },
];

const toTime = (minutes: number | null) =>
  minutes == null ? '' : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const fromTime = (value: string) => {
  const [h, m] = value.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

/** FR-2.2-2.4 and FR-8.4: who sees what, read receipts, blocked people, quiet hours. */
export default function PrivacyDialog() {
  const close = () => useUiStore.getState().setPrivacyOpen(false);
  const [settings, setSettings] = useState<PrivacySettings | null>(null);
  const [blocked, setBlockedList] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const users = useLiveQuery(() => db.users.toArray(), [], [] as LocalUser[]);

  useEffect(() => {
    void api.privacy().then(setSettings).catch(() => setError('Could not load your settings'));
    void loadBlocks().then(setBlockedList).catch(() => blockedIds().then(setBlockedList));
  }, []);

  async function save(next: PrivacySettings) {
    setSettings(next);
    setError(null);
    setSaved(false);
    try {
      const stored = await api.updatePrivacy(next);
      setSettings(stored);
      await cachePrivacy(stored);
      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save');
    }
  }

  const nameOf = (id: string) => users.find((u) => u.id === id)?.displayName ?? 'Unknown';
  const quietOn = settings?.quietStart != null;

  return (
    <Modal title="Privacy" onClose={close}>
      {!settings ? (
        <p className="py-6 text-center text-sm text-text-secondary">{error ?? 'Loading…'}</p>
      ) : (
        <>
          {([
            ['lastSeen', 'Last seen and online'],
            ['profilePhoto', 'Profile photo'],
            ['about', 'About'],
          ] as const).map(([key, label]) => (
            <label key={key} className="flex items-center justify-between gap-3 py-2 text-sm">
              {label}
              <select
                value={settings[key]}
                onChange={(e) => void save({ ...settings, [key]: e.target.value as Audience })}
                className="rounded-md border border-stroke bg-panel px-2 py-1 text-sm"
              >
                {AUDIENCES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </label>
          ))}
          <label className="flex items-start justify-between gap-3 border-t border-stroke py-3 text-sm">
            <span>
              Read receipts
              <span className="block text-xs text-text-secondary">
                If off, you won't send or receive read receipts. Groups always show delivery.
              </span>
            </span>
            <input type="checkbox" role="switch" checked={settings.readReceipts}
              onChange={(e) => void save({ ...settings, readReceipts: e.target.checked })} className="mt-1 h-4 w-4 accent-accent" />
          </label>

          <div className="border-t border-stroke py-3 text-sm">
            <label className="flex items-center justify-between gap-3">
              Quiet hours
              <input type="checkbox" role="switch" checked={quietOn}
                onChange={(e) => void save(e.target.checked
                  ? { ...settings, quietStart: 22 * 60, quietEnd: 7 * 60, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
                  : { ...settings, quietStart: null, quietEnd: null, timeZone: null })}
                className="h-4 w-4 accent-accent" />
            </label>
            {quietOn && (
              <div className="mt-2 flex items-center gap-2 text-xs text-text-secondary">
                No notifications from
                <input type="time" value={toTime(settings.quietStart)}
                  onChange={(e) => void save({ ...settings, quietStart: fromTime(e.target.value) })}
                  className="rounded border border-stroke bg-panel px-1" />
                to
                <input type="time" value={toTime(settings.quietEnd)}
                  onChange={(e) => void save({ ...settings, quietEnd: fromTime(e.target.value) })}
                  className="rounded border border-stroke bg-panel px-1" />
                <span>({settings.timeZone})</span>
              </div>
            )}
          </div>

          <div className="border-t border-stroke py-3 text-sm">
            <p>Blocked contacts</p>
            {blocked.length === 0 ? (
              <p className="text-xs text-text-secondary">Nobody. Block someone from their chat's menu.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {blocked.map((id) => (
                  <li key={id} className="flex items-center justify-between">
                    {nameOf(id)}
                    <button
                      onClick={() => void setBlocked(id, false).then(() => setBlockedList(blocked.filter((b) => b !== id)))}
                      className="text-xs text-accent hover:underline"
                    >
                      Unblock
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {error && <p className="text-sm text-red-300">{error}</p>}
          {saved && !error && <p className="text-xs text-accent">Saved</p>}
        </>
      )}
    </Modal>
  );
}
