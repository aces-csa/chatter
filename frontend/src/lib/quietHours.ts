import { getMeta, setMeta } from '@/db/db';
import type { PrivacySettings } from '@/lib/api';

const PRIVACY_KEY = 'privacySettings';

/** Cached so the page can honour quiet hours without asking the server each time. */
export async function cachePrivacy(settings: PrivacySettings): Promise<void> {
  await setMeta(PRIVACY_KEY, settings);
}

/** The in-page equivalent of the server's quiet-hours check (FR-8.4), so the chime obeys it too. */
export async function inQuietHours(now = new Date()): Promise<boolean> {
  const p = await getMeta<PrivacySettings>(PRIVACY_KEY);
  if (!p || p.quietStart == null || p.quietEnd == null) return false;
  const local = new Date(now.toLocaleString('en-US', { timeZone: p.timeZone ?? undefined }));
  const minute = local.getHours() * 60 + local.getMinutes();
  return p.quietStart <= p.quietEnd
    ? minute >= p.quietStart && minute < p.quietEnd
    : minute >= p.quietStart || minute < p.quietEnd;
}

/**
 * Read receipts setting, from the cached privacy settings. Sealed receipts go device to device,
 * so the client applies the rule the server applies to identified ones: off means we neither
 * send them nor show them (reciprocal, FR-2.3).
 */
export async function readReceiptsEnabled(): Promise<boolean> {
  return (await getMeta<PrivacySettings>(PRIVACY_KEY))?.readReceipts ?? true;
}
