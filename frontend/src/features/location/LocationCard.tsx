import { useEffect, useState } from 'react';
import type { LocalMessage } from '@/db/db';
import { formatCoordinates, isLiveActive, mapUrl } from '@/lib/location';
import { realtimeService } from '@/realtime/RealtimeService';

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

/**
 * A location in a bubble. Drawn locally -- no map tiles are fetched to render it, because
 * fetching tiles for the exact coordinates would hand them to the tile server. "Open map" does
 * that, on purpose, on a tap.
 */
export default function LocationCard({ message, outgoing }: { message: LocalMessage; outgoing: boolean }) {
  const location = message.location!;
  const [, tick] = useState(0);
  const active = isLiveActive(location);

  // Live cards say "updated 2 min ago" and flip to "ended" on time, without new data arriving.
  useEffect(() => {
    if (!location.live) return;
    const id = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [location.live]);

  return (
    <div className="mb-1 w-[260px] overflow-hidden rounded-md bg-black/20">
      <div className="relative flex h-28 items-center justify-center bg-[radial-gradient(circle_at_center,rgba(0,168,132,0.25),transparent_70%)]">
        <svg viewBox="0 0 24 24" className={`h-10 w-10 ${active ? 'animate-bounce fill-accent' : 'fill-red-400'}`} aria-hidden="true">
          <path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5Z" />
        </svg>
        {location.live && (
          <span className={`absolute left-2 top-2 rounded px-1.5 py-0.5 text-[11px] font-medium ${active ? 'bg-accent text-white' : 'bg-black/50 text-text-secondary'}`}>
            {active ? 'LIVE' : 'Ended'}
          </span>
        )}
      </div>
      <div className="px-2.5 py-2">
        <p className="text-sm">{location.live ? 'Live location' : 'Location'}</p>
        <p className="text-xs text-text-secondary">
          {formatCoordinates(location)}
          {location.accuracy ? ` · ±${Math.round(location.accuracy)} m` : ''}
        </p>
        {location.live && (
          <p className="text-xs text-text-secondary">
            {active
              ? `Updated ${ago(location.live.updatedAt)} · until ${time.format(new Date(location.live.until))}`
              : `Last updated ${ago(location.live.updatedAt)}`}
          </p>
        )}
        <div className="mt-2 flex gap-3 pr-14 text-xs">
          <a href={mapUrl(location)} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
            Open map
          </a>
          {outgoing && active && (
            <button onClick={() => void realtimeService.stopLiveLocation(message)} className="text-red-300 hover:underline">
              Stop sharing
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
