import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type DeviceDto } from '@/lib/api';
import { useAuthStore } from '@/state/authStore';
import { useUiStore } from '@/state/uiStore';
import Modal from '@/ui/Modal';

/** FR-1.5: see every session on the account, revoke any, and approve a new one by QR. */
export default function LinkedDevicesDialog() {
  const myDeviceId = useAuthStore((s) => s.deviceId);
  const close = () => useUiStore.getState().setDevicesOpen(false);
  const [devices, setDevices] = useState<DeviceDto[] | null>(null);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .myDevices()
      .then(setDevices)
      .catch(() => setError('Could not load your devices.'));
  }, []);
  useEffect(load, [load]);

  async function revoke(device: DeviceDto) {
    setError(null);
    try {
      await api.revokeDevice(device.id);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not log that device out.');
    }
  }

  return (
    <Modal title="Linked devices" onClose={close} wide>
      {linking ? (
        <ApproveLink
          onDone={() => {
            setLinking(false);
            load();
          }}
        />
      ) : (
        <>
          <button
            onClick={() => setLinking(true)}
            className="w-full rounded-lg bg-accent py-2.5 font-medium text-white hover:brightness-110"
          >
            Link a device
          </button>
          <p className="mt-2 text-xs text-text-secondary">
            Each device has its own encryption keys. People you talk to will see your security code
            change when you link one.
          </p>

          <ul className="mt-4 space-y-1">
            {devices === null && !error && <li className="text-sm text-text-secondary">Loading…</li>}
            {devices?.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                current={device.id === myDeviceId}
                onRevoke={() => void revoke(device)}
              />
            ))}
          </ul>
        </>
      )}
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
    </Modal>
  );
}

function DeviceRow({ device, current, onRevoke }: { device: DeviceDto; current: boolean; onRevoke: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const seen = device.lastActiveAt ?? device.createdAt;
  return (
    <li className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-panel-hover">
      <svg viewBox="0 0 24 24" className="h-6 w-6 shrink-0 fill-text-secondary" aria-hidden="true">
        <path d="M20 18a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2H0v2h24v-2h-4ZM4 6h16v10H4V6Z" />
      </svg>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">
          {device.name ?? 'Web browser'}
          {current && <span className="ml-2 text-xs text-accent">This device</span>}
        </p>
        <p className="text-xs text-text-secondary">
          {device.hasKeys ? '' : 'Setting up · '}
          {seen ? `Last active ${new Date(seen).toLocaleString()}` : ''}
        </p>
      </div>
      {!current &&
        (confirming ? (
          <span className="flex shrink-0 gap-2">
            <button onClick={() => setConfirming(false)} className="text-xs text-text-secondary">
              Cancel
            </button>
            <button onClick={onRevoke} className="rounded-md bg-red-500/80 px-2 py-1 text-xs text-white">
              Log out
            </button>
          </span>
        ) : (
          <button onClick={() => setConfirming(true)} className="shrink-0 text-xs text-red-300 hover:underline">
            Log out
          </button>
        ))}
    </li>
  );
}

interface Detector {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (options: { formats: string[] }) => Detector;
  }
}

/**
 * The approving side: scan the new browser's QR with the camera where the browser can decode
 * QR codes (BarcodeDetector), or type the code shown under it everywhere else.
 */
function ApproveLink({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<{ linkId: string; deviceName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canScan = typeof window.BarcodeDetector === 'function' && !!navigator.mediaDevices?.getUserMedia;

  const lookUp = useCallback(async (raw: string) => {
    const linkId = raw.trim().replace(/^chatter-link:/, '').replace(/[\s-]/g, '').toUpperCase();
    if (linkId.length < 6) return;
    setError(null);
    try {
      const found = await api.previewLink(linkId);
      setPreview({ linkId, deviceName: found.deviceName });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That code did not work.');
    }
  }, []);

  async function approve() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      await api.approveLink(preview.linkId);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not link the device.');
      setBusy(false);
    }
  }

  if (preview) {
    return (
      <div className="text-center">
        <p className="text-sm text-text-secondary">Link this device to your account?</p>
        <p className="mt-2 text-lg font-medium">{preview.deviceName}</p>
        <p className="mx-auto mt-3 max-w-sm text-xs text-text-secondary">
          Only continue if you are setting this device up yourself, right now. A linked device can
          read and send every new message on your account.
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <button onClick={onDone} className="rounded-lg px-4 py-2 text-sm text-text-secondary">
            Cancel
          </button>
          <button
            onClick={() => void approve()}
            disabled={busy}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Link device
          </button>
        </div>
        {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      </div>
    );
  }

  return (
    <div>
      {canScan && <Scanner onCode={(value) => void lookUp(value)} />}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void lookUp(code);
        }}
        className="mt-4"
      >
        <label className="block text-sm text-text-secondary">
          {canScan ? 'Or type the code shown under the QR' : 'Type the code shown on the new device'}
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="ABCDE-FGHJK"
            autoFocus={!canScan}
            autoCapitalize="characters"
            className="mt-1 w-full rounded-lg border border-stroke bg-panel px-3 py-2.5 font-mono tracking-widest text-text-primary outline-none focus:border-accent"
          />
        </label>
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onDone} className="px-3 py-1.5 text-sm text-text-secondary">
            Cancel
          </button>
          <button type="submit" className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white">
            Continue
          </button>
        </div>
      </form>
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
    </div>
  );
}

function Scanner({ onCode }: { onCode: (value: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: number | null = null;
    let found = false;
    const detector = new window.BarcodeDetector!({ formats: ['qr_code'] });

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (!video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        timer = window.setInterval(async () => {
          if (found || !video.current) return;
          const codes = await detector.detect(video.current).catch(() => []);
          const hit = codes.find((c) => c.rawValue.startsWith('chatter-link:'));
          if (hit) {
            found = true;
            onCode(hit.rawValue);
          }
        }, 300);
      } catch {
        setFailed(true);
      }
    })();

    // Camera light off the moment we leave.
    return () => {
      if (timer !== null) window.clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [onCode]);

  if (failed) return <p className="text-sm text-text-secondary">The camera is not available.</p>;
  return (
    <video
      ref={video}
      muted
      playsInline
      aria-label="Camera view for scanning the link QR code"
      className="mx-auto aspect-square w-full max-w-xs rounded-lg bg-black object-cover"
    />
  );
}
