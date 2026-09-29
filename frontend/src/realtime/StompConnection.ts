import { Client, type IMessage } from '@stomp/stompjs';
import type { Envelope, EnvelopeType } from './envelope';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline';

type Handler = (envelope: Envelope) => void;
type StatusListener = (status: ConnectionStatus) => void;
/**
 * Returns a currently valid access token, refreshing first if needed; null if signed out.
 * {@code forceRefresh}: the gateway rejected the current one, whatever its expiry claim says --
 * e.g. it was signed with a key the server no longer uses.
 */
export type TokenProvider = (forceRefresh?: boolean) => Promise<string | null>;
/** Gateway refusal codes carried in STOMP ERROR frames. */
export type GatewayRefusal = 'AUTH_EXPIRED' | 'DEVICE_REVOKED' | 'GATEWAY_DRAINING';

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/websocket`;

/**
 * One socket, one outbound queue, one inbound queue. Clients do not subscribe per conversation:
 * a user in 300 groups would otherwise open 300 subscriptions for no benefit.
 */
export class StompConnection {
  private client: Client | null = null;
  private handlers = new Map<EnvelopeType, Set<Handler>>();
  private statusListeners = new Set<StatusListener>();
  private status: ConnectionStatus = 'idle';
  private attempt = 0;
  private refusalListeners = new Set<(code: GatewayRefusal) => void>();
  private forceRefresh = false;

  /**
   * Takes a token <em>provider</em>, not a token. Reconnects happen long after the first
   * connect, and a token captured then would be expired by the time a dropped socket retries --
   * leaving it reconnecting forever with credentials the gateway will never accept.
   */
  connect(tokens: TokenProvider, deviceId: string): void {
    this.disconnect();
    this.setStatus('connecting');

    const client = new Client({
      brokerURL: WS_URL,
      beforeConnect: async () => {
        const token = await tokens(this.forceRefresh);
        this.forceRefresh = false;
        client.connectHeaders = token ? { Authorization: `Bearer ${token}` } : {};
      },
      // Matches the server's 30s/30s. A missed beat drops the socket rather than leaving a
      // half-open connection that silently swallows messages.
      heartbeatIncoming: 30_000,
      heartbeatOutgoing: 30_000,
      reconnectDelay: 0, // we schedule reconnects ourselves, with jitter
      onConnect: () => {
        this.attempt = 0;
        this.setStatus('connected');
        this.client?.subscribe(`/user/queue/events`, (frame: IMessage) => this.dispatch(frame));
      },
      onWebSocketClose: () => this.scheduleReconnect(tokens, deviceId),
      onStompError: (frame) => {
        const detail = `${frame.headers['message'] ?? ''} ${frame.body ?? ''}`;
        const code = (['DEVICE_REVOKED', 'AUTH_EXPIRED', 'GATEWAY_DRAINING'] as const).find((c) =>
          detail.includes(c),
        );
        if (!code) {
          console.error('[realtime] STOMP error', detail);
          return;
        }
        this.refusalListeners.forEach((listener) => listener(code));
        if (code === 'AUTH_EXPIRED') this.forceRefresh = true;
        // Expired token or draining node: drop the socket; the reconnect fetches a fresh token
        // and the load balancer sends it to a node that is not shutting down.
        if (code !== 'DEVICE_REVOKED') void client.forceDisconnect();
      },
    });

    this.client = client;
    client.activate();
  }

  onRefusal(listener: (code: GatewayRefusal) => void): () => void {
    this.refusalListeners.add(listener);
    return () => this.refusalListeners.delete(listener);
  }

  private scheduleReconnect(tokens: TokenProvider, deviceId: string): void {
    if (this.status === 'idle') return; // an intentional disconnect
    this.setStatus('reconnecting');

    // Exponential backoff with full jitter. Without the jitter, every client that dropped
    // when a gateway died would come back at the same instant and kill the next one.
    const ceiling = Math.min(30_000, 500 * 2 ** this.attempt);
    const delay = Math.random() * ceiling;
    this.attempt += 1;

    setTimeout(() => {
      if (this.status === 'reconnecting') {
        this.connect(tokens, deviceId);
      }
    }, delay);
  }

  private dispatch(frame: IMessage): void {
    let parsed: Envelope;
    try {
      parsed = JSON.parse(frame.body) as Envelope;
    } catch (error) {
      console.error('[realtime] Unparseable frame', error);
      return;
    }
    this.handlers.get(parsed.type)?.forEach((handler) => handler(parsed));
  }

  on(type: EnvelopeType, handler: Handler): () => void {
    const set = this.handlers.get(type) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(type, set);
    return () => set.delete(handler);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  send(destination: string, body: Envelope): boolean {
    if (!this.client?.connected) return false;
    this.client.publish({ destination, body: JSON.stringify(body) });
    return true;
  }

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  disconnect(): void {
    this.setStatus('idle');
    this.client?.deactivate();
    this.client = null;
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.statusListeners.forEach((listener) => listener(status));
  }
}

export const realtime = new StompConnection();
