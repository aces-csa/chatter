import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type LocalConversation, type LocalMessage, type LocalUser } from '@/db/db';
import { useAuthStore } from '@/state/authStore';
import { useUiStore } from '@/state/uiStore';
import { usePresenceStore } from '@/state/presenceStore';
import ConnectionBanner from '@/features/shell/ConnectionBanner';
import NotificationPrompt from '@/features/shell/NotificationPrompt';
import { isMuted } from '@/lib/notifications';
import { formatListTimestamp } from '@/lib/format';
import { searchMessages, highlight } from '@/lib/search';
import { snippetOf } from '@/lib/messageActions';
import { deleteChat, markChatRead, setChatState } from '@/lib/chatState';
import { api } from '@/lib/api';
import { saveConversation } from '@/db/conversations';
import { t } from '@/lib/i18n';
import Avatar from '@/ui/Avatar';

export default function Sidebar() {
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [messageHits, setMessageHits] = useState<LocalMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const me = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  const setActive = useUiStore((s) => s.setActiveConversation);
  const activeId = useUiStore((s) => s.activeConversationId);
  const focusSearchAt = useUiStore((s) => s.focusSearchAt);

  const conversations = useLiveQuery(() => db.conversations.toArray(), [], [] as LocalConversation[]);
  const users = useLiveQuery(() => db.users.toArray(), [], [] as LocalUser[]);
  // Subscribed for re-renders; the read below evaluates expiry.
  usePresenceStore((s) => s.typing);
  const activityIn = usePresenceStore((s) => s.isActiveIn);

  // Ctrl+K (see ChatShell) lands here.
  useEffect(() => {
    if (focusSearchAt) searchInput.current?.focus();
  }, [focusSearchAt]);

  const byId = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);
  const otherOf = (c: LocalConversation) => byId.get(c.participantIds.find((id) => id !== me?.id) ?? '');
  const nameFor = (c: LocalConversation): string =>
    c.type === 'GROUP' ? c.subject ?? t('group') : otherOf(c)?.displayName ?? t('unknownContact');

  const needle = query.trim().toLocaleLowerCase();
  useEffect(() => {
    let cancelled = false;
    void searchMessages(query, { limit: 30 }).then((hits) => !cancelled && setMessageHits(hits));
    return () => {
      cancelled = true;
    };
  }, [query]);

  // Sorted in memory rather than with orderBy('lastMessageAt'): Dexie's index ordering skips
  // records whose indexed value is undefined, which would hide brand-new empty chats.
  const byRecency = (a: LocalConversation, b: LocalConversation) =>
    (b.lastMessageAt ?? Infinity) - (a.lastMessageAt ?? Infinity);
  const archived = conversations.filter((c) => c.archived);
  const list = needle
    ? conversations.filter((c) => nameFor(c).toLocaleLowerCase().includes(needle)).sort(byRecency)
    : (showArchived ? archived : conversations.filter((c) => !c.archived)).sort(
        (a, b) => Number(!!b.pinned) - Number(!!a.pinned) || byRecency(a, b),
      );

  // Search also finds people you have not chatted with yet (FR-7.4 "by contact").
  const directWith = new Set(
    conversations.filter((c) => c.type === 'DIRECT').flatMap((c) => c.participantIds),
  );
  const contactHits = needle
    ? users.filter((u) => u.id !== me?.id && !directWith.has(u.id) && u.displayName.toLocaleLowerCase().includes(needle))
    : [];

  async function openContact(user: LocalUser) {
    try {
      const conversation = await saveConversation(await api.createDirect(user.id));
      setQuery('');
      setActive(conversation.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open that chat');
    }
  }

  const act = (fn: () => Promise<void>) => () =>
    void fn().catch((e: unknown) => setError(e instanceof Error ? e.message : 'That did not work'));

  return (
    <div className="flex h-full flex-col bg-panel">
      <header className="flex items-center justify-between border-b border-stroke px-4 py-3">
        <button
          onClick={() => useUiStore.getState().setAccountOpen(true)}
          aria-label={t('account')}
          title={t('account')}
          className="flex min-w-0 items-center gap-3 rounded-lg text-left hover:opacity-80"
        >
          <Avatar name={me?.displayName ?? '?'} src={me?.avatar} />
          <span className="truncate text-sm font-medium">{me?.displayName}</span>
        </button>
        <div className="flex items-center gap-1">
          <IconButton title={t('newChat')} onClick={() => useUiStore.getState().setNewChatOpen(true)}>
            <path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2Zm-7 9h-2v3h-2v-3H6V9h3V6h2v3h3Z" />
          </IconButton>
          <IconButton title={t('starred')} onClick={() => useUiStore.getState().setStarredOpen(true)}>
            <path d="m12 17.3 6.2 3.7-1.6-7L22 9.2l-7.2-.6L12 2 9.2 8.6 2 9.2 7.4 14l-1.6 7z" />
          </IconButton>
          <IconButton title={t('newGroup')} onClick={() => useUiStore.getState().setNewGroupOpen(true)}>
            <path d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13Zm8 0c-.3 0-.6 0-1 .1 1.2.8 2 2 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5Z" />
          </IconButton>
          <IconButton title={t('signOut')} onClick={() => void signOut()}>
            <path d="M17 7l-1.4 1.4L18.2 11H8v2h10.2l-2.6 2.6L17 17l5-5-5-5ZM4 5h8V3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8v-2H4V5Z" />
          </IconButton>
        </div>
      </header>

      <ConnectionBanner />
      <NotificationPrompt />

      <div className="px-3 py-2">
        <input
          ref={searchInput}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => event.key === 'Escape' && setQuery('')}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchPlaceholder')}
          className="w-full rounded-lg bg-panel-alt px-3 py-2 text-sm outline-none placeholder:text-text-secondary/60 focus:ring-1 focus:ring-accent/40"
        />
      </div>
      {error && (
        <p role="alert" className="mx-3 mb-2 rounded bg-red-500/10 px-3 py-1.5 text-xs text-red-300" onClick={() => setError(null)}>
          {error}
        </p>
      )}

      <div className="scrollbar-thin flex-1 overflow-y-auto">
        {!needle && archived.length > 0 && (
          <button
            onClick={() => setShowArchived(!showArchived)}
            className="flex w-full items-center gap-3 border-b border-stroke/40 px-4 py-3 text-left text-sm hover:bg-panel-hover"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5 fill-accent" aria-hidden="true">
              <path d="M20.5 5.2 19.1 3.5a1.5 1.5 0 0 0-1.1-.5H6a1.5 1.5 0 0 0-1.2.5L3.5 5.2A2 2 0 0 0 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5a2 2 0 0 0-.5-1.3ZM12 17.5 6.5 12H10v-2h4v2h3.5L12 17.5ZM5.1 5l.8-1h12l.9 1H5.1Z" />
            </svg>
            <span className="flex-1">{showArchived ? t('backToChats') : t('archived')}</span>
            {!showArchived && <span className="text-xs text-text-secondary">{archived.length}</span>}
          </button>
        )}

        {needle && <SectionLabel>{t('chats')}</SectionLabel>}
        {list.length === 0 && !needle && (
          <p className="px-4 py-8 text-center text-sm text-text-secondary">{t('noConversations')}</p>
        )}
        {list.map((conversation) => {
          const other = conversation.type === 'DIRECT' ? otherOf(conversation) : undefined;
          const activity = activityIn(conversation.id);
          const unread = conversation.unreadCount > 0 || conversation.markedUnread;
          return (
            <div key={conversation.id} className={`group relative border-b border-stroke/40 ${activeId === conversation.id ? 'bg-panel-hover' : ''}`}>
              <button
                onClick={() => setActive(conversation.id)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-panel-hover"
              >
                <Avatar name={nameFor(conversation)} src={other?.avatar} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium">{nameFor(conversation)}</span>
                    <span className={`shrink-0 text-xs ${unread ? 'text-accent' : 'text-text-secondary'}`}>
                      {conversation.lastMessageAt ? formatListTimestamp(conversation.lastMessageAt) : ''}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    {activity ? (
                      <span className="truncate text-sm text-accent">{activity === 'recording' ? t('recordingAudio') : t('typing')}</span>
                    ) : (
                      <span className="truncate text-sm text-text-secondary">{conversation.lastMessagePreview ?? t('noMessagesYet')}</span>
                    )}
                    <span className="flex shrink-0 items-center gap-1 pr-5">
                      {conversation.pinned && (
                        <svg viewBox="0 0 24 24" className="h-4 w-4 fill-text-secondary" aria-label={t('pinned')} role="img">
                          <path d="M16 3v2h-1v6l2 3v2h-4v5l-1 1-1-1v-5H7v-2l2-3V5H8V3h8Z" />
                        </svg>
                      )}
                      {isMuted(conversation.mutedUntil) && (
                        <svg viewBox="0 0 24 24" className="h-4 w-4 fill-text-secondary" aria-label={t('muted')} role="img">
                          <path d="M16.5 12a4.5 4.5 0 0 0-2.5-4v2.2l2.5 2.4v-.6ZM19 12c0 .9-.2 1.8-.5 2.6l1.5 1.5A8.8 8.8 0 0 0 21 12a9 9 0 0 0-7-8.8v2A7 7 0 0 1 19 12ZM4.3 3 3 4.3 7.7 9H3v6h4l5 5v-6.7l4.3 4.2c-.7.5-1.4.9-2.3 1.2v2a9 9 0 0 0 3.7-1.8l2 2 1.3-1.3-9-9L4.3 3ZM12 4 9.9 6.1 12 8.2V4Z" />
                        </svg>
                      )}
                      {conversation.unreadCount > 0 ? (
                        <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-white">{conversation.unreadCount}</span>
                      ) : conversation.markedUnread ? (
                        <span className="h-3 w-3 rounded-full bg-accent" aria-label={t('markedUnread')} role="img" />
                      ) : null}
                    </span>
                  </div>
                </div>
              </button>
              <RowMenu
                items={[
                  {
                    label: conversation.pinned ? t('unpin') : t('pin'),
                    run: act(() => setChatState(conversation, { pinned: !conversation.pinned })),
                  },
                  {
                    label: conversation.archived ? t('unarchive') : t('archive'),
                    run: act(() => setChatState(conversation, { archived: !conversation.archived })),
                  },
                  unread
                    ? { label: t('markRead'), run: act(() => markChatRead(conversation).then(() => setChatState(conversation, { markedUnread: false }))) }
                    : { label: t('markUnread'), run: act(() => setChatState(conversation, { markedUnread: true })) },
                  {
                    label: t('deleteChat'),
                    danger: true,
                    run: act(async () => {
                      await deleteChat(conversation);
                      if (activeId === conversation.id) setActive(null);
                    }),
                  },
                ]}
              />
            </div>
          );
        })}

        {contactHits.length > 0 && <SectionLabel>{t('contacts')}</SectionLabel>}
        {contactHits.map((user) => (
          <button
            key={user.id}
            onClick={() => void openContact(user)}
            className="flex w-full items-center gap-3 border-b border-stroke/40 px-4 py-3 text-left hover:bg-panel-hover"
          >
            <Avatar name={user.displayName} src={user.avatar} />
            <span className="min-w-0">
              <span className="block truncate font-medium">{user.displayName}</span>
              {user.about && <span className="block truncate text-sm text-text-secondary">{user.about}</span>}
            </span>
          </button>
        ))}

        {messageHits.length > 0 && <SectionLabel>{t('messages')}</SectionLabel>}
        {messageHits.map((m) => {
          const conversation = conversations.find((c) => c.id === m.conversationId);
          return (
            <button
              key={m.clientMessageId}
              onClick={() => m.messageId && useUiStore.getState().openMessage(m.conversationId, m.messageId)}
              className="block w-full border-b border-stroke/40 px-4 py-2.5 text-left hover:bg-panel-hover"
            >
              <span className="flex justify-between gap-2 text-xs text-text-secondary">
                <span className="truncate">{conversation ? nameFor(conversation) : ''}</span>
                <span className="shrink-0">{formatListTimestamp(m.createdAt)}</span>
              </span>
              <span className="line-clamp-2 text-sm">
                {highlight(snippetOf(m), query).map((part, i) =>
                  part.hit ? <mark key={i} className="rounded bg-accent/30 text-text-primary">{part.text}</mark> : <span key={i}>{part.text}</span>,
                )}
              </span>
            </button>
          );
        })}

        {needle && list.length === 0 && contactHits.length === 0 && messageHits.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-text-secondary">{t('noResults')}</p>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-accent">{children}</p>;
}

function RowMenu({ items }: { items: Array<{ label: string; run: () => void; danger?: boolean }> }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => !root.current?.contains(event.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div ref={root} className="absolute right-2 top-1/2 -translate-y-1/2">
      <button
        onClick={() => setOpen(!open)}
        aria-label={t('chatOptions')}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`rounded-full p-1 text-text-secondary hover:bg-panel ${open ? 'opacity-100' : 'opacity-0 focus:opacity-100 group-hover:opacity-100'}`}
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
          <path d="m7 10 5 5 5-5z" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-7 z-30 w-44 rounded-lg border border-stroke bg-panel-alt py-1 shadow-xl">
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.run();
              }}
              className={`block w-full px-4 py-2 text-left text-sm hover:bg-panel-hover ${item.danger ? 'text-red-300' : ''}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className="rounded-full p-2 text-text-secondary transition hover:bg-panel-hover hover:text-text-primary"
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}
