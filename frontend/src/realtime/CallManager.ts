import { api } from '@/lib/api';
import { crypto } from '@/lib/crypto/LibsignalProvider';
import { startRingtone, stopRingtone } from '@/lib/ringtone';
import { useCallStore } from '@/state/callStore';
import { envelope, type Envelope } from './envelope';

export interface CallEventPayload {
  kind: 'RING' | 'JOINED' | 'LEFT' | 'ENDED' | 'ROSTER' | 'REJECTED';
  conversationId: string;
  callId?: string;
  userId?: string;
  deviceId?: string;
  video?: boolean;
  participants?: Array<{ userId: string; deviceId: string; video: boolean }>;
  message?: string;
}

export interface CallSignalPayload {
  conversationId: string;
  fromUserId: string;
  fromDeviceId: string;
  cipherType: number;
  ciphertext: string;
}

type Signal =
  | { type: 'offer' | 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'ice'; candidate: RTCIceCandidateInit };

interface Deps {
  selfUserId: () => string | null;
  selfDeviceId: () => string | null;
  /** Establishes Signal sessions with every device of a user, so signals can be encrypted. */
  ensureSessions: (userId: string) => Promise<void>;
  send: (destination: string, body: Envelope) => boolean;
}

const HEARTBEAT_MS = 20_000;
const RING_TIMEOUT_MS = 45_000;

/**
 * WebRTC mesh calls. One RTCPeerConnection per other device in the call.
 *
 * <p>Who offers: participants already in the call offer to each newcomer; a newcomer only
 * answers. Two people joining at the same instant can still both offer, so offer collisions are
 * resolved the "perfect negotiation" way: the device with the smaller id is polite and rolls
 * back its own offer; the other ignores the incoming one.
 *
 * <p>Every offer, answer and ICE candidate is encrypted with the pair's Signal session before
 * it reaches the server. The DTLS fingerprints inside the SDP are what bind the media
 * encryption to the two endpoints; if the server could rewrite them it could relay -- and
 * read -- the call. Encrypted signalling makes the media end-to-end encrypted in fact, not just
 * in transit.
 */
export class CallManager {
  private readonly peers = new Map<string, RTCPeerConnection>();
  private readonly pendingIce = new Map<string, RTCIceCandidateInit[]>();
  private readonly inbound = new Map<string, Promise<void>>();
  private readonly outbound = new Map<string, Promise<void>>();
  private heartbeat: number | null = null;
  private ringTimeout: number | null = null;
  private iceServers: RTCIceServer[] | null = null;

  constructor(private readonly deps: Deps) {}

  async start(conversationId: string, video: boolean): Promise<void> {
    await this.join(conversationId, video);
  }

  async accept(video: boolean): Promise<void> {
    const incoming = useCallStore.getState().incoming;
    if (!incoming) return;
    this.clearIncoming();
    await this.join(incoming.conversationId, video);
  }

  /** Declining only silences this device; the call keeps ringing for everyone else. */
  decline(): void {
    this.clearIncoming();
  }

  leave(): void {
    const active = useCallStore.getState().active;
    if (!active) return;
    this.deps.send('/app/call/leave', envelope('CALL_EVENT', { conversationId: active.conversationId }));
    this.teardown();
  }

  toggleMute(): void {
    const active = useCallStore.getState().active;
    if (!active) return;
    const muted = !active.muted;
    active.localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
    useCallStore.getState().set({ active: { ...active, muted } });
  }

  toggleCamera(): void {
    const active = useCallStore.getState().active;
    if (!active) return;
    const cameraOff = !active.cameraOff;
    active.localStream.getVideoTracks().forEach((t) => (t.enabled = !cameraOff));
    useCallStore.getState().set({ active: { ...active, cameraOff } });
  }

  /** Signed out or disconnected for good: drop everything without ceremony. */
  reset(): void {
    this.teardown();
    this.clearIncoming();
    useCallStore.getState().set({ ongoing: {}, error: null });
  }

