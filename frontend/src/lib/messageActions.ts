import type { LocalMessage, ReplyRef } from '@/db/db';
import { mediaPreview } from '@/lib/media/labels';
import { DELETE_FOR_EVERYONE_WINDOW_MS, EDIT_WINDOW_MS } from '@/realtime/MessagePipeline';

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

export const MORE_REACTIONS = [
  '😀', '😁', '😅', '🤣', '😊', '😍', '😘', '😎', '🤔', '🙄', '😴', '😭',
  '😡', '🤯', '🥳', '🤝', '👏', '🙌', '💪', '👀', '🔥', '✨', '🎉', '💯',
  '✅', '❌', '⚡', '💔', '🤍', '💙', '💚', '💛', '👎', '👌', '🤞', '☕',
];

/** One line of text standing for a message: for quotes, previews and copy. */
export function snippetOf(message: LocalMessage): string {
  if (message.deletedForAll) return 'This message was deleted';
  if (message.undecryptable) return 'Waiting for this message';
  if (message.location) return message.location.live ? 'Live location' : 'Location';
  if (message.media) return mediaPreview(message.media, message.body);
  return message.body;
}

export function replyRefFor(message: LocalMessage): ReplyRef | undefined {
  if (!message.messageId) return undefined;
  const text = snippetOf(message);
  return {
    messageId: message.messageId,
    senderId: message.senderId,
    preview: text.length > 200 ? `${text.slice(0, 200)}…` : text,
  };
}

/** What each action requires; the menu offers only what will actually work. */
export function canReply(m: LocalMessage): boolean {
  return !!m.messageId && !m.deletedForAll && !m.undecryptable;
}
export const canReact = canReply;

export function canForward(m: LocalMessage): boolean {
  // View-once media is exactly what forwarding would defeat.
  return !m.deletedForAll && !m.undecryptable && !m.media?.viewOnce && (!m.media || !!m.media.mediaId);
}

export function canEdit(m: LocalMessage, selfUserId: string): boolean {
  return (
    m.senderId === selfUserId &&
    !!m.messageId &&
    !m.deletedForAll &&
    !m.media &&
    Date.now() - m.createdAt < EDIT_WINDOW_MS
  );
}

export function canDeleteForEveryone(m: LocalMessage, selfUserId: string): boolean {
  return (
    m.senderId === selfUserId &&
    !!m.messageId &&
    !m.deletedForAll &&
    Date.now() - m.createdAt < DELETE_FOR_EVERYONE_WINDOW_MS
  );
}

/** Multi-message copy keeps who said what, the way WhatsApp's copy does. */
export function copyText(
  messages: LocalMessage[],
  nameOf: (userId: string) => string,
): string {
  if (messages.length === 1) return messages[0].body;
  const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });
  return [...messages]
    .sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt)
    .map((m) => `[${time.format(new Date(m.createdAt))}] ${nameOf(m.senderId)}: ${snippetOf(m)}`)
    .join('\n');
}
