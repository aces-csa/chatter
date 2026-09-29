import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type LocalUser } from '@/db/db';
import { realtimeService } from '@/realtime/RealtimeService';
import { useAuthStore } from '@/state/authStore';
import { useCallStore, type CallPeer } from '@/state/callStore';

/** Incoming-call banner and the in-call screen. Mounted once, in the shell. */
export default function CallOverlay() {
  const incoming = useCallStore((s) => s.incoming);
  const active = useCallStore((s) => s.active);
  const error = useCallStore((s) => s.error);
  const users = useLiveQuery(() => db.users.toArray(), [], [] as LocalUser[]);
  const conversations = useLiveQuery(() => db.conversations.toArray(), [], []);
  const me = useAuthStore((s) => s.user);

  const nameOf = (id: string) => (id === me?.id ? 'You' : users.find((u) => u.id === id)?.displayName ?? 'Someone');
  const chatName = (conversationId: string) => {
    const c = conversations.find((x) => x.id === conversationId);
    return c?.type === 'GROUP' ? c.subject ?? 'Group' : undefined;
  };

  return (
    <>
      {error && !active && (
        <div role="alert" className="fixed left-1/2 top-4 z-[60] -translate-x-1/2 rounded-lg bg-red-500/90 px-4 py-2 text-sm text-white shadow-lg">
          {error}
          <button onClick={() => useCallStore.getState().set({ error: null })} className="ml-3 underline">
            Dismiss
          </button>
        </div>
      )}
      {incoming && !active && (
        <div
          role="alertdialog"
          aria-label="Incoming call"
          className="fixed left-1/2 top-4 z-[60] flex w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-xl border border-stroke bg-panel-alt p-4 shadow-2xl"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{nameOf(incoming.callerId)}</p>
            <p className="truncate text-sm text-text-secondary">
              Incoming {incoming.video ? 'video' : 'voice'} call{chatName(incoming.conversationId) ? ` · ${chatName(incoming.conversationId)}` : ''}
            </p>
          </div>
          <button onClick={() => realtimeService.calls.decline()} className="rounded-full bg-red-500 px-3 py-2 text-sm font-medium text-white">
            Decline
          </button>
          <button
            onClick={() => void realtimeService.calls.accept(false).catch(reportMediaError)}
            className="rounded-full bg-accent px-3 py-2 text-sm font-medium text-white"
          >
            Voice
          </button>
          {incoming.video && (
            <button
              onClick={() => void realtimeService.calls.accept(true).catch(reportMediaError)}
              className="rounded-full bg-accent px-3 py-2 text-sm font-medium text-white"
            >
              Video
            </button>
          )}
        </div>
      )}
      {active && <CallScreen nameOf={nameOf} title={chatName(active.conversationId)} />}
    </>
  );
}

function reportMediaError(e: unknown): void {
  useCallStore.getState().set({
    error: e instanceof DOMException && e.name === 'NotAllowedError'
      ? 'Allow microphone (and camera) access to join the call'
      : e instanceof Error ? e.message : 'Could not join the call',
  });
}

function CallScreen({ nameOf, title }: { nameOf: (id: string) => string; title?: string }) {
  const active = useCallStore((s) => s.active)!;
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const peers = Object.values(active.peers);
  const elapsed = Math.floor((Date.now() - active.startedAt) / 1000);
  const duration = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  const heading = title ?? (peers[0] ? nameOf(peers[0].userId) : 'Calling…');
  const columns = peers.length + 1 <= 1 ? 1 : peers.length + 1 <= 4 ? 2 : 3;

  return (
    <div role="dialog" aria-label="Call" className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="flex items-center justify-between px-5 py-3 text-white">
        <div>
          <p className="font-medium">{heading}</p>
          <p className="text-xs text-white/60">
            {peers.length === 0 ? 'Ringing…' : `${peers.length + 1} in call · ${duration}`} · End-to-end encrypted
          </p>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-2 p-2" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        <Tile label="You" stream={active.localStream} muted mirror showVideo={active.video && !active.cameraOff} />
        {peers.map((peer) => (
          <PeerTile key={peer.deviceId} peer={peer} name={nameOf(peer.userId)} />
        ))}
      </div>

      <div className="flex justify-center gap-4 py-5">
        <ControlButton label={active.muted ? 'Unmute' : 'Mute'} onClick={() => realtimeService.calls.toggleMute()} on={active.muted}
          path="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1a7 7 0 0 0 6-6.9h-2Z" />
        {active.video && (
          <ControlButton label={active.cameraOff ? 'Turn camera on' : 'Turn camera off'} onClick={() => realtimeService.calls.toggleCamera()} on={active.cameraOff}
            path="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4Z" />
        )}
        <button
          onClick={() => realtimeService.calls.leave()}
          aria-label="Leave call"
          className="flex h-14 w-14 items-center justify-center rounded-full bg-red-500 text-white hover:bg-red-600"
        >
          <svg viewBox="0 0 24 24" className="h-6 w-6 rotate-[135deg] fill-current" aria-hidden="true">
            <path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1l-2.2 2.2Z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function PeerTile({ peer, name }: { peer: CallPeer; name: string }) {
  const hasVideo = !!peer.stream && peer.stream.getVideoTracks().some((t) => t.readyState === 'live' && t.enabled);
  const status = peer.state === 'connected' ? undefined : peer.state === 'failed' ? 'Connection failed' : 'Connecting…';
  return <Tile label={name} stream={peer.stream} showVideo={hasVideo} status={status} />;
}

/**
 * One participant. A video element plays audio-only streams too, so every remote participant
 * is heard even with no picture; the local tile is muted so you do not hear yourself.
 */
function Tile({
  label,
  stream,
  muted = false,
  mirror = false,
  showVideo,
  status,
}: {
  label: string;
  stream?: MediaStream;
  muted?: boolean;
  mirror?: boolean;
  showVideo: boolean;
  status?: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (video.current && video.current.srcObject !== (stream ?? null)) video.current.srcObject = stream ?? null;
  }, [stream]);

  return (
    <div className="relative flex min-h-0 items-center justify-center overflow-hidden rounded-lg bg-panel">
      <video
        ref={video}
        autoPlay
        playsInline
        muted={muted}
        className={`h-full w-full object-cover ${showVideo ? '' : 'invisible absolute'} ${mirror ? '-scale-x-100' : ''}`}
      />
      {!showVideo && (
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-panel-hover text-2xl text-text-secondary">
          {label.slice(0, 2).toUpperCase()}
        </div>
      )}
      <span className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
        {label}
        {status ? ` · ${status}` : ''}
      </span>
    </div>
  );
}

function ControlButton({ label, onClick, on, path }: { label: string; onClick: () => void; on: boolean; path: string }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={on}
      title={label}
      className={`flex h-14 w-14 items-center justify-center rounded-full ${on ? 'bg-white text-black' : 'bg-white/15 text-white hover:bg-white/25'}`}
    >
      <svg viewBox="0 0 24 24" className="h-6 w-6 fill-current" aria-hidden="true">
        <path d={path} />
      </svg>
    </button>
  );
}
