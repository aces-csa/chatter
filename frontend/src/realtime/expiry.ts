import { db, isSystemMessage } from '@/db/db';

export const SWEEP_INTERVAL_MS = 15_000;

/**
 * Deletes disappearing messages whose time is up from this device. The server purges its copy
 * on the same clock; this is the copy the user can actually see, so it must go too.
 *
 * <p>Chats whose latest message just vanished get their list preview recomputed, or the chat
 * list would keep quoting a message that no longer exists anywhere.
 */
export async function sweepExpiredMessages(now = Date.now()): Promise<void> {
  const due = await db.messages.where('expiresAt').belowOrEqual(now).toArray();
  if (due.length === 0) return;

  const touched = new Set(due.map((m) => m.conversationId));
  await db.transaction('rw', [db.messages, db.conversations, db.mediaBlobs], async () => {
    await db.messages.bulkDelete(due.map((m) => m.clientMessageId));
    // The decrypted attachment is the most sensitive copy of all; it goes with its message.
    await db.mediaBlobs.bulkDelete(
      due.flatMap((m) => [m.media?.mediaId, `local:${m.clientMessageId}`]).filter((id): id is string => !!id),
    );

    for (const conversationId of touched) {
      const latest = await db.messages
        .where('[conversationId+seq]')
        .between([conversationId, 0], [conversationId, Number.MAX_SAFE_INTEGER], true, true)
        .reverse()
        .filter((m) => !isSystemMessage(m))
        .first();
      await db.conversations.update(conversationId, {
        lastMessagePreview: latest ? (latest.undecryptable ? 'Waiting for this message' : latest.body) : undefined,
      });
    }
  });
}
