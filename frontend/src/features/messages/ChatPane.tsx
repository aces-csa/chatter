import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type LocalConversation, type LocalUser } from '@/db/db';
import { useAuthStore } from '@/state/authStore';
import { useUiStore } from '@/state/uiStore';
import { usePresenceStore } from '@/state/presenceStore';
import { realtimeService } from '@/realtime/RealtimeService';
import { presenceText, typingText } from '@/lib/presenceText';
import MessageList from './MessageList';
import Composer from './Composer';
import VerifiedIcon from '@/features/security/VerifiedIcon';
import TimerIcon from './TimerIcon';
import ChatMenu from './ChatMenu';
import AttachmentDialog from '@/features/media/AttachmentDialog';
import SelectionBar from './SelectionBar';
import ForwardDialog from './ForwardDialog';
import DeleteDialog from './DeleteDialog';
import ShareLocationDialog from '@/features/location/ShareLocationDialog';
import CallButtons from '@/features/calls/CallButtons';
import { exportChat } from '@/lib/exportChat';
import { isMuted } from '@/lib/notifications';
import { timerLabel } from '@/lib/groupEvents';
import Avatar from '@/ui/Avatar';
import Modal from '@/ui/Modal';
import ChatSearchBar from './ChatSearchBar';
import MediaGalleryDialog from './MediaGalleryDialog';
import MessageInfoDialog from './MessageInfoDialog';
import { clearChat, deleteChat, setBlocked } from '@/lib/chatState';

