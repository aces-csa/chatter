import { create } from 'zustand';

export interface Presence {
  status: 'online' | 'offline';
  lastSeenAt: number | null;
}

/** How long a typing indicator survives without a refresh. Matches the server's Redis TTL. */
const TYPING_TTL_MS = 5_000;

/** What someone is doing in a chat right now (FR-6.2, FR-6.3). */
export type Activity = 'typing' | 'recording';

interface ActivityEntry {
  kind: Activity;
  expiresAt: number;
}

interface PresenceState {
  presence: Record<string, Presence>;
  /** conversationId -> userId -> what they are doing, and when that indicator lapses. */
  typing: Record<string, Record<string, ActivityEntry>>;
  setPresence: (userId: string, presence: Presence) => void;
  /** @param activity null clears the indicator */
  setTyping: (conversationId: string, userId: string, activity: Activity | null) => void;
  typistsIn: (conversationId: string) => string[];
  recordersIn: (conversationId: string) => string[];
  isActiveIn: (conversationId: string) => Activity | null;
  reset: () => void;
}

export const usePresenceStore = create<PresenceState>((set, get) => ({
  presence: {},
  typing: {},

  setPresence: (userId, presence) =>
    set((state) => ({ presence: { ...state.presence, [userId]: presence } })),

  setTyping: (conversationId, userId, activity) =>
    set((state) => {
      const forConversation = { ...(state.typing[conversationId] ?? {}) };
      if (activity) {
        forConversation[userId] = { kind: activity, expiresAt: Date.now() + TYPING_TTL_MS };
      } else {
        delete forConversation[userId];
      }
      return { typing: { ...state.typing, [conversationId]: forConversation } };
    }),

  /**
   * Expiry is evaluated on read rather than by a timer. A "stop" frame can be lost, and a
   * stuck "typing…" that never clears is more annoying than one that fades a second late.
   */
  typistsIn: (conversationId) => activeUsers(get().typing[conversationId], 'typing'),

  recordersIn: (conversationId) => activeUsers(get().typing[conversationId], 'recording'),

  /** Recording outranks typing for the one-line chat-list preview. */
  isActiveIn: (conversationId) => {
    const entries = get().typing[conversationId];
    if (activeUsers(entries, 'recording').length > 0) return 'recording';
    if (activeUsers(entries, 'typing').length > 0) return 'typing';
    return null;
  },

  reset: () => set({ presence: {}, typing: {} }),
}));

function activeUsers(entries: Record<string, ActivityEntry> | undefined, kind: Activity): string[] {
  const now = Date.now();
  return Object.entries(entries ?? {})
    .filter(([, entry]) => entry.kind === kind && entry.expiresAt > now)
    .map(([userId]) => userId);
}
