import { db, getMeta, setMeta, type LocalConversation } from '@/db/db';
import { api } from '@/lib/api';
import { realtimeService } from '@/realtime/RealtimeService';

const BLOCKED_KEY = 'blockedUserIds';

/** Pin (max 3), archive, mark unread (FR-7.2 / 7.3). Server-side, so other devices agree. */
export async function setChatState(
  conversation: LocalConversation,
  state: { pinned?: boolean; archived?: boolean; markedUnread?: boolean },
): Promise<void> {
  const updated = await api.setChatState(conversation.id, state);
  await db.conversations.update(conversation.id, {
    pinned: updated.pinned,
    archived: updated.archived,
    markedUnread: updated.markedUnread,
  });
}

/** Mark read from the chat list: the same coalesced READ frame opening the chat would send. */
export async function markChatRead(conversation: LocalConversation): Promise<void> {
  const latest = await db.messages
    .where('[conversationId+seq]')
    .between([conversation.id, 0], [conversation.id, Number.MAX_SAFE_INTEGER], true, false)
    .reverse()
    .filter((m) => Number.isInteger(m.seq))
    .first();
  await realtimeService.markRead(conversation.id, latest?.seq ?? conversation.lastSeq);
}

/** FR-7.5 clear chat: every message on this device goes; the chat itself stays. */
export async function clearChat(conversationId: string): Promise<void> {
  const ids = await db.messages.where('conversationId').equals(conversationId).filter((m) => !m.control).toArray();
  await db.transaction('rw', [db.messages, db.mediaBlobs, db.conversations], async () => {
    await db.messages.bulkDelete(ids.map((m) => m.clientMessageId));
    await db.mediaBlobs.bulkDelete(
      ids.flatMap((m) => [m.media?.mediaId, `local:${m.clientMessageId}`]).filter((id): id is string => !!id),
    );
    await db.conversations.update(conversationId, { lastMessagePreview: undefined, unreadCount: 0 });
  });
}

/**
 * FR-7.5 delete chat: removes it from this device. A direct chat comes back if a new message
 * arrives (as on WhatsApp); a group must be exited first, or it would come straight back.
 */
export async function deleteChat(conversation: LocalConversation): Promise<void> {
  if (conversation.type === 'GROUP' && !conversation.left) {
    throw new Error('Exit the group before deleting it');
  }
  await clearChat(conversation.id);
  await db.conversations.delete(conversation.id);
}

export async function loadBlocks(): Promise<string[]> {
  const ids = await api.blocks();
  await setMeta(BLOCKED_KEY, ids);
  return ids;
}

export async function blockedIds(): Promise<string[]> {
  return (await getMeta<string[]>(BLOCKED_KEY)) ?? [];
}

export async function setBlocked(userId: string, blocked: boolean): Promise<void> {
  await (blocked ? api.block(userId) : api.unblock(userId));
  const current = await blockedIds();
  await setMeta(BLOCKED_KEY, blocked ? [...new Set([...current, userId])] : current.filter((id) => id !== userId));
}
