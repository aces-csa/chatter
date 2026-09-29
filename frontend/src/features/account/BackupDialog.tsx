import { useEffect, useState } from 'react';
import { BackupError, createBackup, lastBackupAt, restoreBackup } from '@/lib/backup';
import { useAuthStore } from '@/state/authStore';
import { useUiStore } from '@/state/uiStore';
import Modal from '@/ui/Modal';

/** Create or restore an encrypted chat backup file. */
export default function BackupDialog() {
  const me = useAuthStore((s) => s.user);
  const close = () => useUiStore.getState().setBackupOpen(false);
  const [mode, setMode] = useState<'create' | 'restore'>('create');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [includeMedia, setIncludeMedia] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<number | undefined>();

  useEffect(() => {
    void lastBackupAt().then(setLast);
  }, []);

  if (!me) return null;
  const strongEnough = passphrase.length >= 10;

  async function create() {
    setError(null);
    setResult(null);
    try {
      const blob = await createBackup(passphrase, { userId: me!.id, includeMedia }, setStage);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `chatter-backup-${new Date().toISOString().slice(0, 10)}.chatterbackup`;
      link.click();
      URL.revokeObjectURL(url);
      setResult(`Backup saved (${(blob.size / 1024 / 1024).toFixed(1)} MB). Keep the file and the passphrase: neither can be recovered for you.`);
      setLast(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Backup failed');
    } finally {
      setStage(null);
    }
  }

  async function restore() {
    if (!file) return;
    setError(null);
    setResult(null);
    setStage('Decrypting…');
    try {
      const summary = await restoreBackup(file, passphrase, me!.id);
      setResult(`Restored ${summary.messages} messages in ${summary.conversations} new chats${summary.media ? `, ${summary.media} media files` : ''}.`);
    } catch (e) {
      setError(e instanceof BackupError ? e.message : 'Restore failed');
    } finally {
      setStage(null);
    }
  }

  const inputClass = 'mt-1 w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-text-primary outline-none focus:border-accent';

  return (
    <Modal title="Chat backup" onClose={close}>
      <div className="mb-4 flex rounded-lg bg-panel p-1 text-sm">
        {(['create', 'restore'] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              setError(null);
              setResult(null);
            }}
            className={`flex-1 rounded-md py-1.5 ${mode === m ? 'bg-panel-hover font-medium' : 'text-text-secondary'}`}
          >
            {m === 'create' ? 'Back up' : 'Restore'}
          </button>
        ))}
      </div>

      <p className="text-xs text-text-secondary">
        {mode === 'create'
          ? 'Your chats are encrypted with your passphrase on this device and saved as a file. The server never sees it. Encryption keys are not included: each device keeps its own.'
          : 'Adds the chats in a backup to this device. Nothing already here is overwritten.'}
        {mode === 'create' && last ? ` Last backup: ${new Date(last).toLocaleString()}.` : ''}
      </p>

      {mode === 'restore' && (
        <label className="mt-3 block text-sm">
          Backup file
          <input type="file" accept=".chatterbackup" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="mt-1 block w-full text-sm" />
        </label>
      )}

      <label className="mt-3 block text-sm">
        Passphrase
        <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" className={inputClass} />
      </label>
      {mode === 'create' && (
        <>
          <label className="mt-3 block text-sm">
            Confirm passphrase
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" className={inputClass} />
          </label>
          {passphrase && !strongEnough && <p className="mt-1 text-xs text-amber-300">Use at least 10 characters.</p>}
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeMedia} onChange={(e) => setIncludeMedia(e.target.checked)} className="h-4 w-4 accent-accent" />
            Include downloaded photos, videos and files
          </label>
        </>
      )}

      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      {result && <p className="mt-3 text-sm text-accent">{result}</p>}

      <button
        disabled={
          !!stage ||
          (mode === 'create' ? !strongEnough || passphrase !== confirm : !file || !passphrase)
        }
        onClick={() => void (mode === 'create' ? create() : restore())}
        className="mt-4 w-full rounded-lg bg-accent py-2.5 font-medium text-white disabled:opacity-50"
      >
        {stage ?? (mode === 'create' ? 'Create encrypted backup' : 'Restore backup')}
      </button>
    </Modal>
  );
}