  onEvent(event: CallEventPayload): void {
    const store = useCallStore.getState();
    const active = store.active;
    switch (event.kind) {
      case 'RING': {
        if (event.callId) store.set({ ongoing: { ...store.ongoing, [event.conversationId]: event.callId } });
        // Our own call from another of our devices shows as "in progress", not as ringing.
        if (active || event.userId === this.deps.selfUserId() || !event.callId || !event.userId) return;
        store.set({
          incoming: { conversationId: event.conversationId, callId: event.callId, callerId: event.userId, video: !!event.video },
        });
        startRingtone();
        this.ringTimeout = window.setTimeout(() => this.clearIncoming(), RING_TIMEOUT_MS);
        return;
      }
      case 'ROSTER':
        // The people already here will send us offers; show them as connecting meanwhile.
        if (active?.conversationId === event.conversationId) {
          event.participants?.forEach((p) => store.updatePeer(p.deviceId, { userId: p.userId, video: p.video }));
        }
        return;
      case 'JOINED':
        if (active?.conversationId === event.conversationId && event.deviceId && event.userId) {
          store.updatePeer(event.deviceId, { userId: event.userId, video: !!event.video });
          void this.connect(event.deviceId, event.userId, true);
        }
        return;
      case 'LEFT':
        if (event.deviceId) this.closePeer(event.deviceId);
        return;
      case 'ENDED': {
        const ongoing = { ...store.ongoing };
        delete ongoing[event.conversationId];
        store.set({ ongoing });
        if (store.incoming?.conversationId === event.conversationId) this.clearIncoming();
        if (active?.conversationId === event.conversationId) this.teardown();
        return;
      }
      case 'REJECTED':
        if (active?.conversationId === event.conversationId) {
          this.teardown();
          store.set({ error: event.message ?? 'Could not join the call' });
        }
        return;
    }
  }

  onSignal(frame: CallSignalPayload): void {
    // Strictly in order per sender: an ICE candidate must not overtake the offer it belongs to.
    const previous = this.inbound.get(frame.fromDeviceId) ?? Promise.resolve();
    const next = previous
      .then(() => this.handleSignal(frame))
      .catch((error) => console.warn('[call] signal from', frame.fromDeviceId, 'failed', error));
    this.inbound.set(frame.fromDeviceId, next);
  }

