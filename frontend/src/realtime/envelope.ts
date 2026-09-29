export type EnvelopeType =
  | 'CONNECT_OK'
  | 'SEND'
  | 'ACK'
  | 'NACK'
  | 'MESSAGE'
  | 'DELIVERED'
  | 'READ'
  | 'TYPING'
  | 'PRESENCE'
  | 'PRESENCE_SUB'
  | 'SYNC'
  | 'SYNC_PAGE'
  | 'CONV_UPDATE'
  | 'ERROR'
  | 'CALL_EVENT'
  | 'CALL_SIGNAL'
  | 'SEALED';

export interface Envelope<P = unknown> {
  v: number;
  type: EnvelopeType;
  id?: string;
  ts?: number;
  payload: P;
}

export interface RecipientPayload {
  recipientUserId: string;
  recipientDeviceId: string;
  cipherType: number;
  ciphertext: string;
}

export interface SendPayload {
  clientMessageId: string;
  conversationId: string;
  replyToId?: string;
  mediaId?: string;
  payloads: RecipientPayload[];
  /** Groups: one sender-key ciphertext for every member device. */
  groupCiphertext?: string;
  /** Control messages: no unread count, no notification. */
  silent?: boolean;
  /** Plaintext target of an edit or delete, so the server can enforce author and time window. */
  editOf?: string;
  deleteOf?: string;
  /** Plaintext hint so a mention can notify through a muted group (FR-4.7). */
  mentions?: string[];
}

export interface AckPayload {
  clientMessageId: string;
  messageId: string;
  seq: number;
  ts: number;
  /** Set when the chat had disappearing messages on. */
  expiresAt?: number;
}

export interface NackPayload {
  clientMessageId: string;
  code: string;
  message: string;
  retryable: boolean;
}

export interface MessagePayload {
  messageId: string;
  clientMessageId: string;
  conversationId: string;
  senderId: string;
  senderDeviceId: string;
  seq: number;
  /** 'signal/v3', or 'system/v1' for a server-authored group event. */
  encoding: string;
  /** 0 when this device has no pairwise payload (a group message it already has the key for). */
  cipherType: number;
  ciphertext?: string;
  /** Sender-key ciphertext; for 'system/v1' it is base64 JSON written by the server. */
  groupCiphertext?: string;
  createdAt: number;
  expiresAt?: number;
}

export interface ReceiptPayload {
  conversationId: string;
  uptoSeq: number;
  userId?: string;
}

export interface SyncPagePayload {
  envelopes: Envelope<MessagePayload>[];
  hasMore: boolean;
}

export interface PresencePayload {
  userId: string;
  status: 'online' | 'offline';
  /** null when the viewer is not permitted to see it. */
  lastSeenAt: number | null;
}

export interface TypingFromPayload {
  conversationId: string;
  userId: string;
  state: 'start' | 'stop' | 'recording';
}

export interface ConnectOkPayload {
  userId: string;
  deviceId: string;
  serverTime: number;
}

export function envelope<P>(type: EnvelopeType, payload: P): Envelope<P> {
  return { v: 1, type, ts: Date.now(), payload };
}

/** A sealed-sender envelope: no sender, no conversation. {@code id} is only for acknowledging it. */
export interface SealedPayload {
  id: string;
  ciphertext: string;
  createdAt: number;
}
