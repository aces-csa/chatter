import { useEffect, useState } from 'react';
import { currentPosition, formatCoordinates, LIVE_DURATIONS } from '@/lib/location';
import { replyRefFor } from '@/lib/messageActions';
import { realtimeService } from '@/realtime/RealtimeService';
import { useUiStore } from '@/state/uiStore';
import Modal from '@/ui/Modal';

/** Send where you are now, or share live location for a fixed time. */
export default function ShareLocationDialog({ conversationId }: { conversationId: string }) {
  const close = () => useUiStore.getState().setLocationOpen(false);
  const [preview, setPreview] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [duration, setDuration] = useState<number>(LIVE_DURATIONS[0].ms);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    currentPosition()
      .then((p) => setPreview({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }))
      .catch((e: unknown) =>
        setError(e instanceof Error ? `Location unavailable: ${e.message}` : 'Location unavailable'),
      );
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      useUiStore.getState().setReplyingTo(null);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not share location.');
      setBusy(false);
    }
  }

  const replyTo = () => {
    const replying = useUiStore.getState().replyingTo;
    return replying ? replyRefFor(replying) : undefined;
  };

  return (
    <Modal title="Share location" onClose={close}>
      <p className="text-sm text-text-secondary">
        {preview
          ? `${formatCoordinates(preview)} · accurate to ${Math.round(preview.accuracy)} m`
          : error ?? 'Finding your location…'}
      </p>
      <p className="mt-2 text-xs text-text-secondary">
        Coordinates are end-to-end encrypted. Recipients only reveal them to a map provider if they
        choose to open the map.
      </p>

      <button
        disabled={!preview || busy}
        onClick={() => void run(() => realtimeService.shareLocation(conversationId, { replyTo: replyTo() }))}
        className="mt-4 w-full rounded-lg bg-accent py-2.5 font-medium text-white disabled:opacity-50"
      >
        Send your current location
      </button>

      <fieldset className="mt-5 border-t border-stroke pt-4" disabled={!preview || busy}>
        <legend className="text-sm font-medium">Share live location</legend>
        <div className="mt-2 flex gap-2">
          {LIVE_DURATIONS.map((option) => (
            <label
              key={option.ms}
              className={`flex-1 cursor-pointer rounded-lg border px-2 py-2 text-center text-sm ${
                duration === option.ms ? 'border-accent bg-accent/15' : 'border-stroke'
              }`}
            >
              <input
                type="radio"
                name="duration"
                className="sr-only"
                checked={duration === option.ms}
                onChange={() => setDuration(option.ms)}
              />
              {option.label}
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-text-secondary">
          Your location updates while a Chatter tab is open on this device. You can stop at any time.
        </p>
        <button
          onClick={() => void run(() => realtimeService.startLiveLocation(conversationId, duration, { replyTo: replyTo() }))}
          className="mt-3 w-full rounded-lg border border-accent py-2.5 font-medium text-accent disabled:opacity-50"
        >
          Share live location
        </button>
      </fieldset>
      {error && preview && <p className="mt-3 text-sm text-red-300">{error}</p>}
    </Modal>
  );
}
