import Dexie, { type Table } from 'dexie';

/**
 * Message delivery state, as the sender sees it. The UI maps these to the tick icons.
 * FAILED is a real state, not an absence of one: a message that did not send must be visible
 * and retryable, never silently missing.
 */
export type MessageState = 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

/**
 * Timeline notices the client inserts itself (never sent, never acked). They carry a fractional
 * seq -- the conversation's lastSeq + 0.5 -- so they sort between real messages without ever
 * colliding with a server-assigned sequence number.
 */
export const SYSTEM_IDENTITY_CHANGED = 'system/identity-changed';
/** A group membership/settings change; {@link LocalMessage.body} holds the event JSON. */
export const SYSTEM_GROUP_EVENT = 'system/group-event';

export function isSystemMessage(message: Pick<LocalMessage, 'contentType'>): boolean {
  return message.contentType.startsWith('system/');
}

export type MediaKind = 'image' | 'video' | 'audio' | 'document';

/**
 * An attachment, as carried inside the encrypted message body. The server sees only the opaque
 * blob behind {@link mediaId}; type, name, dimensions and the decryption key exist nowhere but
 * in end-to-end encrypted payloads and on devices.
 */
export interface MediaDescriptor {
  kind: MediaKind;
  mime: string;
  name?: string;
  /** Plaintext size, for display. */
  size: number;
  width?: number;
  height?: number;
  durationMs?: number;
  /** Tiny JPEG data URL, shown instantly while the real blob downloads. */
  thumbnail?: string;
  /** Recorded in the app (FR-5.4), as opposed to an audio file that was attached. */
  voice?: boolean;
  /** Voice notes: loudness per bar, 0-255, base64. Drawn before the audio has downloaded. */
  waveform?: string;
  /** FR-5.8: the recipient can open it once; afterwards key and cached copy are erased. */
  viewOnce?: boolean;
  /** Set on this device once a view-once item has been opened (or sent). */
  viewOnceSpent?: boolean;
  /** Server id of the encrypted blob; absent until the upload has started. */
  mediaId?: string;
  /** base64: 32-byte AES key followed by 32-byte HMAC key. */
  key?: string;
  /** base64 SHA-256 of the encrypted blob, checked before decrypting. */
  digest?: string;
}

/** Sender-side upload state. Kept on the message so it survives a reload and can resume. */
export interface UploadState {
  /** 0..1 */
  progress: number;
  /** base64 IV. Stored so re-encrypting after a reload yields byte-identical parts. */
  iv: string;
  encryptedSize: number;
  done: boolean;
  error?: string;
}

/**
 * A shared location. Coordinates live only inside the end-to-end encrypted payload; the server
 * relays them without being able to read them.
 */
export interface LocationInfo {
  lat: number;
  lng: number;
  /** Metres, as reported by the device. */
  accuracy?: number;
  /** Present for live location: the sender keeps updating it until {@code until}. */
  live?: {
    until: number;
    updatedAt: number;
    /** Set when the sender stopped early. */
    stoppedAt?: number;
  };
}

/** A quoted message, snapshotted so the quote renders even if the original is not loaded. */
export interface ReplyRef {
  messageId: string;
  senderId: string;
  preview: string;
}

/**
 * An outgoing reaction, edit or delete, parked as a hidden message row so it survives a reload
 * and retries like any other send. {@link previous} is the target's state before the optimistic
 * change, restored if the server refuses the action for good.
 */
export type ControlAction =
  | { type: 'reaction'; targetId: string; emoji: string; previous?: string }
  | { type: 'edit'; targetId: string; body: string; previous: { body: string; editedAt?: number } }
  | { type: 'delete'; targetId: string; previous: { body: string; media?: MediaDescriptor } }
  /** A live-location update or stop; nothing to revert, the next update supersedes it. */
  | { type: 'location'; targetId: string; location: LocationInfo };

export interface LocalMessage {
  /** Client-minted, stable across retries. The join key between optimistic and acked. */
  clientMessageId: string;
  /** Server id, absent until the ACK arrives. */
  messageId?: string;
  conversationId: string;
  senderId: string;
  /** Provisional MAX_SAFE_INTEGER while pending, so the bubble pins to the bottom. */
  seq: number;
  body: string;
  contentType: string;
  state: MessageState;
  /** Set when decryption failed; the bubble renders a recoverable placeholder. */
  undecryptable?: boolean;
  createdAt: number;
  /** Disappearing messages: epoch millis after which this device deletes the message. */
  expiresAt?: number;
  media?: MediaDescriptor;
  upload?: UploadState;
  replyTo?: ReplyRef;
  forwarded?: boolean;
  /** userId -> emoji. One reaction per person (FR-3.7). */
  reactions?: Record<string, string>;
  editedAt?: number;
  /** Tombstone: the sender deleted it for everyone. Body and media are already gone. */
  deletedForAll?: boolean;
  /** Local to this device (FR-3.9). A number rather than a boolean so it can be indexed. */
  starredAt?: number;
  /** Set on hidden outgoing control rows only; never rendered. */
  control?: ControlAction;
  location?: LocationInfo;
  /** FR-4.7: user ids @mentioned in the text. */
  mentions?: string[];
  /** Groups: each member's furthest receipt for this message, so ticks turn blue only when all have read. */
  receipts?: Record<string, 'DELIVERED' | 'READ'>;
}

/**
 * Decrypted media, cached so it is fetched and decrypted once. Keyed by server media id, or
 * `local:<clientMessageId>` for a file we are sending that has no server id yet.
 */
export interface MediaBlobRow {
  id: string;
  blob: Blob;
  savedAt: number;
}

