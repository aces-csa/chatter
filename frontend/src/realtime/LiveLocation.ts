import { db, getMeta, setMeta, type LocationInfo, type LocalMessage } from '@/db/db';
import { distanceMetres } from '@/lib/location';

const SHARES_KEY = 'liveLocationShares';
/** Send at most this often while standing still... */
const MAX_SILENCE_MS = 60_000;
/** ...and at most this often while moving. */
const MIN_INTERVAL_MS = 15_000;
/** Movement below this is GPS jitter, not travel. */
const MIN_MOVE_METRES = 25;

interface Share {
  clientMessageId: string;
  until: number;
}

/**
 * Keeps a live-location message moving (WhatsApp's "share live location"). Each position update
 * is an encrypted control message targeting the original, so the server relays coordinates it
 * cannot read, and every recipient device -- and the sender's own other devices -- moves the pin.
 *
 * <p>The web cannot track location in the background: sharing continues while a Chatter tab is
 * open, and resumes if one is reopened before the share expires. The UI says so.
 */
export class LiveLocationTracker {
  private readonly watches = new Map<string, { watchId: number; last?: { lat: number; lng: number; at: number } }>();

  constructor(private readonly sendUpdate: (target: LocalMessage, location: LocationInfo) => Promise<void>) {}

  async resume(): Promise<void> {
    const shares = ((await getMeta<Share[]>(SHARES_KEY)) ?? []).filter((s) => s.until > Date.now());
    await setMeta(SHARES_KEY, shares);
    shares.forEach((share) => this.watch(share));
  }

  async track(clientMessageId: string, until: number): Promise<void> {
    const shares = ((await getMeta<Share[]>(SHARES_KEY)) ?? []).filter((s) => s.until > Date.now());
    await setMeta(SHARES_KEY, [...shares, { clientMessageId, until }]);
    this.watch({ clientMessageId, until });
  }

  async untrack(clientMessageId: string): Promise<void> {
    const entry = this.watches.get(clientMessageId);
    if (entry) navigator.geolocation.clearWatch(entry.watchId);
    this.watches.delete(clientMessageId);
    const shares = (await getMeta<Share[]>(SHARES_KEY)) ?? [];
    await setMeta(SHARES_KEY, shares.filter((s) => s.clientMessageId !== clientMessageId));
  }

  stopAll(): void {
    this.watches.forEach((entry) => navigator.geolocation.clearWatch(entry.watchId));
    this.watches.clear();
  }

  private watch(share: Share): void {
    if (this.watches.has(share.clientMessageId) || !('geolocation' in navigator)) return;
    const watchId = navigator.geolocation.watchPosition(
      (position) => void this.onPosition(share, position),
      (error) => console.warn('[live-location] position unavailable', error.message),
      { enableHighAccuracy: true, maximumAge: 10_000 },
    );
    this.watches.set(share.clientMessageId, { watchId });
  }

  private async onPosition(share: Share, position: GeolocationPosition): Promise<void> {
    const now = Date.now();
    if (now >= share.until) {
      // Expiry needs no message: every recipient already knows the end time.
      await this.untrack(share.clientMessageId);
      return;
    }
    const entry = this.watches.get(share.clientMessageId);
    if (!entry) return;
    const here = { lat: position.coords.latitude, lng: position.coords.longitude };
    const last = entry.last;
    if (last) {
      const moved = distanceMetres(last, here);
      const since = now - last.at;
      if (since < MIN_INTERVAL_MS || (moved < MIN_MOVE_METRES && since < MAX_SILENCE_MS)) return;
    }

    const message = await db.messages.get(share.clientMessageId);
    // Not acknowledged yet (no server id to target), or deleted meanwhile.
    if (!message?.messageId || !message.location?.live || message.deletedForAll) {
      if (!message || message.deletedForAll) await this.untrack(share.clientMessageId);
      return;
    }
    if (message.location.live.stoppedAt) {
      await this.untrack(share.clientMessageId);
      return;
    }
    entry.last = { ...here, at: now };
    await this.sendUpdate(message, {
      ...here,
      accuracy: position.coords.accuracy,
      live: { ...message.location.live, updatedAt: now },
    });
  }
}
