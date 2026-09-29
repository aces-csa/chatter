import { getMeta } from '@/db/db';

/** Kept here, with no imports beyond the store, so the message pipeline can read it without a cycle. */
export const BLOCKED_KEY = 'blockedUserIds';

export async function blockedIds(): Promise<string[]> {
  return (await getMeta<string[]>(BLOCKED_KEY)) ?? [];
}
