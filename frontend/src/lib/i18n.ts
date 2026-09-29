/**
 * i18n scaffolding (FR-9.5): English is the only shipped locale. UI strings go through t() with a
 * key, so adding a language is a new dictionary, not a code change. Missing keys fall back to
 * English, and a missing English key renders the key itself -- visible in review, never blank.
 *
 * <p>Migration is incremental: the chat list uses t() today; other screens move over as they
 * are touched. Plurals and interpolation are deliberately minimal ({name} placeholders).
 */
const en = {
  account: 'Account',
  newChat: 'New chat',
  newGroup: 'New group',
  starred: 'Starred messages',
  signOut: 'Sign out',
  searchPlaceholder: 'Search chats, people and messages',
  chats: 'Chats',
  contacts: 'Contacts',
  messages: 'Messages',
  noResults: 'Nothing matches that search.',
  noConversations: 'No conversations yet. Start one with the new-chat button above.',
  noMessagesYet: 'No messages yet',
  group: 'Group',
  unknownContact: 'Unknown contact',
  typing: 'typing…',
  recordingAudio: 'recording audio…',
  archived: 'Archived',
  backToChats: 'Back to chats',
  pinned: 'Pinned',
  muted: 'Muted',
  markedUnread: 'Marked as unread',
  pin: 'Pin chat',
  unpin: 'Unpin chat',
  archive: 'Archive chat',
  unarchive: 'Unarchive chat',
  markRead: 'Mark as read',
  markUnread: 'Mark as unread',
  deleteChat: 'Delete chat',
  chatOptions: 'Chat options',
} as const;

export type MessageKey = keyof typeof en;

const dictionaries: Record<string, Partial<Record<MessageKey, string>>> = { en };

function locale(): string {
  const preferred = (navigator.languages?.[0] ?? navigator.language ?? 'en').split('-')[0];
  return dictionaries[preferred] ? preferred : 'en';
}

export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  const template = dictionaries[locale()][key] ?? en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}
