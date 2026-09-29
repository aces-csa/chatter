import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api, ApiError, type SignedInSession } from '@/lib/api';

const POLL_MS = 2_000;

/** The QR payload; the scanner also accepts the bare code typed by hand. */
export function linkPayload(linkId: string): string {
  return `chatter-link:${linkId}`;
}

export function formatLinkCode(linkId: string): string {
  return linkId.match(/.{1,5}/g)?.join('-') ?? linkId;
}

/**
 * The new browser's half of QR linking: show a code, wait for a signed-in device to approve it,
 * collect the session. Codes live two minutes; an expired one is replaced without fuss.
 */
export default function LinkThisBrowser({
  deviceName,
  onLinked,
  onBack,
}: {
  deviceName: string;
  onLinked: (session: SignedInSession) => void;
  onBack: () => void;
}) {
  const [link, setLink] = useState<{ linkId: string; pollSecret: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  // Held in a ref so a parent re-render cannot restart the poll loop.
  const linked = useRef(onLinked);
  linked.current = onLinked;

  useEffect(() => {
    let cancelled = false;
    setLink(null);
    setQr(null);
    api
      .startLink(deviceName)
      .then(async (started) => {
        if (cancelled) return;
        setLink(started);
        setQr(await QRCode.toDataURL(linkPayload(started.linkId), { margin: 1, width: 220 }));
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not reach the server.'));
    return () => {
      cancelled = true;
    };
  }, [deviceName, generation]);

  useEffect(() => {
    if (!link) return;
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      try {
        const result = await api.claimLink(link.linkId, link.pollSecret);
        if (result.status === 'LINKED' && result.session) {
          stopped = true;
          linked.current(result.session);
          return;
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          setGeneration((g) => g + 1); // expired: show a fresh code
          return;
        }
      }
      if (!stopped) window.setTimeout(() => void poll(), POLL_MS);
    };
    const first = window.setTimeout(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(first);
    };
  }, [link]);

  return (
    <div className="text-center">
      <h2 className="text-lg font-medium">Link this browser</h2>
      <ol className="mx-auto mt-3 max-w-xs list-decimal space-y-1 pl-5 text-left text-sm text-text-secondary">
        <li>Open Chatter where you are already signed in</li>
        <li>Your name › Linked devices › Link a device</li>
        <li>Scan this code, or type the code under it</li>
      </ol>

      <div className="mx-auto mt-4 flex h-[220px] w-[220px] items-center justify-center rounded-lg bg-white">
        {qr ? (
          <img src={qr} alt="Link code as a QR code" className="h-full w-full rounded-lg" />
        ) : (
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        )}
      </div>
      {link && (
        <p className="mt-3 font-mono text-xl tracking-widest" aria-label={`Code ${link.linkId.split('').join(' ')}`}>
          {formatLinkCode(link.linkId)}
        </p>
      )}
      <p className="mt-3 text-xs text-text-secondary">
        Messages sent before linking stay on your other devices: they were encrypted for them, not
        for this browser.
      </p>
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      <button onClick={onBack} className="mt-4 text-sm text-text-secondary hover:text-text-primary">
        Sign in with a phone number instead
      </button>
    </div>
  );
}