  private async join(conversationId: string, video: boolean): Promise<void> {
    const store = useCallStore.getState();
    if (store.active) throw new Error('You are already in a call');
    store.set({ error: null });
    const localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: video ? { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { max: 24 } } : false,
    });
    this.iceServers ??= await api.iceServers().catch(() => [{ urls: 'stun:stun.l.google.com:19302' }]);
    store.set({
      active: { conversationId, video, startedAt: Date.now(), localStream, peers: {}, muted: false, cameraOff: false },
    });
    const beat = () => this.deps.send('/app/call/join', envelope('CALL_EVENT', { conversationId, video }));
    beat();
    this.heartbeat = window.setInterval(beat, HEARTBEAT_MS);
  }

  private peer(deviceId: string, userId: string): RTCPeerConnection {
    const existing = this.peers.get(deviceId);
    if (existing) return existing;
    const active = useCallStore.getState().active!;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers ?? [] });
    active.localStream.getTracks().forEach((track) => pc.addTrack(track, active.localStream));

    pc.onicecandidate = (event) => {
      if (event.candidate) void this.sendSignal(deviceId, userId, { type: 'ice', candidate: event.candidate.toJSON() });
    };
    pc.ontrack = (event) => {
      useCallStore.getState().updatePeer(deviceId, {
        userId,
        stream: event.streams[0],
        video: event.streams[0]?.getVideoTracks().length > 0,
      });
    };
    pc.onconnectionstatechange = () => {
      useCallStore.getState().updatePeer(deviceId, { userId, state: pc.connectionState });
      // A path that died (network change, NAT rebinding): renegotiate candidates, keep the call.
      if (pc.connectionState === 'failed' && this.isImpolite(deviceId)) {
        pc.restartIce();
        void this.offer(pc, deviceId, userId, { iceRestart: true });
      }
    };
    this.peers.set(deviceId, pc);
    return pc;
  }

  private async connect(deviceId: string, userId: string, initiator: boolean): Promise<void> {
    const pc = this.peer(deviceId, userId);
    if (initiator) await this.offer(pc, deviceId, userId);
  }

  private async offer(pc: RTCPeerConnection, deviceId: string, userId: string, options?: RTCOfferOptions): Promise<void> {
    const offer = await pc.createOffer(options);
    await pc.setLocalDescription(offer);
    await this.sendSignal(deviceId, userId, { type: 'offer', sdp: pc.localDescription!.toJSON() });
  }

  private async handleSignal(frame: CallSignalPayload): Promise<void> {
    const active = useCallStore.getState().active;
    if (!active || active.conversationId !== frame.conversationId) return;
    const signal = JSON.parse(await crypto.decrypt(frame.fromDeviceId, frame.cipherType, frame.ciphertext)) as Signal;
    const from = frame.fromDeviceId;
    const pc = this.peer(from, frame.fromUserId);

    if (signal.type === 'offer') {
      if (pc.signalingState !== 'stable') {
        // Offer collision. The polite side yields; the impolite side ignores the other offer.
        if (this.isImpolite(from)) return;
        await pc.setLocalDescription({ type: 'rollback' });
      }
      await pc.setRemoteDescription(signal.sdp);
      await this.flushIce(from, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.sendSignal(from, frame.fromUserId, { type: 'answer', sdp: pc.localDescription!.toJSON() });
    } else if (signal.type === 'answer') {
      if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(signal.sdp);
        await this.flushIce(from, pc);
      }
    } else if (signal.type === 'ice') {
      if (pc.remoteDescription) {
        await pc.addIceCandidate(signal.candidate).catch(() => undefined);
      } else {
        this.pendingIce.set(from, [...(this.pendingIce.get(from) ?? []), signal.candidate]);
      }
    }
  }

  private async flushIce(deviceId: string, pc: RTCPeerConnection): Promise<void> {
    for (const candidate of this.pendingIce.get(deviceId) ?? []) {
      await pc.addIceCandidate(candidate).catch(() => undefined);
    }
    this.pendingIce.delete(deviceId);
  }

  /** Encrypted with the pair's Signal session; sent in order per recipient. */
  private sendSignal(deviceId: string, userId: string, signal: Signal): Promise<void> {
    const conversationId = useCallStore.getState().active?.conversationId;
    if (!conversationId) return Promise.resolve();
    const previous = this.outbound.get(deviceId) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        await this.deps.ensureSessions(userId);
        const { cipherType, ciphertext } = await crypto.encrypt(deviceId, JSON.stringify(signal));
        this.deps.send(
          '/app/call/signal',
          envelope('CALL_SIGNAL', { conversationId, toDeviceId: deviceId, cipherType, ciphertext }),
        );
      })
      .catch((error) => console.warn('[call] could not send signal to', deviceId, error));
    this.outbound.set(deviceId, next);
    return next;
  }

  /** The larger device id keeps its offer on a collision; the smaller one yields. */
  private isImpolite(remoteDeviceId: string): boolean {
    return (this.deps.selfDeviceId() ?? '') > remoteDeviceId;
  }

  private closePeer(deviceId: string): void {
    this.peers.get(deviceId)?.close();
    this.peers.delete(deviceId);
    this.pendingIce.delete(deviceId);
    this.inbound.delete(deviceId);
    this.outbound.delete(deviceId);
    useCallStore.getState().removePeer(deviceId);
  }

  private teardown(): void {
    if (this.heartbeat !== null) window.clearInterval(this.heartbeat);
    this.heartbeat = null;
    [...this.peers.keys()].forEach((id) => this.closePeer(id));
    const active = useCallStore.getState().active;
    // Camera and microphone lights go off the moment the call does.
    active?.localStream.getTracks().forEach((track) => track.stop());
    useCallStore.getState().set({ active: null });
  }

  private clearIncoming(): void {
    stopRingtone();
    if (this.ringTimeout !== null) window.clearTimeout(this.ringTimeout);
    this.ringTimeout = null;
    useCallStore.getState().set({ incoming: null });
  }
}
