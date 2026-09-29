import { db, isSystemMessage, SYSTEM_GROUP_EVENT, SYSTEM_IDENTITY_CHANGED, type LocalConversation } from '@/db/db';
import { describeGroupEvent, type GroupEvent } from '@/lib/groupEvents';

/**
 * FR-7.6: the chat as a plain-text file, in the familiar "[date, time] Name: text" layout.
 *
 * <p>Built entirely from this device's local store -- under E2EE the server has nothing
 * readable to export -- so it contains exactly what this device can show: messages that
 * already disappeared, or arrived before this device joined, are not in it.
 */
export async function exportChat(
  conversation: LocalConversation,
  title: string,
  selfUserId: string,
): Promise<void> {
  const users = await db.users.toArray();
  const nameOf = (userId: string) =>
    userId === selfUserId ? 'You' : users.find((u) => u.id === userId)?.displayName ?? 'Unknown';

  const messages = (
    await db.messages
      .where('[conversationId+seq]')
      .between([conversation.id, 0], [conversation.id, Number.MAX_SAFE_INTEGER], true, true)
      .toArray()
  ).sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt);

  const stamp = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  const lines = [
    `Chat export: ${title}`,
    `Exported ${stamp.format(new Date())}. Messages are end-to-end encrypted; this file is not.`,
    '',
  ];
  for (const message of messages) {
    const when = `[${stamp.format(new Date(message.createdAt))}]`;
    if (isSystemMessage(message)) {
      if (message.contentType === SYSTEM_GROUP_EVENT) {
        try {
          lines.push(`${when} ${describeGroupEvent(JSON.parse(message.body) as GroupEvent, selfUserId, nameOf)}`);
        } catch {
          // An unreadable notice is not worth failing the whole export over.
        }
      } else if (message.contentType === SYSTEM_IDENTITY_CHANGED) {
        lines.push(`${when} ${nameOf(message.senderId)}'s security code changed`);
      }
      continue;
    }
    if (message.control) continue; // an unsent reaction/edit/delete, not a message
    const body = message.deletedForAll
      ? '<this message was deleted>'
      : message.undecryptable
        ? '<message could not be decrypted>'
        : message.location
          ? `<${message.location.live ? 'live location' : 'location'}: ${message.location.lat}, ${message.location.lng}>`
          : `${message.forwarded ? '[forwarded] ' : ''}${message.body}${message.editedAt ? ' <edited>' : ''}`;
    // Continuation lines are indented so a multi-line message cannot pass for a new entry.
    lines.push(`${when} ${nameOf(message.senderId)}: ${body.replace(/\n/g, '\n    ')}`);
  }

  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `Chatter chat with ${title.replace(/[\\/:*?"<>|]/g, '_')}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
