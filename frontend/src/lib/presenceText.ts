import type { Presence } from '@/state/presenceStore';

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const date = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

/**
 * WhatsApp's subtitle wording. Returns null when there is nothing to show — either the peer's
 * privacy settings hid it, or we have never seen them, and inventing "offline" in that case
 * would leak the difference between "hidden" and "never online".
 */
export function presenceText(presence: Presence | undefined): string | null {
  if (!presence) return null;
  if (presence.status === 'online') return 'online';
  if (presence.lastSeenAt == null) return null;

  const then = new Date(presence.lastSeenAt);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (presence.lastSeenAt >= today.getTime()) {
    return `last seen today at ${time.format(then)}`;
  }
  if (presence.lastSeenAt >= today.getTime() - 86_400_000) {
    return `last seen yesterday at ${time.format(then)}`;
  }
  return `last seen ${date.format(then)} at ${time.format(then)}`;
}

/**
 * "typing…" for a 1:1, "Sam is typing…" in a group, "2 people are typing…" beyond that; the
 * same shapes for "recording audio…", which wins when both are happening.
 */
export function typingText(
  typistIds: string[],
  nameOf: (userId: string) => string,
  isGroup: boolean,
  recorderIds: string[] = [],
): string | null {
  const [ids, verb] =
    recorderIds.length > 0 ? [recorderIds, 'recording audio'] : [typistIds, 'typing'];
  if (ids.length === 0) return null;
  if (!isGroup) return `${verb}…`;
  if (ids.length === 1) return `${nameOf(ids[0])} is ${verb}…`;
  return `${ids.length} people are ${verb}…`;
}
