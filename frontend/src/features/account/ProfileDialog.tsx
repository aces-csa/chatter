import { useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useAuthStore } from '@/state/authStore';
import { useUiStore } from '@/state/uiStore';
import Avatar, { toAvatarDataUrl } from '@/ui/Avatar';
import Modal from '@/ui/Modal';

/** FR-1.4: display name, about, profile photo. */
export default function ProfileDialog() {
  const me = useAuthStore((s) => s.user);
  const close = () => useUiStore.getState().setProfileOpen(false);
  const [name, setName] = useState(me?.displayName ?? '');
  const [about, setAbout] = useState(me?.about ?? '');
  const [avatar, setAvatar] = useState<string | undefined>(me?.avatar);
  const [avatarChanged, setAvatarChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  if (!me) return null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateMe({
        displayName: name.trim() !== me!.displayName ? name.trim() : undefined,
        about: about !== (me!.about ?? '') ? about : undefined,
        avatar: avatarChanged && avatar ? avatar : undefined,
        removeAvatar: avatarChanged && !avatar,
      });
      useAuthStore.setState({ user: updated });
      close();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save your profile');
      setBusy(false);
    }
  }

  return (
    <Modal title="Profile" onClose={close}>
      <div className="flex flex-col items-center gap-2">
        <Avatar name={name || '?'} src={avatar} size={96} />
        <div className="flex gap-3 text-sm">
          <button onClick={() => picker.current?.click()} className="text-accent hover:underline">
            {avatar ? 'Change photo' : 'Add photo'}
          </button>
          {avatar && (
            <button onClick={() => { setAvatar(undefined); setAvatarChanged(true); }} className="text-red-300 hover:underline">
              Remove
            </button>
          )}
        </div>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            void toAvatarDataUrl(file)
              .then((url) => { setAvatar(url); setAvatarChanged(true); })
              .catch(() => setError('That image could not be read'));
          }}
        />
      </div>
      <label className="mt-4 block text-sm">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64}
          className="mt-1 w-full rounded-lg border border-stroke bg-panel px-3 py-2 outline-none focus:border-accent" />
      </label>
      <label className="mt-3 block text-sm">
        About
        <input value={about} onChange={(e) => setAbout(e.target.value)} maxLength={160}
          className="mt-1 w-full rounded-lg border border-stroke bg-panel px-3 py-2 outline-none focus:border-accent" />
      </label>
      <p className="mt-2 text-xs text-text-secondary">
        Your photo and about are profile information, not end-to-end encrypted messages. Choose who
        can see them in Privacy.
      </p>
      {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
      <button onClick={() => void save()} disabled={busy || !name.trim()}
        className="mt-4 w-full rounded-lg bg-accent py-2.5 font-medium text-white disabled:opacity-50">
        Save
      </button>
    </Modal>
  );
}
