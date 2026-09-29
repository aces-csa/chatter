import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import QRCode from 'qrcode';
import { db } from '@/db/db';
import { identityTrust } from '@/lib/crypto/IdentityTrust';
import { realtimeService } from '@/realtime/RealtimeService';
import { useUiStore } from '@/state/uiStore';
import VerifiedIcon from './VerifiedIcon';

/**
 * Safety-number comparison. Without this, E2EE is unverifiable: the server could hand out its
 * own keys and neither side would ever know.
 */
export default function SafetyNumberDialog({ userId }: { userId: string }) {
  const close = () => useUiStore.getState().setSafetyNumberUserId(null);

  const contact = useLiveQuery(() => db.users.get(userId), [userId]);
  const trust = useLiveQuery(() => db.contactTrust.get(userId), [userId]);
  const name = contact?.displayName ?? 'this contact';

  const [digits, setDigits] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theirs, setTheirs] = useState('');

  // Recomputed when the known keys change, so a key change while the dialog is open is shown
  // rather than leaving a stale number up for comparison.
  const keysVersion = trust?.knownKeys.join(',');
  useEffect(() => {
    let cancelled = false;
    setDigits(null);
    setError(null);
    realtimeService
      .safetyNumberWith(userId)
      .then(async (number) => {
        if (cancelled) return;
        setDigits(number);
        setQr(await QRCode.toDataURL(number, { margin: 1, width: 200 }));
      })
      .catch((e: unknown) => {
        console.warn('[trust] could not compute safety number', e);
        if (!cancelled) setError('Could not compute the safety number. Check your connection.');
      });
    return () => {
      cancelled = true;
    };
  }, [userId, keysVersion]);

  const groups = useMemo(() => digits?.match(/.{5}/g) ?? [], [digits]);

  const pasted = theirs.replace(/\D/g, '');
  const comparison =
    pasted.length === 0 || !digits ? null : pasted === digits ? 'match' : 'mismatch';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Verify security code"
      onClick={close}
    >
      <div
        className="max-h-full w-full max-w-md overflow-y-auto rounded-xl border border-stroke bg-panel-alt p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-medium">Verify security code</h2>
          <button onClick={close} aria-label="Close" className="text-text-secondary hover:text-text-primary">
            <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true">
              <path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z" />
            </svg>
          </button>
        </div>

        {error && <p className="text-sm text-red-300">{error}</p>}

        {!error && !digits && (
          <p className="py-10 text-center text-sm text-text-secondary">Computing safety number…</p>
        )}

        {digits && (
          <>
            {qr && (
              <img
                src={qr}
                alt={`QR code of your safety number with ${name}`}
                className="mx-auto mb-4 h-40 w-40 rounded-lg bg-white p-1"
              />
            )}
            <div
              className="mx-auto grid max-w-xs grid-cols-4 gap-x-4 gap-y-2 text-center font-mono text-lg tracking-wider"
              aria-label={`Safety number: ${groups.join(' ')}`}
            >
              {groups.map((group, index) => (
                <span key={index}>{group}</span>
              ))}
            </div>

            <p className="mt-4 text-sm text-text-secondary">
              To verify that messages with {name} are end-to-end encrypted, compare this number
              with the one on their screen — in person, or over a channel you already trust. It
              covers every device on both accounts.
            </p>

            <label className="mt-4 block text-sm text-text-secondary">
              Or paste the number they sent you
              <input
                value={theirs}
                onChange={(event) => setTheirs(event.target.value)}
                inputMode="numeric"
                className="mt-1 w-full rounded-lg border border-stroke bg-panel px-3 py-2 font-mono text-text-primary outline-none focus:border-accent"
              />
            </label>
            {comparison === 'match' && (
              <p className="mt-2 text-sm text-accent" role="status">
                The numbers match.
              </p>
            )}
            {comparison === 'mismatch' && (
              <p className="mt-2 text-sm text-red-300" role="status">
                The numbers do not match. Do not mark this contact as verified.
              </p>
            )}

            <div className="mt-5 flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-sm">
                {trust?.verified ? (
                  <>
                    <VerifiedIcon className="h-4 w-4 fill-accent" />
                    Verified
                  </>
                ) : (
                  <span className="text-text-secondary">Not verified</span>
                )}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => void navigator.clipboard?.writeText(digits)}
                  className="rounded-lg border border-stroke px-3 py-2 text-sm hover:bg-panel-hover"
                >
                  Copy
                </button>
                <button
                  onClick={() => void identityTrust.setVerified(userId, !trust?.verified)}
                  disabled={!trust || comparison === 'mismatch'}
                  className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {trust?.verified ? 'Clear verification' : 'Mark as verified'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
