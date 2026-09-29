import type { LocationInfo } from '@/db/db';

export const LOCATION_CONTENT_TYPE = 'application/x-chatter-location';

/** Live-location durations offered to the sender, as WhatsApp does. */
export const LIVE_DURATIONS = [
  { label: '15 minutes', ms: 15 * 60 * 1000 },
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '8 hours', ms: 8 * 60 * 60 * 1000 },
] as const;

export function isLiveActive(location: LocationInfo, now = Date.now()): boolean {
  return !!location.live && !location.live.stoppedAt && location.live.until > now;
}

export function locationPreview(location: LocationInfo): string {
  return location.live ? 'Live location' : 'Location';
}

/**
 * Opening a map is the one moment location leaves the end-to-end encrypted envelope: the map
 * provider sees the coordinates. So it only ever happens on an explicit tap, never to render a
 * preview.
 */
export function mapUrl(location: LocationInfo): string {
  const { lat, lng } = location;
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
}

export function formatCoordinates(location: LocationInfo): string {
  const ns = location.lat >= 0 ? 'N' : 'S';
  const ew = location.lng >= 0 ? 'E' : 'W';
  return `${Math.abs(location.lat).toFixed(5)}° ${ns}, ${Math.abs(location.lng).toFixed(5)}° ${ew}`;
}

/** Metres between two points (haversine). Used to skip live updates that did not move. */
export function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export function currentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('This browser cannot share location'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, (error) => reject(new Error(error.message)), {
      enableHighAccuracy: true,
      timeout: 15_000,
      maximumAge: 10_000,
    });
  });
}
