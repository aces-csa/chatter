import { db, type LocalConversation } from '@/db/db';
import { api, ApiError, type ConversationDto } from '@/lib/api';
import { toEpochMillis } from '@/lib/time';

/**
 * Server DTO to local row. Fields the server does not know about, like the last-message preview,
 * survive from the existing row rather than being clobbered.
 *
 * <p>{@code lastSeq} is never taken from the server. It is this device's sync cursor: raising it
 * to the server's value before the backlog has arrived would make the next SYNC ask only for
 * messages after it, and everything in between would never be fetched.
 */
export function toLocalConversation(
  dto: ConversationDto,
  local?: LocalConversation,
): LocalConversation {
  return {
    id: dto.id,
    type: dto.type,
    subject: dto.subject,
    description: dto.description,
    participantIds: dto.participantIds,
    members: dto.members,
    onlyAdminsCanPost: dto.onlyAdminsCanPost,
    onlyAdminsCanEditInfo: dto.onlyAdminsCanEditInfo,
    disappearingSeconds: dto.disappearingSeconds,
    lastSeq: local?.lastSeq ?? 0,
    lastMessageAt: toEpochMillis(dto.lastMessageAt) ?? local?.lastMessageAt,
    lastMessagePreview: local?.lastMessagePreview,
    unreadCount: dto.unreadCount,
    lastReadSeq: dto.lastReadSeq,
    pinned: dto.pinned,
    archived: dto.archived,
    mutedUntil: toEpochMillis(dto.mutedUntil),
    markedUnread: dto.markedUnread,
    left: false,
  };
}

export async function saveConversation(dto: ConversationDto): Promise<LocalConversation> {
  const row = toLocalConversation(dto, await db.conversations.get(dto.id));
  await db.conversations.put(row);
  await cacheUsers(dto.participantIds);
  return row;
}

/** Caches the people in a conversation, so names render without a request per row. */
export async function cacheUsers(userIds: string[]): Promise<void> {
  for (const id of userIds) {
    if (!(await db.users.get(id))) {
      const user = await api.userById(id).catch(() => null);
      if (user) await db.users.put(user);
    }
  }
}

/**
 * Pulls membership and settings after a group event, touching nothing else. In particular it
 * leaves the sync cursor alone -- see {@link toLocalConversation}.
 *
 * @returns false if we are no longer a member
 */
export async function refreshGroupDetails(conversationId: string): Promise<boolean> {
  try {
    await applyGroupDetails(await api.conversationById(conversationId));
    return true;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      await db.conversations.update(conversationId, { left: true });
      return false;
    }
    throw error;
  }
}

/** Applies membership and settings from a fresh DTO, e.g. the response to a group mutation. */
export async function applyGroupDetails(dto: ConversationDto): Promise<void> {
  await db.conversations.update(dto.id, {
    subject: dto.subject,
    description: dto.description,
    participantIds: dto.participantIds,
    members: dto.members,
    onlyAdminsCanPost: dto.onlyAdminsCanPost,
    onlyAdminsCanEditInfo: dto.onlyAdminsCanEditInfo,
    disappearingSeconds: dto.disappearingSeconds,
    mutedUntil: toEpochMillis(dto.mutedUntil),
    left: false,
  });
  await cacheUsers(dto.participantIds);
}
