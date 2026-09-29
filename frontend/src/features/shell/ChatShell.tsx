import { lazy, Suspense, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { api } from '@/lib/api';
import { useUiStore } from '@/state/uiStore';
import { realtimeService } from '@/realtime/RealtimeService';
import Sidebar from '@/features/chats/Sidebar';
import ChatPane from '@/features/messages/ChatPane';
import NewChatDialog from '@/features/chats/NewChatDialog';
import NewGroupDialog from '@/features/groups/NewGroupDialog';
import GroupInfoDialog from '@/features/groups/GroupInfoDialog';
import JoinGroupDialog from '@/features/groups/JoinGroupDialog';
import DisappearingDialog from '@/features/messages/DisappearingDialog';
import AccountDialog from '@/features/account/AccountDialog';
import MuteDialog from '@/features/messages/MuteDialog';
import LinkedDevicesDialog from '@/features/account/LinkedDevicesDialog';
import BackupDialog from '@/features/account/BackupDialog';
import CallOverlay from '@/features/calls/CallOverlay';
import ProfileDialog from '@/features/account/ProfileDialog';
import PrivacyDialog from '@/features/account/PrivacyDialog';
import { loadBlocks } from '@/lib/chatState';
import { cachePrivacy } from '@/lib/quietHours';
import StarredDialog from '@/features/messages/StarredDialog';
import { cacheUsers, toLocalConversation } from '@/db/conversations';

// Rarely opened and carries the QR encoder, so it stays out of the initial bundle.
const SafetyNumberDialog = lazy(() => import('@/features/security/SafetyNumberDialog'));

/**
 * Two-pane on desktop, single-pane on mobile: the chat list is replaced by the conversation
 * once one is open, which is the only layout that works at phone width.
 */
export default function ChatShell() {
  const activeConversationId = useUiStore((s) => s.activeConversationId);
  const newChatOpen = useUiStore((s) => s.newChatOpen);
  const safetyNumberUserId = useUiStore((s) => s.safetyNumberUserId);
  const newGroupOpen = useUiStore((s) => s.newGroupOpen);
  const groupInfoOpen = useUiStore((s) => s.groupInfoOpen);
  const joinCode = useUiStore((s) => s.joinCode);
  const disappearingOpen = useUiStore((s) => s.disappearingOpen);
  const accountOpen = useUiStore((s) => s.accountOpen);
  const muteOpen = useUiStore((s) => s.muteOpen);
  const devicesOpen = useUiStore((s) => s.devicesOpen);
  const backupOpen = useUiStore((s) => s.backupOpen);
  const profileOpen = useUiStore((s) => s.profileOpen);
  const privacyOpen = useUiStore((s) => s.privacyOpen);

  // Block list and privacy settings, cached for the composer, notifications and quiet hours.
  useEffect(() => {
    void loadBlocks().catch(() => undefined);
    void api.privacy().then(cachePrivacy).catch(() => undefined);
  }, []);

  useKeyboardShortcuts();
  const starredOpen = useUiStore((s) => s.starredOpen);

  // FR-8.2: "(3) Chatter" in the tab title, so unread messages show from any other tab.
  const unread = useLiveQuery(
    async () => (await db.conversations.toArray()).reduce((sum, c) => sum + (c.unreadCount || 0), 0),
    [],
    0,
  );
  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) Chatter` : 'Chatter';
  }, [unread]);

  // Reconcile the server's conversation list into Dexie once on mount. After this the list is
  // maintained by realtime frames; this is only the cold-start path.
  useEffect(() => {
    void (async () => {
      try {
        const remote = await api.conversations();
        await db.transaction('rw', db.conversations, async () => {
          for (const conversation of remote) {
            const local = await db.conversations.get(conversation.id);
            await db.conversations.put(toLocalConversation(conversation, local));
          }
          // A group we left while this device was offline is simply absent from the list.
          // Keep its history, but stop offering a composer for it.
          const live = new Set(remote.map((c) => c.id));
          await db.conversations
            .filter((c) => c.type === 'GROUP' && !live.has(c.id) && !c.left)
            .modify({ left: true });
        });

        // Cache the people in them, so the list can render names without a request per row.
        await cacheUsers([...new Set(remote.flatMap((c) => c.participantIds))]);
        // The socket may have connected before this list existed, in which case the initial
        // presence subscription covered nobody. Re-subscribe now that we know the participants.
        await realtimeService.subscribeToPresence();
      } catch (error) {
        // Offline start is a supported state: Dexie already holds everything we need.
        console.warn('[shell] Could not refresh conversations; using the local copy', error);
      }
    })();
  }, []);

  const activeConversation = useLiveQuery(
    () => (activeConversationId ? db.conversations.get(activeConversationId) : undefined),
    [activeConversationId],
  );

  return (
    <div className="flex h-full overflow-hidden bg-chat-bg">
      <div
        className={`w-full shrink-0 border-r border-stroke md:w-[380px] lg:w-[420px] ${
          activeConversationId ? 'hidden md:block' : 'block'
        }`}
      >
        <Sidebar />
      </div>

      <div className={`min-w-0 flex-1 ${activeConversationId ? 'block' : 'hidden md:block'}`}>
        {activeConversation ? (
          <ChatPane conversation={activeConversation} />
        ) : (
          <EmptyState />
        )}
      </div>

      {newChatOpen && <NewChatDialog />}
      {newGroupOpen && <NewGroupDialog />}
      {joinCode && <JoinGroupDialog code={joinCode} />}
      {accountOpen && <AccountDialog />}
      {devicesOpen && <LinkedDevicesDialog />}
      {backupOpen && <BackupDialog />}
      <CallOverlay />
      {profileOpen && <ProfileDialog />}
      {privacyOpen && <PrivacyDialog />}
      {starredOpen && <StarredDialog />}
      {muteOpen && activeConversation && <MuteDialog conversation={activeConversation} />}
      {disappearingOpen && activeConversation && (
        <DisappearingDialog conversation={activeConversation} />
      )}
      {groupInfoOpen && activeConversation?.type === 'GROUP' && (
        <GroupInfoDialog conversation={activeConversation} />
      )}
      {safetyNumberUserId && (
        <Suspense fallback={null}>
          <SafetyNumberDialog userId={safetyNumberUserId} />
        </Suspense>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center border-b-4 border-accent/60 bg-panel px-8 text-center">
      <svg viewBox="0 0 24 24" className="mb-6 h-20 w-20 fill-text-secondary/20" aria-hidden="true">
        <path d="M12 2a10 10 0 0 0-8.7 14.9L2 22l5.3-1.4A10 10 0 1 0 12 2Z" />
      </svg>
      <h2 className="text-2xl font-light text-text-primary">Chatter for Web</h2>
      <p className="mt-3 max-w-md text-sm text-text-secondary">
        Select a conversation to start messaging. Your messages are end-to-end encrypted — the
        server stores ciphertext it cannot read.
      </p>
    </div>
  );
}

/**
 * FR-9.4. Ctrl+K search, Ctrl+Alt+N new chat, Alt+Up/Down previous/next chat, Esc backs out of
 * selection, reply or edit. Chosen not to collide with browser shortcuts (Ctrl+N, Ctrl+T...).
 */
function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const ui = useUiStore.getState();
      if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        ui.focusSearch();
      } else if (event.ctrlKey && event.altKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        ui.setNewChatOpen(true);
      } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        void db.conversations.toArray().then((all) => {
          const ordered = all
            .filter((c) => !c.archived)
            .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
          const at = ordered.findIndex((c) => c.id === ui.activeConversationId);
          const next = ordered[Math.min(ordered.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))];
          if (next) ui.setActiveConversation(next.id);
        });
      } else if (event.key === 'Escape') {
        if (ui.selection) ui.setSelection(null);
        else if (ui.replyingTo || ui.editing) { ui.setReplyingTo(null); ui.setEditing(null); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
