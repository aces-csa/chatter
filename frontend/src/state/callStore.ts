import { create } from 'zustand';

export interface CallPeer {
  deviceId: string;
  userId: string;
  video: boolean;
  stream?: MediaStream;
  state: RTCPeerConnectionState | 'waiting';
}

export interface ActiveCall {
  conversationId: string;
  video: boolean;
  startedAt: number;
  localStream: MediaStream;
  peers: Record<string, CallPeer>;
  muted: boolean;
  cameraOff: boolean;
}

export interface IncomingCall {
  conversationId: string;
  callId: string;
  callerId: string;
  video: boolean;
}

interface CallState {
  active: ActiveCall | null;
  incoming: IncomingCall | null;
  /** conversationId -> callId for calls in progress this device has not joined. */
  ongoing: Record<string, string>;
  error: string | null;
  set: (patch: Partial<Omit<CallState, 'set' | 'updatePeer' | 'removePeer'>>) => void;
  updatePeer: (deviceId: string, patch: Partial<CallPeer> & Pick<CallPeer, 'userId'>) => void;
  removePeer: (deviceId: string) => void;
}

/** Call UI state. Peer connections themselves live in CallManager, not in a store. */
export const useCallStore = create<CallState>((set) => ({
  active: null,
  incoming: null,
  ongoing: {},
  error: null,
  set: (patch) => set(patch),
  updatePeer: (deviceId, patch) =>
    set((state) => {
      if (!state.active) return {};
      const current = state.active.peers[deviceId] ?? { deviceId, video: false, state: 'waiting' as const, userId: patch.userId };
      return { active: { ...state.active, peers: { ...state.active.peers, [deviceId]: { ...current, ...patch } } } };
    }),
  removePeer: (deviceId) =>
    set((state) => {
      if (!state.active) return {};
      const peers = { ...state.active.peers };
      delete peers[deviceId];
      return { active: { ...state.active, peers } };
    }),
}));
