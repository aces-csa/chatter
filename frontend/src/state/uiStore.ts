import { create } from 'zustand';
import type { ConnectionStatus } from '@/realtime/StompConnection';
import type { LocalMessage } from '@/db/db';

interface UiState {
  activeConversationId: string | null;
  connection: ConnectionStatus;
  newChatOpen: boolean;
  /** The contact whose safety number is on screen, or null. */
  safetyNumberUserId: string | null;
  newGroupOpen: boolean;
  disappearingOpen: boolean;
  accountOpen: boolean;
  muteOpen: boolean;
  devicesOpen: boolean;
  /** Files picked, pasted or dropped, waiting in the preview dialog for a caption and Send. */
  pendingAttachments: File[] | null;
  groupInfoOpen: boolean;
  /** An invite code from a link the user opened, waiting for them to confirm joining. */
  joinCode: string | null;
  // --- message actions (step 12); all scoped to the open chat ---
  replyingTo: LocalMessage | null;
  editing: LocalMessage | null;
  /** clientMessageIds; null when not in selection mode. */
  selection: string[] | null;
  forwarding: LocalMessage[] | null;
  deleting: LocalMessage[] | null;
  starredOpen: boolean;
  locationOpen: boolean;
  backupOpen: boolean;
  profileOpen: boolean;
  privacyOpen: boolean;
  galleryOpen: boolean;
  chatSearchOpen: boolean;
  messageInfo: LocalMessage | null;
  /** Bumped by Ctrl+K so the sidebar focuses its search box. */
  focusSearchAt: number;
  /** Scroll to and briefly highlight this message (reply quotes, starred list). */
  jumpTo: { messageId: string; at: number } | null;
  setActiveConversation: (id: string | null) => void;
  setConnection: (status: ConnectionStatus) => void;
  setNewChatOpen: (open: boolean) => void;
  setSafetyNumberUserId: (userId: string | null) => void;
  setNewGroupOpen: (open: boolean) => void;
  setDisappearingOpen: (open: boolean) => void;
  setAccountOpen: (open: boolean) => void;
  setMuteOpen: (open: boolean) => void;
  setDevicesOpen: (open: boolean) => void;
  setPendingAttachments: (files: File[] | null) => void;
  setGroupInfoOpen: (open: boolean) => void;
  setJoinCode: (code: string | null) => void;
  setReplyingTo: (message: LocalMessage | null) => void;
  setEditing: (message: LocalMessage | null) => void;
  setSelection: (ids: string[] | null) => void;
  toggleSelected: (id: string) => void;
  setForwarding: (messages: LocalMessage[] | null) => void;
  setDeleting: (messages: LocalMessage[] | null) => void;
  setStarredOpen: (open: boolean) => void;
  setLocationOpen: (open: boolean) => void;
  setBackupOpen: (open: boolean) => void;
  setProfileOpen: (open: boolean) => void;
  setPrivacyOpen: (open: boolean) => void;
  setGalleryOpen: (open: boolean) => void;
  setChatSearchOpen: (open: boolean) => void;
  setMessageInfo: (message: LocalMessage | null) => void;
  focusSearch: () => void;
  jumpToMessage: (messageId: string) => void;
  /** Opens a chat and jumps to a message in it, in one step so the jump survives the switch. */
  openMessage: (conversationId: string, messageId: string) => void;
}

/**
 * UI state only. Messages and conversations deliberately live in Dexie instead: they are
 * unbounded and persistent, which is a database's job, not a store's.
 */
export const useUiStore = create<UiState>((set) => ({
  activeConversationId: null,
  connection: 'idle',
  newChatOpen: false,
  safetyNumberUserId: null,
  newGroupOpen: false,
  disappearingOpen: false,
  accountOpen: false,
  muteOpen: false,
  devicesOpen: false,
  pendingAttachments: null,
  groupInfoOpen: false,
  joinCode: null,
  replyingTo: null,
  editing: null,
  selection: null,
  forwarding: null,
  deleting: null,
  starredOpen: false,
  locationOpen: false,
  backupOpen: false,
  profileOpen: false,
  privacyOpen: false,
  galleryOpen: false,
  chatSearchOpen: false,
  messageInfo: null,
  focusSearchAt: 0,
  jumpTo: null,
  // Info panels and half-finished actions belong to the chat they were started in.
  setActiveConversation: (activeConversationId) =>
    set({
      activeConversationId,
      groupInfoOpen: false,
      disappearingOpen: false,
      muteOpen: false,
      pendingAttachments: null,
      replyingTo: null,
      editing: null,
      selection: null,
      deleting: null,
      jumpTo: null,
      galleryOpen: false,
      chatSearchOpen: false,
      messageInfo: null,
    }),
  setConnection: (connection) => set({ connection }),
  setNewChatOpen: (newChatOpen) => set({ newChatOpen }),
  setSafetyNumberUserId: (safetyNumberUserId) => set({ safetyNumberUserId }),
  setNewGroupOpen: (newGroupOpen) => set({ newGroupOpen }),
  setDisappearingOpen: (disappearingOpen) => set({ disappearingOpen }),
  setAccountOpen: (accountOpen) => set({ accountOpen }),
  setMuteOpen: (muteOpen) => set({ muteOpen }),
  setDevicesOpen: (devicesOpen) => set({ devicesOpen }),
  setPendingAttachments: (pendingAttachments) =>
    set({ pendingAttachments: pendingAttachments?.length ? pendingAttachments : null }),
  setGroupInfoOpen: (groupInfoOpen) => set({ groupInfoOpen }),
  setJoinCode: (joinCode) => set({ joinCode }),
  // Replying and editing are mutually exclusive uses of the composer.
  setReplyingTo: (replyingTo) => set({ replyingTo, editing: null }),
  setEditing: (editing) => set({ editing, replyingTo: null }),
  setSelection: (selection) => set({ selection }),
  toggleSelected: (id) =>
    set((state) => {
      const current = state.selection ?? [];
      const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
      return { selection: next.length ? next : null };
    }),
  setForwarding: (forwarding) => set({ forwarding }),
  setDeleting: (deleting) => set({ deleting }),
  setStarredOpen: (starredOpen) => set({ starredOpen }),
  setLocationOpen: (locationOpen) => set({ locationOpen }),
  setBackupOpen: (backupOpen) => set({ backupOpen }),
  setProfileOpen: (profileOpen) => set({ profileOpen }),
  setPrivacyOpen: (privacyOpen) => set({ privacyOpen }),
  setGalleryOpen: (galleryOpen) => set({ galleryOpen }),
  setChatSearchOpen: (chatSearchOpen) => set({ chatSearchOpen }),
  setMessageInfo: (messageInfo) => set({ messageInfo }),
  focusSearch: () => set({ focusSearchAt: Date.now() }),
  jumpToMessage: (messageId) => set({ jumpTo: { messageId, at: Date.now() } }),
  openMessage: (activeConversationId, messageId) =>
    set({
      activeConversationId,
      groupInfoOpen: false,
      disappearingOpen: false,
      muteOpen: false,
      pendingAttachments: null,
      replyingTo: null,
      editing: null,
      selection: null,
      deleting: null,
      starredOpen: false,
      jumpTo: { messageId, at: Date.now() },
    }),
}));