export default function ChatPane({ conversation }: { conversation: LocalConversation }) {
  const me = useAuthStore((s) => s.user);
  const setActive = useUiStore((s) => s.setActiveConversation);
  const showSafetyNumber = useUiStore((s) => s.setSafetyNumberUserId);
  const showGroupInfo = useUiStore((s) => s.setGroupInfoOpen);
  const pendingAttachments = useUiStore((s) => s.pendingAttachments);
  const selection = useUiStore((s) => s.selection);
  const forwarding = useUiStore((s) => s.forwarding);
  const deleting = useUiStore((s) => s.deleting);
  const locationOpen = useUiStore((s) => s.locationOpen);
  const chatSearchOpen = useUiStore((s) => s.chatSearchOpen);
  const galleryOpen = useUiStore((s) => s.galleryOpen);
  const messageInfo = useUiStore((s) => s.messageInfo);
  const blockedList = useLiveQuery(async () => ((await db.meta.get('blockedUserIds'))?.value as string[]) ?? [], [], [] as string[]);
  const [confirming, setConfirming] = useState<{ title: string; body: string; action: () => Promise<void> } | null>(null);
  const [dragging, setDragging] = useState(false);
  const isGroup = conversation.type === 'GROUP';
  const otherIdForBlock = conversation.participantIds.find((id) => id !== me?.id);
  const iBlockedThem = !isGroup && !!otherIdForBlock && blockedList.includes(otherIdForBlock);
  const blocked = iBlockedThem
    ? 'You blocked this contact. Unblock them to send a message.'
    : composerBlock(conversation, me?.id);

  const users = useLiveQuery(() => db.users.toArray(), [], []);
  const messages = useLiveQuery(
    () =>
      db.messages
        .where('[conversationId+seq]')
        .between([conversation.id, 0], [conversation.id, Number.MAX_SAFE_INTEGER], true, true)
        .toArray(),
    [conversation.id],
    [],
  );

  const otherId = useMemo(
    () => conversation.participantIds.find((id) => id !== me?.id),
    [conversation.participantIds, me?.id],
  );

  const title = useMemo(() => {
    if (conversation.type === 'GROUP') return conversation.subject ?? 'Group';
    return users.find((user) => user.id === otherId)?.displayName ?? 'Unknown contact';
  }, [conversation, users, otherId]);

  const subtitle = useChatSubtitle(conversation, users, otherId);
  const verified = useLiveQuery(
    async () => (otherId && conversation.type === 'DIRECT'
      ? (await db.contactTrust.get(otherId))?.verified === true
      : false),
    [otherId, conversation.type],
    false,
  );
  const nameOf = (userId: string) =>
    users.find((user) => user.id === userId)?.displayName ?? 'A contact';

  // Mark read when the conversation is open and something new has arrived. Coalesced to one
  // frame carrying the highest sequence, never one per message. Local notices carry
  // fractional seqs the server has never issued, so only whole numbers count.
  useEffect(() => {
    const highest = messages.reduce(
      (max, message) =>
        message.seq < Number.MAX_SAFE_INTEGER && Number.isInteger(message.seq)
          ? Math.max(max, message.seq)
          : max,
      0,
    );
    if (highest > conversation.lastReadSeq) {
      void realtimeService.markRead(conversation.id, highest);
    }
  }, [messages, conversation.id, conversation.lastReadSeq]);

  return (
    <div
      className="relative flex h-full flex-col"
      onDragOver={(event) => {
        if (blocked || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(event) => {
        setDragging(false);
        if (blocked || event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        useUiStore.getState().setPendingAttachments(Array.from(event.dataTransfer.files));
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center border-2 border-dashed border-accent bg-panel/80 text-lg">
          Drop to send
        </div>
      )}
      {pendingAttachments && !blocked && (
        <AttachmentDialog conversationId={conversation.id} files={pendingAttachments} />
      )}
      <header className="flex items-center gap-3 border-b border-stroke bg-panel px-4 py-2.5">
        <button
          onClick={() => setActive(null)}
          className="rounded-full p-1.5 text-text-secondary hover:bg-panel-hover md:hidden"
          aria-label="Back to conversations"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true">
            <path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20v-2Z" />
          </svg>
        </button>
        {/* A div, not a button: the direct-chat subtitle below holds its own button. */}
        <div
          className={`flex min-w-0 items-center gap-3 ${isGroup ? 'cursor-pointer' : ''}`}
          {...(isGroup
            ? {
                role: 'button',
                tabIndex: 0,
                'aria-label': `${title}, group info`,
                onClick: () => showGroupInfo(true),
                onKeyDown: (event: React.KeyboardEvent) => {
                  if (event.key === 'Enter' || event.key === ' ') showGroupInfo(true);
                },
              }
            : {})}
        >
          <Avatar name={title} src={isGroup ? undefined : users.find((u) => u.id === otherId)?.avatar} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 truncate font-medium">
              {title}
              {verified && (
                <span title="Security code verified">
                  <VerifiedIcon className="h-4 w-4 shrink-0 fill-accent" />
                  <span className="sr-only">(verified)</span>
                </span>
              )}
            </div>
            <div
              className={`truncate text-xs ${
                subtitle.tone === 'typing' ? 'text-accent' : 'text-text-secondary'
              }`}
              aria-live="polite"
            >
              {subtitle.text ?? (
                <button
                  onClick={() => otherId && conversation.type === 'DIRECT' && showSafetyNumber(otherId)}
                  disabled={conversation.type !== 'DIRECT'}
                  className="flex items-center gap-1 enabled:hover:underline"
                  title={conversation.type === 'DIRECT' ? 'Verify security code' : undefined}
                >
                  <svg viewBox="0 0 24 24" className="h-3 w-3 fill-current" aria-hidden="true">
                    <path d="M18 8h-1V6a5 5 0 0 0-10 0v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2ZM9 6a3 3 0 0 1 6 0v2H9V6Z" />
                  </svg>
                  End-to-end encrypted
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="ml-auto flex items-center">
          <CallButtons conversation={conversation} />
          {/* Shown only while a timer is on: it is a warning as much as a control. */}
          {!!conversation.disappearingSeconds && (
            <button
              onClick={() => useUiStore.getState().setDisappearingOpen(true)}
              className="rounded-full p-2 text-accent hover:bg-panel-hover"
              aria-label={`Disappearing messages: ${timerLabel(conversation.disappearingSeconds)}`}
              title={`Disappearing messages: ${timerLabel(conversation.disappearingSeconds)}`}
            >
              <TimerIcon className="h-5 w-5 fill-current" />
            </button>
          )}
          {conversation.type === 'DIRECT' && otherId && (
            <button
              onClick={() => showSafetyNumber(otherId)}
              className="rounded-full p-2 text-text-secondary hover:bg-panel-hover"
              aria-label="Verify security code"
              title="Verify security code"
            >
              <VerifiedIcon className="h-5 w-5 fill-current" />
            </button>
          )}
          <ChatMenu
            items={[
              ...(isGroup ? [{ label: 'Group info', onSelect: () => showGroupInfo(true) }] : []),
              {
                label: 'Disappearing messages',
                onSelect: () => useUiStore.getState().setDisappearingOpen(true),
                disabled: conversation.left,
              },
              {
                label: isMuted(conversation.mutedUntil) ? 'Unmute notifications' : 'Mute notifications',
                onSelect: () => useUiStore.getState().setMuteOpen(true),
                disabled: conversation.left,
              },
              { label: 'Search', onSelect: () => useUiStore.getState().setChatSearchOpen(true) },
              { label: 'Media, links and docs', onSelect: () => useUiStore.getState().setGalleryOpen(true) },
              {
                label: 'Export chat',
                onSelect: () => void exportChat(conversation, title, me?.id ?? ''),
              },
              ...(!isGroup && otherId
                ? [{
                    label: iBlockedThem ? `Unblock ${title}` : `Block ${title}`,
                    onSelect: () =>
                      iBlockedThem
                        ? void setBlocked(otherId, false)
                        : setConfirming({
                            title: `Block ${title}?`,
                            body: "They won't be able to message or call you, see your last seen, photo or about. They won't be told.",
                            action: () => setBlocked(otherId, true),
                          }),
                  }]
                : []),
              {
                label: 'Clear chat',
                onSelect: () =>
                  setConfirming({
                    title: 'Clear this chat?',
                    body: 'All messages are removed from this device. Other people and your other devices keep theirs.',
                    action: () => clearChat(conversation.id),
                  }),
              },
              {
                label: 'Delete chat',
                onSelect: () =>
                  setConfirming({
                    title: 'Delete this chat?',
                    body: isGroup && !conversation.left
                      ? 'Exit the group first (Group info → Exit group); a group you are still in would come straight back.'
                      : 'The chat and its messages are removed from this device.',
                    action: async () => {
                      await deleteChat(conversation);
                      setActive(null);
                    },
                  }),
              },
            ]}
          />
        </div>
      </header>

      {chatSearchOpen && <ChatSearchBar conversationId={conversation.id} />}
      <MessageList
        messages={messages}
        selfUserId={me?.id ?? ''}
        isGroup={isGroup}
        nameOf={nameOf}
        onVerify={showSafetyNumber}
      />
      {selection ? (
        <SelectionBar
          selected={messages.filter((m) => selection.includes(m.clientMessageId))}
          nameOf={nameOf}
        />
      ) : (
        <Composer
          conversationId={conversation.id}
          disabledReason={blocked}
          nameOf={nameOf}
          mentionable={isGroup ? conversation.participantIds.filter((id) => id !== me?.id) : []}
        />
      )}
      {forwarding && <ForwardDialog messages={forwarding} />}
      {deleting && <DeleteDialog messages={deleting} />}
      {locationOpen && !blocked && <ShareLocationDialog conversationId={conversation.id} />}
      {galleryOpen && <MediaGalleryDialog conversationId={conversation.id} />}
      {messageInfo && <MessageInfoDialog message={messageInfo} />}
      {confirming && <ConfirmDialog {...confirming} onClose={() => setConfirming(null)} />}
    </div>
  );
}

/** Two-step confirmation for destructive chat actions; a native confirm() would block the tab. */
function ConfirmDialog({
  title,
  body,
  action,
  onClose,
}: {
  title: string;
  body: string;
  action: () => Promise<void>;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={title} onClose={onClose}>
      <p className="text-sm text-text-secondary">{body}</p>
      {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="px-3 py-1.5 text-sm text-text-secondary">Cancel</button>
        <button
          onClick={() => void action().then(onClose, (e: unknown) => setError(e instanceof Error ? e.message : 'That did not work'))}
          className="rounded-lg bg-red-500/80 px-3 py-1.5 text-sm font-medium text-white"
        >
          Confirm
        </button>
      </div>
    </Modal>
  );
}

/** Why this user cannot post here, or null if they can. */
function composerBlock(conversation: LocalConversation, selfId: string | undefined): string | null {
  if (conversation.left) {
    return "You can't send messages to this group because you're no longer a participant.";
  }
  if (conversation.type === 'GROUP' && conversation.onlyAdminsCanPost) {
    const role = conversation.members?.find((m) => m.userId === selfId)?.role;
    if (role !== 'OWNER' && role !== 'ADMIN') return 'Only admins can send messages.';
  }
  return null;
}

/**
 * Typing beats presence beats the encryption note — the most transient, most informative thing
 * wins the one line we have.
 */
function useChatSubtitle(
  conversation: LocalConversation,
  users: LocalUser[],
  otherId: string | undefined,
): { text: string | null; tone: 'typing' | 'presence' } {
  const presence = usePresenceStore((s) => (otherId ? s.presence[otherId] : undefined));
  const typingMap = usePresenceStore((s) => s.typing[conversation.id]);
  const typistsIn = usePresenceStore((s) => s.typistsIn);
  const recordersIn = usePresenceStore((s) => s.recordersIn);

  // Indicators expire on read, so re-evaluate on a timer rather than trusting a stop frame
  // that may never arrive.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!typingMap || Object.keys(typingMap).length === 0) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [typingMap]);

  const typists = typistsIn(conversation.id);
  const nameOf = (userId: string) =>
    users.find((user) => user.id === userId)?.displayName ?? 'Someone';

  const typing = typingText(
    typists,
    nameOf,
    conversation.type === 'GROUP',
    recordersIn(conversation.id),
  );
  if (typing) return { text: typing, tone: 'typing' };

  if (conversation.type === 'GROUP') {
    return { text: `${conversation.participantIds.length} members`, tone: 'presence' };
  }
  return { text: presenceText(presence), tone: 'presence' };
}
