import type { LocalConversation } from '@/db/db';
import { realtimeService } from '@/realtime/RealtimeService';
import { useCallStore } from '@/state/callStore';

const MAX_MESH = 8;

/** Voice / video call buttons in the chat header, or "Join" when a call is already running. */
export default function CallButtons({ conversation }: { conversation: LocalConversation }) {
  const active = useCallStore((s) => s.active);
  const ongoing = useCallStore((s) => s.ongoing[conversation.id]);
  if (conversation.left) return null;

  const tooBig = conversation.participantIds.length > MAX_MESH;
  const busy = !!active;
  const start = (video: boolean) =>
    void realtimeService.calls
      .start(conversation.id, video)
      .catch((e: unknown) => useCallStore.getState().set({ error: e instanceof Error ? e.message : 'Could not start the call' }));

  if (ongoing && active?.conversationId !== conversation.id) {
    return (
      <button
        onClick={() => start(false)}
        disabled={busy}
        className="rounded-full bg-accent px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
      >
        Join call
      </button>
    );
  }

  const title = tooBig ? `Calls are limited to ${MAX_MESH} people` : undefined;
  return (
    <>
      <button
        onClick={() => start(false)}
        disabled={busy || tooBig}
        aria-label="Voice call"
        title={title ?? 'Voice call'}
        className="rounded-full p-2 text-text-secondary hover:bg-panel-hover disabled:opacity-30"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true">
          <path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1l-2.2 2.2Z" />
        </svg>
      </button>
      <button
        onClick={() => start(true)}
        disabled={busy || tooBig}
        aria-label="Video call"
        title={title ?? 'Video call'}
        className="rounded-full p-2 text-text-secondary hover:bg-panel-hover disabled:opacity-30"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true">
          <path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4Z" />
        </svg>
      </button>
    </>
  );
}