export interface LocalConversation {
  id: string;
  type: 'DIRECT' | 'GROUP';
  subject?: string;
  participantIds: string[];
  lastSeq: number;
  lastMessageAt?: number;
  lastMessagePreview?: string;
  unreadCount: number;
  lastReadSeq: number;
  pinned: boolean;
  archived: boolean;
  description?: string;
  members?: GroupMember[];
  onlyAdminsCanPost?: boolean;
  onlyAdminsCanEditInfo?: boolean;
  /** Set when we were removed or left: history stays readable, the composer does not. */
  left?: boolean;
  /** Disappearing-messages timer; 0 or absent means off. */
  disappearingSeconds?: number;
  /** Epoch millis until which this chat stays quiet; absent when not muted. */
  mutedUntil?: number;
  /** FR-7.3: shown as unread until next opened. */
  markedUnread?: boolean;
}

export interface GroupMember {
  userId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
}

export interface LocalUser {
  id: string;
  phoneE164: string;
  displayName: string;
  about?: string;
  /** Profile photo as a data URL, when its owner's privacy lets us see it. */
  avatar?: string;
}

export interface OutboxItem {
  clientMessageId: string;
  conversationId: string;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  /** Held back until its attachment has finished uploading. */
  awaitingUpload?: boolean;
}

/** key/value bag for cursors and session scalars. */
export interface MetaRow {
  key: string;
  value: unknown;
}

// --- Signal protocol store tables. Private key material never leaves this database. ---

export interface SignalIdentityRow {
  id: 'self';
  identityKeyPub: string;
  identityKeyPriv: string;
  registrationId: number;
}

export interface SignalKeyRow {
  keyId: number;
  pubKey: string;
  privKey: string;
}

export interface SignalSessionRow {
  address: string;
  record: string;
}

export interface SignalRemoteIdentityRow {
  address: string;
  identityKey: string;
  /** Per-device; superseded by {@link ContactTrustRow.verified}, which is what the UI reads. */
  verified: boolean;
  firstSeenAt: number;
}

/**
 * What we trust about one contact, across all their devices. Safety numbers are per account,
 * so trust is too: a new device or a reinstalled one changes the account's key set, and that is
 * exactly the event the user has to be told about.
 */
export interface ContactTrustRow {
  userId: string;
  /** Sorted base64 identity keys we have encrypted to or decrypted from. */
  knownKeys: string[];
  /** Set once the user has compared safety numbers out of band; cleared on any key change. */
  verified: boolean;
  verifiedAt?: number;
  lastChangedAt?: number;
}

/**
 * Our current sender key for one group. Replaced wholesale on rotation, which is what cuts off a
 * member who has left: they hold the old chain, never the new one.
 */
export interface OwnSenderKeyRow {
  groupId: string;
  keyId: number;
  /** Next iteration to encrypt with. */
  iteration: number;
  chainKey: string;
  signingPub: string;
  signingPriv: string;
  /** Devices that have been handed this key (confirmed by an ACK). */
  sharedWith: string[];
}

/** Another device's sender key for one group, as far as we have ratcheted it. */
export interface SenderKeyRow {
  /** `${groupId}:${senderDeviceId}:${keyId}` */
  id: string;
  groupId: string;
  senderDeviceId: string;
  keyId: number;
  iteration: number;
  chainKey: string;
  signingPub: string;
  /** iteration -> message-key seed, for messages that arrive out of order. */
  skipped: Record<string, string>;
}

export class ChatterDb extends Dexie {
  messages!: Table<LocalMessage, string>;
  conversations!: Table<LocalConversation, string>;
  users!: Table<LocalUser, string>;
  outbox!: Table<OutboxItem, string>;
  meta!: Table<MetaRow, string>;

  signalIdentity!: Table<SignalIdentityRow, string>;
  signalPreKeys!: Table<SignalKeyRow, number>;
  signalSignedPreKeys!: Table<SignalKeyRow, number>;
  signalSessions!: Table<SignalSessionRow, string>;
  signalRemoteIdentities!: Table<SignalRemoteIdentityRow, string>;
  contactTrust!: Table<ContactTrustRow, string>;
  ownSenderKeys!: Table<OwnSenderKeyRow, string>;
  senderKeys!: Table<SenderKeyRow, string>;
  mediaBlobs!: Table<MediaBlobRow, string>;

  constructor() {
    super('chatter');
    this.version(1).stores({
      // [conversationId+seq] is the read pattern: a window of one conversation by sequence.
      messages: 'clientMessageId, messageId, [conversationId+seq], conversationId, state, createdAt',
      conversations: 'id, lastMessageAt, type, pinned, archived',
      users: 'id, phoneE164',
      outbox: 'clientMessageId, nextAttemptAt',
      meta: 'key',
      signalIdentity: 'id',
      signalPreKeys: 'keyId',
      signalSignedPreKeys: 'keyId',
      signalSessions: 'address',
      signalRemoteIdentities: 'address',
    });
    this.version(2).stores({
      contactTrust: 'userId',
    });
    this.version(3).stores({
      ownSenderKeys: 'groupId',
      senderKeys: 'id, [groupId+senderDeviceId]',
    });
    // expiresAt is indexed so the sweeper finds due messages without scanning history.
    this.version(4).stores({
      messages:
        'clientMessageId, messageId, [conversationId+seq], conversationId, state, createdAt, expiresAt',
    });
    this.version(5).stores({
      mediaBlobs: 'id, savedAt',
    });
    this.version(6).stores({
      messages:
        'clientMessageId, messageId, [conversationId+seq], conversationId, state, createdAt, expiresAt, starredAt',
    });
  }

  /** Called on sign-out: key material must not outlive the session it belongs to. */
  async wipe(): Promise<void> {
    await Promise.all(this.tables.map((table) => table.clear()));
  }
}

export const db = new ChatterDb();

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const row = await db.meta.get(key);
  return row?.value as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}
