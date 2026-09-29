import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useAuthStore } from '@/state/authStore';
import { useUiStore } from '@/state/uiStore';
import Modal from '@/ui/Modal';
import {
  disableNotifications,
  enableNotifications,
  notificationsEnabled,
  notificationsSupported,
} from '@/lib/notifications';

/**
 * FR-1.6. Irreversible, so the user types their own number to confirm: a single click is too
 * easy to make by accident, and a browser confirm() would block the tab.
 */
export default function AccountDialog() {
  const me = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  const close = () => useUiStore.getState().setAccountOpen(false);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!me) return null;
  const matches = typed.replace(/\s/g, '') === me.phoneE164;

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount();
      close();
      // Wipes local history and key material; the server-side refresh token is already gone.
      await signOut();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not delete your account.');
      setBusy(false);
    }
  }

  return (
    <Modal title="Account" onClose={close}>
      <p className="text-lg font-medium">{me.displayName}</p>
      <p className="text-sm text-text-secondary">{me.phoneE164}</p>

      <button
        onClick={() => {
          close();
          useUiStore.getState().setProfileOpen(true);
        }}
        className="mt-6 flex w-full items-center justify-between border-t border-stroke pt-4 text-left text-sm hover:text-accent"
      >
        Edit profile
        <span aria-hidden="true">›</span>
      </button>
      <button
        onClick={() => {
          close();
          useUiStore.getState().setPrivacyOpen(true);
        }}
        className="mt-3 flex w-full items-center justify-between text-left text-sm hover:text-accent"
      >
        Privacy and blocked contacts
        <span aria-hidden="true">›</span>
      </button>
      <button
        onClick={() => {
          close();
          useUiStore.getState().setDevicesOpen(true);
        }}
        className="mt-3 flex w-full items-center justify-between text-left text-sm hover:text-accent"
      >
        Linked devices
        <span aria-hidden="true">›</span>
      </button>
      <button
        onClick={() => {
          close();
          useUiStore.getState().setBackupOpen(true);
        }}
        className="mt-3 flex w-full items-center justify-between text-left text-sm hover:text-accent"
      >
        Chat backup
        <span aria-hidden="true">›</span>
      </button>

      <NotificationToggle />

      <div className="mt-6 border-t border-stroke pt-4">
        {!confirming ? (
          <button onClick={() => setConfirming(true)} className="text-sm text-red-300 hover:underline">
            Delete my account
          </button>
        ) : (
          <>
            <p className="text-sm">Deleting your account will:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-secondary">
              <li>remove you from all your groups, handing ownership on where you own one</li>
              <li>delete your profile, linked devices and encryption keys</li>
              <li>discard any messages still waiting to be delivered to you</li>
              <li>erase the message history on this device</li>
            </ul>
            <p className="mt-2 text-sm text-text-secondary">
              Messages you already sent stay with the people who received them. This cannot be
              undone.
            </p>
            <label className="mt-4 block text-sm">
              Type your phone number to confirm
              <input
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                inputMode="tel"
                placeholder={me.phoneE164}
                className="mt-1 w-full rounded-lg border border-stroke bg-panel px-3 py-2 outline-none focus:border-red-400"
              />
            </label>
            {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirming(false)} className="px-3 py-1.5 text-sm text-text-secondary">
                Cancel
              </button>
              <button
                onClick={() => void remove()}
                disabled={!matches || busy}
                className="rounded-lg bg-red-500/80 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
              >
                {busy ? 'Deleting…' : 'Delete account'}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/** FR-8.3 global mute, per device: also stops the server pushing to this browser. */
function NotificationToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void notificationsEnabled().then(
      (enabled) => setOn(enabled && notificationsSupported() && Notification.permission === 'granted'),
    );
  }, []);

  if (!notificationsSupported()) {
    return <p className="mt-6 text-sm text-text-secondary">This browser does not support notifications.</p>;
  }

  async function toggle(next: boolean) {
    setNote(null);
    if (next) {
      const permission = await enableNotifications();
      setOn(permission === 'granted');
      if (permission === 'denied') setNote('Notifications are blocked in this browser\'s site settings.');
    } else {
      await disableNotifications();
      setOn(false);
    }
  }

  return (
    <div className="mt-6 border-t border-stroke pt-4">
      <label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
        Notifications on this device
        <input
          type="checkbox"
          role="switch"
          checked={on === true}
          disabled={on === null}
          onChange={(event) => void toggle(event.target.checked)}
          className="h-4 w-4 accent-accent"
        />
      </label>
      {note && <p className="mt-2 text-xs text-red-300">{note}</p>}
    </div>
  );
}
