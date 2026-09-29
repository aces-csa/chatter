import { useUiStore } from '@/state/uiStore';

const COPY: Record<string, { text: string; tone: string } | null> = {
  connected: null,
  idle: null,
  connecting: { text: 'Connecting…', tone: 'bg-amber-500/15 text-amber-300' },
  reconnecting: {
    text: 'Reconnecting — messages you send will be delivered when the connection returns',
    tone: 'bg-amber-500/15 text-amber-300',
  },
  offline: {
    text: 'Offline — your messages are queued on this device',
    tone: 'bg-red-500/15 text-red-300',
  },
};

/**
 * The connection state has to be visible. A messenger that silently stops delivering is
 * indistinguishable from one that is broken.
 */
export default function ConnectionBanner() {
  const connection = useUiStore((s) => s.connection);
  const copy = COPY[connection];
  if (!copy) return null;

  return (
    <div className={`px-4 py-2 text-xs ${copy.tone}`} role="status" aria-live="polite">
      {copy.text}
    </div>
  );
}
