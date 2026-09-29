/** Mirrors the server's GroupEvent: a membership or settings change in a group timeline. */
export interface GroupEvent {
  kind:
    | 'CREATED'
    | 'MEMBERS_ADDED'
    | 'MEMBER_REMOVED'
    | 'MEMBER_LEFT'
    | 'JOINED_VIA_INVITE'
    | 'ROLE_CHANGED'
    | 'SUBJECT_CHANGED'
    | 'DESCRIPTION_CHANGED'
    | 'SETTINGS_CHANGED'
    | 'DISAPPEARING_CHANGED';
  actorId: string;
  userIds?: string[];
  subject?: string;
  description?: string;
  role?: 'ADMIN' | 'MEMBER';
  onlyAdminsCanPost?: boolean;
  onlyAdminsCanEditInfo?: boolean;
  disappearingSeconds?: number;
}

export const DISAPPEARING_CHOICES = [
  { seconds: 86_400, label: '24 hours' },
  { seconds: 604_800, label: '7 days' },
  { seconds: 7_776_000, label: '90 days' },
] as const;

export function timerLabel(seconds: number | undefined): string {
  return DISAPPEARING_CHOICES.find((c) => c.seconds === seconds)?.label ?? 'Off';
}

/** "You added Sam and Priya", "Sam changed the subject to …" -- second person for yourself. */
export function describeGroupEvent(
  event: GroupEvent,
  selfUserId: string,
  nameOf: (userId: string) => string,
): string {
  const who = (id: string, capital = true) =>
    id === selfUserId ? (capital ? 'You' : 'you') : nameOf(id);
  const list = (ids: string[] = []) => {
    const names = ids.map((id) => who(id, false));
    return names.length <= 1
      ? names.join('')
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  };
  const actor = who(event.actorId);

  switch (event.kind) {
    case 'CREATED':
      return `${actor} created group "${event.subject ?? ''}"`;
    case 'MEMBERS_ADDED':
      return `${actor} added ${list(event.userIds)}`;
    case 'MEMBER_REMOVED':
      return `${actor} removed ${list(event.userIds)}`;
    case 'MEMBER_LEFT':
      return `${actor} left`;
    case 'JOINED_VIA_INVITE':
      return `${actor} joined using this group's invite link`;
    case 'ROLE_CHANGED':
      return event.role === 'ADMIN'
        ? `${actor} made ${list(event.userIds)} an admin`
        : `${actor} dismissed ${list(event.userIds)} as admin`;
    case 'SUBJECT_CHANGED':
      return `${actor} changed the subject to "${event.subject ?? ''}"`;
    case 'DESCRIPTION_CHANGED':
      return `${actor} changed the group description`;
    case 'DISAPPEARING_CHANGED':
      return event.disappearingSeconds
        ? `${actor} turned on disappearing messages. New messages will disappear from this chat ${timerLabel(event.disappearingSeconds)} after they're sent.`
        : `${actor} turned off disappearing messages`;
    case 'SETTINGS_CHANGED':
      return event.onlyAdminsCanPost
        ? `${actor} changed this group's settings so only admins can send messages`
        : `${actor} changed this group's settings`;
  }
}

/** Events after which everyone still in the group must stop using their current sender key. */
export function removesSomeone(event: GroupEvent): boolean {
  return event.kind === 'MEMBER_REMOVED' || event.kind === 'MEMBER_LEFT';
}
