import { create } from 'zustand';
import { api, configureApi, type UserDto } from '@/lib/api';
import { db } from '@/db/db';
import { dropPushSubscription } from '@/lib/notifications';

const STORAGE_KEY = 'chatter.session';

interface PersistedSession {
  accessToken: string;
  refreshToken: string;
  userId: string;
  deviceId: string;
}

interface AuthState {
  user: UserDto | null;
  deviceId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  status: 'loading' | 'signed-out' | 'signed-in';
  setSession: (user: UserDto, deviceId: string, access: string, refresh: string) => void;
  restore: () => Promise<void>;
  signOut: () => Promise<void>;
}

function persist(session: PersistedSession | null): void {
  try {
    if (session) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Private-window or blocked storage. The session stays in memory for this tab, which is
    // degraded but usable, so this is not worth failing over.
  }
}

function readPersisted(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedSession) : null;
  } catch {
    return null;
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  deviceId: null,
  accessToken: null,
  refreshToken: null,
  status: 'loading',

  setSession: (user, deviceId, accessToken, refreshToken) => {
    persist({ accessToken, refreshToken, userId: user.id, deviceId });
    set({ user, deviceId, accessToken, refreshToken, status: 'signed-in' });
  },

  restore: async () => {
    const persisted = readPersisted();
    if (!persisted) {
      set({ status: 'signed-out' });
      return;
    }
    set({
      accessToken: persisted.accessToken,
      refreshToken: persisted.refreshToken,
      deviceId: persisted.deviceId,
    });

    try {
      const user = await api.me();
      set({ user, status: 'signed-in' });
    } catch {
      // The stored access token is stale. Go through the same single-flight refresh the API
      // client uses -- a second, independent refresh path here is exactly how you end up
      // presenting an already-rotated token and tripping reuse detection.
      const refreshed = await refreshOnce();
      if (!refreshed) {
        persist(null);
        set({ user: null, accessToken: null, refreshToken: null, status: 'signed-out' });
        return;
      }
      try {
        set({ user: await api.me(), status: 'signed-in' });
      } catch {
        persist(null);
        set({ user: null, accessToken: null, refreshToken: null, status: 'signed-out' });
      }
    }
  },

  signOut: async () => {
    const { refreshToken } = get();
    // While the token still works: the server must stop pushing to this browser.
    await dropPushSubscription().catch(() => undefined);
    if (refreshToken) {
      await api.logout(refreshToken).catch(() => undefined);
    }
    persist(null);
    // Key material must not outlive the session it belongs to.
    await db.wipe();
    set({ user: null, deviceId: null, accessToken: null, refreshToken: null, status: 'signed-out' });
  },
}));

/** Seconds until the JWT's exp claim, or -1 if it cannot be read. */
function secondsLeft(token: string): number {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return payload.exp ? payload.exp - Date.now() / 1000 : -1;
  } catch {
    return -1;
  }
}

/**
 * A token good for at least another minute, refreshing first if not. The socket asks for one
 * before every (re)connect, so a connection that drops hours later still comes back.
 */
export async function getValidAccessToken(forceRefresh = false): Promise<string | null> {
  const { accessToken } = useAuthStore.getState();
  if (!forceRefresh && accessToken && secondsLeft(accessToken) > 60) return accessToken;
  return refreshOnce();
}

/**
 * In-flight refresh, shared by every caller.
 *
 * <p>Refresh tokens rotate and the server treats a replayed one as theft, revoking the whole
 * family. So two requests 401-ing at the same moment must not each send the same token: the
 * second would look like an attacker and log the user out of a perfectly good session. This is
 * the single-flight guard that prevents it.
 */
let inFlightRefresh: Promise<string | null> | null = null;

function refreshOnce(): Promise<string | null> {
  if (inFlightRefresh) return inFlightRefresh;

  inFlightRefresh = (async () => {
    const { refreshToken, deviceId } = useAuthStore.getState();
    if (!refreshToken || !deviceId) return null;
    try {
      const tokens = await api.refresh(refreshToken);
      const existing = readPersisted();
      persist({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        userId: existing?.userId ?? useAuthStore.getState().user?.id ?? '',
        deviceId,
      });
      useAuthStore.setState({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
      return tokens.accessToken;
    } catch {
      return null;
    } finally {
      // Cleared in a microtask so callers that awaited this promise all see the same result
      // before a new attempt can start.
      queueMicrotask(() => {
        inFlightRefresh = null;
      });
    }
  })();

  return inFlightRefresh;
}

// Wire the API client to this store: it needs a token supplier and a way to refresh one.
configureApi(
  () => useAuthStore.getState().accessToken,
  async () => {
    const token = await refreshOnce();
    if (!token) {
      await useAuthStore.getState().signOut();
      return null;
    }
    return token;
  },
);
