import { v7 as uuidv7 } from 'uuid';
import {
  db,
  SYSTEM_GROUP_EVENT,
  type ControlAction,
  type LocalConversation,
  type LocalMessage,
  type LocationInfo,
  type MediaDescriptor,
  type ReplyRef,
} from '@/db/db';
import { LOCATION_CONTENT_TYPE, locationPreview } from '@/lib/location';
import { encryptedSizeOf, newMediaKey } from '@/lib/media/mediaCrypto';
import { mediaPreview } from '@/lib/media/labels';
import type { PreparedMedia } from '@/lib/media/prepare';
import { localBlobId } from './MediaUploads';
import { api, type SealedTarget } from '@/lib/api';
import { sealedSender } from '@/lib/crypto/SealedSender';
import { blockedIds } from '@/lib/blocks';
import { readReceiptsEnabled } from '@/lib/quietHours';
import { base64ToBuffer, bufferToUtf8 } from '@/lib/bytes';
import { crypto } from '@/lib/crypto/LibsignalProvider';
import { identityTrust } from '@/lib/crypto/IdentityTrust';
import { senderKeys, type SenderKeyDistribution } from '@/lib/crypto/SenderKeys';
import { refreshGroupDetails, saveConversation } from '@/db/conversations';
import { removesSomeone, type GroupEvent } from '@/lib/groupEvents';
import type { MessagePayload, RecipientPayload, SealedPayload } from './envelope';

/** The plaintext that goes inside the ciphertext. The server never sees any of this. */
interface InnerPayload {
  contentType: string;
  body: string;
  sentAt: number;
  /** Everything needed to fetch and decrypt the attachment, key included. */
  media?: MediaDescriptor;
  replyTo?: ReplyRef;
  forwarded?: boolean;
  /**
   * Control messages (step 12). Reactions, edits and deletes are ordinary encrypted messages:
   * sequenced, synced and delivered to every device like any other, then applied rather than
   * rendered. Absent for a normal message.
   */
  kind?: 'reaction' | 'edit' | 'delete' | 'location' | 'receipt';
  targetId?: string;
  /** A shared location (a message), or its latest position (a 'location' control). */
  location?: LocationInfo;
  mentions?: string[];
  /** Reaction emoji; empty string removes the reaction. */
  emoji?: string;
  /**
   * DIRECT chats: the sender's unidentified access key, so the peer can send to them sealed.
   * Shared only inside end-to-end encryption, which is what keeps strangers off the sealed path.
   */
  accessKey?: string;
  /**
   * Sealed messages only. The server assigns no id and files the message under no conversation,
   * so both travel inside: the id is the sender's clientMessageId, and the conversation is
   * checked against the certificate's sender rather than trusted.
   */
  messageId?: string;
  conversationId?: string;
  /** Sealed receipts: the messages this receipt covers. */
  receipt?: 'DELIVERED' | 'READ';
  messageIds?: string[];
}

/** One sealed send: the peer's devices anonymously, and our own other devices identified. */
export interface SealedPlan {
  recipientUserId: string;
  accessKey: string;
  peerTargets: SealedTarget[];
  selfTargets: SealedTarget[];
}

/** What arrived in a sealed envelope, for the caller's follow-up (receipt, notification). */
export type SealedOutcome =
  | { kind: 'message'; senderId: string; conversationId: string; messageId: string; discovered: boolean }
  | { kind: 'control' | 'receipt' | 'dropped' };

/** Sealed rows sit between server-sequenced ones: after lastSeq, ordered among themselves by time. */
const SEALED_SEQ_OFFSET = 0.5;

export interface ComposeOptions {
  replyTo?: ReplyRef;
  forwarded?: boolean;
  mentions?: string[];
}

/** What a group message carries pairwise to a device that does not have our sender key yet. */
interface SenderKeyHandoff {
  kind: 'skdm';
  distribution: SenderKeyDistribution;
}

/** What goes on the wire for one send. */
export interface SendPlan {
  payloads: RecipientPayload[];
  groupCiphertext?: string;
  silent?: boolean;
  editOf?: string;
  deleteOf?: string;
  mentions?: string[];
}

/** FR-3.10 / FR-3.11 windows, mirrored from the server so the UI only offers what will work. */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;
export const DELETE_FOR_EVERYONE_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Pending messages sort last until an ACK assigns their real sequence number. */
export const PENDING_SEQ = Number.MAX_SAFE_INTEGER;

/**
 * How long a group send trusts its last look at a member's devices. Without this every group
 * message costs one device lookup per member, which is the O(members) cost sender keys exist to
 * remove. A device added inside the window misses the key until the next lookup.
 */
const GROUP_DEVICE_CACHE_MS = 30_000;

export class MessagePipeline {
  /** clientMessageId -> the devices that send handed our sender key to, committed on ACK. */
  private readonly pendingHandoffs = new Map<
    string,
    { groupId: string; keyId: number; deviceIds: string[] }
  >();
  private readonly deviceCache = new Map<
    string,
    { at: number; devices: Array<{ deviceId: string; identityKey: string }> }
  >();

  constructor(
    private readonly selfUserId: string,
    private readonly selfDeviceId: string,
  ) {}

  /**
   * Writes the optimistic bubble and the outbox row, then returns. The UI updates from Dexie
   * before any network call happens, which is what makes sending feel instant.
   */
  async composeText(conversationId: string, body: string, options: ComposeOptions = {}): Promise<string> {
    const clientMessageId = uuidv7();
    const message: LocalMessage = {
      clientMessageId,
      conversationId,
      senderId: this.selfUserId,
      seq: PENDING_SEQ,
      body,
      contentType: 'text/plain',
      state: 'PENDING',
      createdAt: Date.now(),
      replyTo: options.replyTo,
      forwarded: options.forwarded,
      mentions: options.mentions?.length ? options.mentions : undefined,
    };

    await db.transaction('rw', db.messages, db.outbox, db.conversations, async () => {
      await db.messages.put(message);
      await db.outbox.put({ clientMessageId, conversationId, attempts: 0, nextAttemptAt: 0 });
      await db.conversations
        .where('id')
        .equals(conversationId)
        .modify({ lastMessageAt: message.createdAt, lastMessagePreview: body });
    });

    return clientMessageId;
  }

  /**
   * Like {@link composeText}, but the message waits in the outbox until its attachment is
   * uploaded. The file is kept locally so the bubble renders at once and the upload can resume.
   */
  async composeMedia(
    conversationId: string,
    prepared: PreparedMedia,
    caption: string,
    options: ComposeOptions = {},
  ): Promise<string> {
    const clientMessageId = uuidv7();
    const { key, iv } = newMediaKey();
    const message: LocalMessage = {
      clientMessageId,
      conversationId,
      senderId: this.selfUserId,
      seq: PENDING_SEQ,
      body: caption,
      contentType: prepared.descriptor.mime,
      state: 'PENDING',
      createdAt: Date.now(),
      media: { ...prepared.descriptor, key },
      replyTo: options.replyTo,
      upload: {
        progress: 0,
        iv,
        encryptedSize: encryptedSizeOf(prepared.blob.size),
        done: false,
      },
    };

    await db.transaction('rw', [db.messages, db.outbox, db.conversations, db.mediaBlobs], async () => {
      await db.mediaBlobs.put({ id: localBlobId(clientMessageId), blob: prepared.blob, savedAt: Date.now() });
      await db.messages.put(message);
      await db.outbox.put({
        clientMessageId,
        conversationId,
        attempts: 0,
        nextAttemptAt: 0,
        awaitingUpload: true,
      });
      await db.conversations.update(conversationId, {
        lastMessageAt: message.createdAt,
        lastMessagePreview: mediaPreview(prepared.descriptor, caption),
      });
    });
    return clientMessageId;
  }

  /**
   * Forwards an existing message (FR-3.8): same content, new message, marked "Forwarded".
   * Media is not re-uploaded -- the encrypted blob is shared into the target conversation and the
   * same key travels in the new message.
   */
  async composeForward(conversationId: string, source: LocalMessage): Promise<string> {
    if (source.media && !source.media.mediaId) {
      throw new Error('That attachment has not finished uploading');
    }
    if (source.media?.mediaId) {
      await api.shareMedia(source.media.mediaId, conversationId);
    }
    const clientMessageId = uuidv7();
    const message: LocalMessage = {
      clientMessageId,
      conversationId,
      senderId: this.selfUserId,
      seq: PENDING_SEQ,
      body: source.body,
      contentType: source.contentType,
      state: 'PENDING',
      createdAt: Date.now(),
      media: source.media,
      forwarded: true,
    };
    await db.transaction('rw', db.messages, db.outbox, db.conversations, async () => {
      await db.messages.put(message);
      await db.outbox.put({ clientMessageId, conversationId, attempts: 0, nextAttemptAt: 0 });
      await db.conversations.update(conversationId, {
        lastMessageAt: message.createdAt,
        lastMessagePreview: source.media ? mediaPreview(source.media, source.body) : source.body,
      });
    });
    return clientMessageId;
  }

  /** A location message (FR: location sharing). Live ones are then updated by controls. */
  async composeLocation(conversationId: string, location: LocationInfo, options: ComposeOptions = {}): Promise<string> {
    const clientMessageId = uuidv7();
    const message: LocalMessage = {
      clientMessageId,
      conversationId,
      senderId: this.selfUserId,
      seq: PENDING_SEQ,
      body: '',
      contentType: LOCATION_CONTENT_TYPE,
      state: 'PENDING',
      createdAt: Date.now(),
      location,
      replyTo: options.replyTo,
    };
    await db.transaction('rw', db.messages, db.outbox, db.conversations, async () => {
      await db.messages.put(message);
      await db.outbox.put({ clientMessageId, conversationId, attempts: 0, nextAttemptAt: 0 });
      await db.conversations.update(conversationId, {
        lastMessageAt: message.createdAt,
        lastMessagePreview: locationPreview(location),
      });
    });
    return clientMessageId;
  }

  /**
   * Queues a reaction, edit or delete and applies it locally at once. The change is visible
   * immediately; if the server later refuses it for good, {@link revertControl} undoes it.
   */
  async composeControl(
    target: LocalMessage,
    action:
      | { type: 'reaction'; emoji: string }
      | { type: 'edit'; body: string }
      | { type: 'delete' }
      | { type: 'location'; location: LocationInfo },
  ): Promise<string> {
    if (!target.messageId) throw new Error('Only sent messages can be reacted to, edited or deleted');
    const clientMessageId = uuidv7();
    const control: ControlAction =
      action.type === 'reaction'
        ? { type: 'reaction', targetId: target.messageId, emoji: action.emoji, previous: target.reactions?.[this.selfUserId] }
        : action.type === 'edit'
          ? { type: 'edit', targetId: target.messageId, body: action.body, previous: { body: target.body, editedAt: target.editedAt } }
          : action.type === 'location'
            ? { type: 'location', targetId: target.messageId, location: action.location }
            : { type: 'delete', targetId: target.messageId, previous: { body: target.body, media: target.media } };

    await db.transaction('rw', db.messages, db.outbox, async () => {
      await db.messages.put({
        clientMessageId,
        conversationId: target.conversationId,
        senderId: this.selfUserId,
        seq: PENDING_SEQ,
        body: '',
        contentType: 'application/x-chatter-control',
        state: 'PENDING',
        createdAt: Date.now(),
        control,
      });
      await db.outbox.put({ clientMessageId, conversationId: target.conversationId, attempts: 0, nextAttemptAt: 0 });
    });
    await this.applyControl(target.conversationId, this.selfUserId, innerFromControl(control, Date.now()));
    return clientMessageId;
  }

  /** The server refused a control for good: put the target back the way it was. */
  async revertControl(clientMessageId: string): Promise<void> {
    const row = await db.messages.get(clientMessageId);
    const control = row?.control;
    if (!row || !control) return;
    const target = await db.messages.where('messageId').equals(control.targetId).first();
    await db.transaction('rw', db.messages, db.outbox, async () => {
      if (target) {
        if (control.type === 'reaction') {
          const reactions = { ...(target.reactions ?? {}) };
          if (control.previous) reactions[this.selfUserId] = control.previous;
          else delete reactions[this.selfUserId];
          await db.messages.update(target.clientMessageId, { reactions });
        } else if (control.type === 'edit') {
          await db.messages.update(target.clientMessageId, control.previous);
        } else if (control.type === 'location') {
          // Nothing to undo: a later update, or the share expiring, supersedes it.
        } else {
          await db.messages.update(target.clientMessageId, { ...control.previous, deletedForAll: false });
        }
      }
      await db.messages.delete(clientMessageId);
      await db.outbox.delete(clientMessageId);
    });
  }

  async buildSendPlan(clientMessageId: string): Promise<SendPlan | null> {
    const message = await db.messages.get(clientMessageId);
    if (!message) return null;

    const conversation = await db.conversations.get(message.conversationId);
    if (!conversation) {
      throw new Error(`Unknown conversation ${message.conversationId}`);
    }
    const control = message.control;
    const inner = innerFor(message);
    if (conversation.type === 'DIRECT') inner.accessKey = await sealedSender.ownAccessKey();
    const serialised = JSON.stringify(inner);

    const plan: SendPlan =
      conversation.type === 'GROUP'
        ? await this.encryptForGroup(conversation, serialised, clientMessageId)
        : { payloads: await this.encryptPairwise(conversation, serialised) };
    if (message.mentions?.length) plan.mentions = message.mentions;
    if (control) {
      plan.silent = true;
      if (control.type === 'edit') plan.editOf = control.targetId;
      if (control.type === 'delete') plan.deleteOf = control.targetId;
    }
    return plan;
  }

  /**
   * The server accepted the send, so the devices it carried our key to now have it. A control
   * row has done its job once acknowledged; its effect already lives on the target message.
   */
  async onAcked(clientMessageId: string): Promise<void> {
    const handoff = this.pendingHandoffs.get(clientMessageId);
    if (handoff) {
      this.pendingHandoffs.delete(clientMessageId);
      await senderKeys.markShared(handoff.groupId, handoff.keyId, handoff.deviceIds);
    }
    const row = await db.messages.get(clientMessageId);
    if (row?.control) await db.messages.delete(clientMessageId);
  }

  /**
   * The sealed version of a send, or null when this message must go identified:
   * <ul>
   *   <li>groups -- a group message names its conversation, and so its members, by design;</li>
   *   <li>attachments -- the upload is already tied to the conversation on the server;</li>
   *   <li>no access key yet -- the peer has not messaged us since we last learned it.</li>
   * </ul>
   * The first message of a new chat is therefore identified, and carries our key; from the
   * peer's first reply on, both directions go sealed.
   */
  async buildSealedPlan(clientMessageId: string): Promise<SealedPlan | null> {
    const message = await db.messages.get(clientMessageId);
    if (!message || message.media) return null;
    const conversation = await db.conversations.get(message.conversationId);
    if (!conversation || conversation.type !== 'DIRECT') return null;
    const peer = conversation.participantIds.find((id) => id !== this.selfUserId);
    if (!peer) return null;
    const accessKey = await sealedSender.peerAccessKey(peer);
    if (!accessKey) return null;

    const inner = innerFor(message);
    inner.accessKey = await sealedSender.ownAccessKey();
    inner.messageId = clientMessageId;
    inner.conversationId = conversation.id;
    const serialised = JSON.stringify(inner);
    return {
      recipientUserId: peer,
      accessKey,
      peerTargets: await this.sealFor(peer, serialised),
      selfTargets: await this.sealFor(this.selfUserId, serialised),
    };
  }

  /** A sealed DELIVERED or READ for messages a peer sent us sealed. Null if we cannot reach them sealed. */
  async buildSealedReceipt(
    conversationId: string,
    peer: string,
    state: 'DELIVERED' | 'READ',
    messageIds: string[],
  ): Promise<SealedPlan | null> {
    const accessKey = await sealedSender.peerAccessKey(peer);
    if (!accessKey || messageIds.length === 0) return null;
    const inner: InnerPayload = {
      kind: 'receipt',
      receipt: state,
      messageIds,
      conversationId,
      accessKey: await sealedSender.ownAccessKey(),
      contentType: 'text/plain',
      body: '',
      sentAt: Date.now(),
    };
    return { recipientUserId: peer, accessKey, peerTargets: await this.sealFor(peer, JSON.stringify(inner)), selfTargets: [] };
  }

  /** Signal-encrypts to each device of an account, then seals each ciphertext to that device. */
  private async sealFor(userId: string, serialised: string): Promise<SealedTarget[]> {
    const certificate = await sealedSender.certificate();
    const targets: SealedTarget[] = [];
    for (const device of await this.ensureSessions(userId)) {
      const { cipherType, ciphertext } = await crypto.encrypt(device.deviceId, serialised);
      targets.push({
        deviceId: device.deviceId,
        ciphertext: await sealedSender.seal(device.identityKey, certificate, cipherType, ciphertext),
      });
    }
    return targets;
  }

  /**
   * The sealed send went through. There is no server id or sequence number: the message keeps
   * its clientMessageId as its id -- the same id the recipients stored -- and sorts after the
   * last sequenced message.
   */
  async onSealedSent(clientMessageId: string): Promise<void> {
    await this.onAcked(clientMessageId);
    await db.transaction('rw', db.messages, db.outbox, db.conversations, async () => {
      const message = await db.messages.get(clientMessageId);
      await db.outbox.delete(clientMessageId);
      if (!message) return; // a control row, already removed by onAcked
      const conversation = await db.conversations.get(message.conversationId);
      await db.messages.update(clientMessageId, {
        messageId: clientMessageId,
        seq: (conversation?.lastSeq ?? 0) + SEALED_SEQ_OFFSET,
        state: 'SENT',
        sealed: true,
        expiresAt: expiryFor(conversation, message.createdAt),
      });
    });
  }

  /**
   * Opens a sealed envelope and stores what it carries. Everything the identified path gets from
   * the server -- sender, conversation, id -- comes from inside, and each is checked:
   * the certificate from the server's signature, the sender from the Signal session that
   * decrypted it, and the conversation from being a 1:1 chat that sender is actually in.
   */
  async receiveSealed(frame: SealedPayload): Promise<SealedOutcome> {
    let unsealed;
    try {
      unsealed = await sealedSender.unseal(frame.ciphertext, frame.createdAt);
    } catch (error) {
      // Not for us, tampered with, or a forged certificate: there is no trustworthy sender to
      // attribute anything to, so there is nothing to show.
      console.warn('[sealed] cannot open envelope', frame.id, error);
      return { kind: 'dropped' };
    }
    if ((await blockedIds()).includes(unsealed.senderUserId)) {
      // The server could not refuse it -- it did not know who sent it. We can.
      return { kind: 'dropped' };
    }

    const sender = unsealed.senderUserId;
    let inner: InnerPayload;
    try {
      const plaintext = await crypto.decrypt(unsealed.senderDeviceId, unsealed.cipherType, unsealed.ciphertext);
      inner = JSON.parse(plaintext) as InnerPayload;
    } catch (error) {
      // A ratchet desync, as on the identified path. The envelope told us who it is from, so the
      // user gets the same recoverable placeholder in that chat instead of a silent gap.
      console.warn('[sealed] cannot decrypt inner message', frame.id, error);
      await this.storeSealedPlaceholder(frame, sender);
      return { kind: 'dropped' };
    }
    // The certificate names a sender; the session proves it. A valid certificate wrapped around
    // a ciphertext from some other session would have failed to decrypt; this catches a
    // certificate for a key the session was never bound to.
    if ((await crypto.remoteIdentityKey(unsealed.senderDeviceId)) !== unsealed.identityKey) {
      console.warn('[sealed] certificate does not match the session identity; dropping');
      return { kind: 'dropped' };
    }
    const senderIdentity = unsealed.identityKey;

    if (sender !== this.selfUserId) {
      await identityTrust
        .observeDevice(sender, senderIdentity)
        .catch((error) => console.warn('[trust] could not record identity key', error));
      await sealedSender.rememberPeerAccessKey(sender, inner.accessKey);
    }

    if (!inner.conversationId) return { kind: 'dropped' };
    const discovered = await this.ensureConversationKnown(inner.conversationId);
    const conversation = await db.conversations.get(inner.conversationId);
    if (!conversation || conversation.type !== 'DIRECT' || !conversation.participantIds.includes(sender)) {
      console.warn('[sealed] message names a conversation its sender is not in; dropping');
      return { kind: 'dropped' };
    }

    if (inner.kind === 'receipt') {
      if (sender !== this.selfUserId && inner.receipt && inner.messageIds) {
        await this.applySealedReceipt(conversation.id, inner.receipt, inner.messageIds);
      }
      return { kind: 'receipt' };
    }
    if (inner.kind) {
      await this.applyControl(conversation.id, sender, inner);
      return { kind: 'control' };
    }

    const messageId = inner.messageId ?? frame.id;
    if (await db.messages.where('messageId').equals(messageId).first()) return { kind: 'dropped' };
    // Our own message from another of our devices: this device may be the one that sent it.
    if (await db.messages.get(messageId)) return { kind: 'dropped' };

    const ours = sender === this.selfUserId;
    await db.transaction('rw', db.messages, db.conversations, async () => {
      const current = await db.conversations.get(conversation.id);
      await db.messages.put({
        clientMessageId: messageId,
        messageId,
        conversationId: conversation.id,
        senderId: sender,
        seq: (current?.lastSeq ?? 0) + SEALED_SEQ_OFFSET,
        body: inner.body,
        contentType: inner.contentType,
        state: ours ? 'SENT' : 'DELIVERED',
        sealed: true,
        createdAt: frame.createdAt,
        expiresAt: expiryFor(current, frame.createdAt),
        replyTo: inner.replyTo,
        forwarded: inner.forwarded,
        location: inner.location,
        mentions: inner.mentions,
      });
      if (current) {
        await db.conversations.update(conversation.id, {
          lastMessageAt: frame.createdAt,
          lastMessagePreview: inner.location ? locationPreview(inner.location) : inner.body,
          unreadCount: current.unreadCount + (ours ? 0 : 1),
        });
      }
    });
    return { kind: 'message', senderId: sender, conversationId: conversation.id, messageId, discovered };
  }

  /** "Waiting for this message" in the 1:1 chat with the sender, when a sealed message will not decrypt. */
  private async storeSealedPlaceholder(frame: SealedPayload, sender: string): Promise<void> {
    if (sender === this.selfUserId) return;
    const conversation = await db.conversations
      .filter((c) => c.type === 'DIRECT' && c.participantIds.includes(sender))
      .first();
    if (!conversation || (await db.messages.get(frame.id))) return;
    await db.transaction('rw', db.messages, db.conversations, async () => {
      await db.messages.put({
        clientMessageId: frame.id,
        messageId: frame.id,
        conversationId: conversation.id,
        senderId: sender,
        seq: conversation.lastSeq + SEALED_SEQ_OFFSET,
        body: '',
        contentType: 'text/plain',
        state: 'DELIVERED',
        undecryptable: true,
        sealed: true,
        createdAt: frame.createdAt,
      });
      await db.conversations.update(conversation.id, {
        lastMessageAt: frame.createdAt,
        lastMessagePreview: 'Waiting for this message',
        unreadCount: conversation.unreadCount + 1,
      });
    });
  }

  /** A peer's sealed receipt: our messages it names move forward, never back. */
  private async applySealedReceipt(conversationId: string, receipt: 'DELIVERED' | 'READ', messageIds: string[]): Promise<void> {
    // Read receipts are reciprocal (FR-2.3): with ours off, theirs show as delivered only.
    const state = receipt === 'READ' && !(await readReceiptsEnabled()) ? 'DELIVERED' : receipt;
    const rank = { SENT: 0, DELIVERED: 1, READ: 2 } as const;
    const ids = new Set(messageIds);
    await db.messages
      .where('conversationId')
      .equals(conversationId)
      .filter((m) => !!m.messageId && ids.has(m.messageId))
      .modify((message) => {
        if (message.senderId !== this.selfUserId || message.state === 'PENDING' || message.state === 'FAILED') return;
        if (rank[state] > rank[message.state as keyof typeof rank]) message.state = state;
      });
  }

  /** A rejected send may mean our device list is stale; look again next time. */
  forgetDeviceCache(): void {
    this.deviceCache.clear();
  }

  /**
   * DIRECT: one ciphertext per recipient device. Every device of every member must be addressed
   * or that device silently never receives the message, so a missing session is established
   * here rather than skipped.
   */
  private async encryptPairwise(
    conversation: LocalConversation,
    serialised: string,
  ): Promise<RecipientPayload[]> {
    const payloads: RecipientPayload[] = [];
    for (const userId of conversation.participantIds) {
      for (const device of await this.ensureSessions(userId)) {
        const { cipherType, ciphertext } = await crypto.encrypt(device.deviceId, serialised);
        payloads.push({
          recipientUserId: userId,
          recipientDeviceId: device.deviceId,
          cipherType,
          ciphertext,
        });
      }
    }
    return payloads;
  }

  /**
   * GROUP: the message is encrypted once under our sender key. Pairwise payloads go only to
   * devices that have not been handed that key yet -- new members, new devices, or everyone
   * right after a rotation. In a settled group a send carries no pairwise payloads at all.
   */
  private async encryptForGroup(
    conversation: LocalConversation,
    serialised: string,
    clientMessageId: string,
  ): Promise<SendPlan> {
    const { groupCiphertext, distribution, sharedWith } = await senderKeys.encrypt(
      conversation.id,
      serialised,
    );
    const alreadyShared = new Set(sharedWith);
    const handoff = JSON.stringify({ kind: 'skdm', distribution } satisfies SenderKeyHandoff);

    const payloads: RecipientPayload[] = [];
    for (const userId of conversation.participantIds) {
      for (const device of await this.ensureSessions(userId, true)) {
        if (alreadyShared.has(device.deviceId)) continue;
        const { cipherType, ciphertext } = await crypto.encrypt(device.deviceId, handoff);
        payloads.push({
          recipientUserId: userId,
          recipientDeviceId: device.deviceId,
          cipherType,
          ciphertext,
        });
      }
    }

    this.pendingHandoffs.set(clientMessageId, {
      groupId: conversation.id,
      keyId: distribution.keyId,
      deviceIds: payloads.map((p) => p.recipientDeviceId),
    });
    return { payloads, groupCiphertext };
  }

  /**
   * Makes sure we hold a session with every current device of an account and returns the
   * identity key each session is bound to. This is also the one place we see an account's
   * complete key set, so it is where trust is checked: sending to a new key is exactly when
   * the user needs to hear that the security code changed.
   */
  async ensureSessions(
    userId: string,
    allowCached = false,
  ): Promise<Array<{ deviceId: string; identityKey: string }>> {
    const cached = this.deviceCache.get(userId);
    if (allowCached && cached && Date.now() - cached.at < GROUP_DEVICE_CACHE_MS) {
      return cached.devices;
    }

    const devices = await api.devicesOf(userId);
    const result: Array<{ deviceId: string; identityKey: string }> = [];

    for (const device of devices) {
      // Our own sending device decrypts nothing of its own.
      if (device.id === this.selfDeviceId) continue;

      if (!(await crypto.hasSession(device.id))) {
        const { devices: bundles } = await api.bundlesFor(userId, device.id);
        const bundle = bundles.find((candidate) => candidate.deviceId === device.id);
        if (!bundle) {
          throw new Error(`No prekey bundle available for device ${device.id}`);
        }
        await crypto.establishSession(bundle);
      }

      // The key the session actually uses, not the one the server lists: verification is only
      // worth anything if it covers what we encrypt to.
      const identityKey = await crypto.remoteIdentityKey(device.id);
      if (!identityKey) throw new Error(`Session for device ${device.id} has no identity key`);
      result.push({ deviceId: device.id, identityKey });
    }

    if (userId !== this.selfUserId && result.length > 0) {
      await identityTrust
        .observeAccount(userId, result.map((device) => device.identityKey))
        .catch((error) => console.warn('[trust] could not record identity keys', error));
    }
    this.deviceCache.set(userId, { at: Date.now(), devices: result });
    return result;
  }

  /**
   * Both sides must hash the same two key sets, so ours includes our other devices as well as
   * this one -- the peer encrypts to all of them, and the number has to cover what they see.
   */
  async safetyNumberWith(userId: string): Promise<string> {
    const ours = await this.ensureSessions(this.selfUserId);
    const theirs = await this.ensureSessions(userId);
    return crypto.safetyNumber(
      {
        userId: this.selfUserId,
        identityKeys: [await crypto.localIdentityKey(), ...ours.map((d) => d.identityKey)],
      },
      { userId, identityKeys: theirs.map((d) => d.identityKey) },
    );
  }

  /**
   * Decrypts an inbound message and stores it. Failure is a visible state, not a dropped row.
   *
   * @returns true when this message introduced a conversation the client had not seen, which
   *   the caller uses to widen its presence subscription
   */
  async receive(frame: MessagePayload): Promise<boolean> {
    const existing = await db.messages.where('messageId').equals(frame.messageId).first();
    if (existing) return false; // at-least-once transport; duplicates are expected and harmless

    if (frame.encoding === 'system/v1') {
      return this.receiveGroupEvent(frame);
    }

    let body = '';
    let contentType = 'text/plain';
    let undecryptable = false;
    let media: MediaDescriptor | undefined;
    let replyTo: ReplyRef | undefined;
    let forwarded: boolean | undefined;
    let location: LocationInfo | undefined;
    let mentions: string[] | undefined;

    try {
      const inner = JSON.parse(await this.decryptContent(frame)) as InnerPayload;
      if (frame.senderId !== this.selfUserId) {
        await sealedSender.rememberPeerAccessKey(frame.senderId, inner.accessKey);
      }
      if (inner.kind) {
        // A reaction, edit or delete: applied to its target, never shown as a bubble. The
        // sequence still advances, or the next SYNC would ask for it again forever.
        await this.applyControl(frame.conversationId, frame.senderId, inner);
        await this.advanceCursor(frame);
        return false;
      }
      body = inner.body;
      contentType = inner.contentType;
      media = inner.media;
      replyTo = inner.replyTo;
      forwarded = inner.forwarded;
      location = inner.location;
      mentions = inner.mentions;
    } catch (error) {
      // A ratchet desync, a reinstalled peer, or a sender key we were never handed. The user
      // sees a recoverable placeholder rather than a gap they have no way to notice.
      console.warn('[crypto] Cannot decrypt message', frame.messageId, error);
      body = '';
      undecryptable = true;
    }

    // Someone messaging us for the first time arrives in a conversation this client has never
    // heard of. Without pulling it in, the message lands in the store with no conversation to
    // render inside -- so the most common way a chat begins would display nothing at all.
    const discoveredConversation = await this.ensureConversationKnown(frame.conversationId);

    await this.store(frame, {
      body,
      contentType,
      undecryptable,
      media,
      replyTo,
      forwarded,
      location,
      mentions,
      preview: undecryptable
        ? 'Waiting for this message'
        : location
          ? locationPreview(location)
          : media
            ? mediaPreview(media, body)
            : body,
      countsAsUnread: frame.senderId !== this.selfUserId,
    });
    return discoveredConversation;
  }

  /**
   * Pairwise first: for a DIRECT message it is the content; for a group message it is, when
   * present, the sender key we need to open the shared ciphertext that follows.
   */
  private async decryptContent(frame: MessagePayload): Promise<string> {
    let pairwise: string | null = null;
    if (frame.ciphertext && frame.cipherType !== 0) {
      pairwise = await crypto.decrypt(frame.senderDeviceId, frame.cipherType, frame.ciphertext);

      if (frame.senderId !== this.selfUserId) {
        const identityKey = await crypto.remoteIdentityKey(frame.senderDeviceId);
        if (identityKey) {
          await identityTrust
            .observeDevice(frame.senderId, identityKey)
            .catch((error) => console.warn('[trust] could not record identity key', error));
        }
      }
    }

    if (!frame.groupCiphertext) {
      if (pairwise === null) throw new Error('Message carried nothing for this device');
      return pairwise;
    }

    if (pairwise !== null) {
      const handoff = JSON.parse(pairwise) as SenderKeyHandoff;
      // A key for another group smuggled into this one would let a member of both cross-post.
      if (handoff.kind === 'skdm' && handoff.distribution.groupId === frame.conversationId) {
        await senderKeys.process(frame.senderDeviceId, handoff.distribution);
      }
    }
    return senderKeys.decrypt(frame.conversationId, frame.senderDeviceId, frame.groupCiphertext);
  }

  /**
   * Server-authored group events. Stored as timeline notices, then acted on: membership is
   * re-read so the next send addresses the right devices, and when someone leaves we drop our
   * sender key so the next message goes out under one they never received.
   */
  private async receiveGroupEvent(frame: MessagePayload): Promise<boolean> {
    let event: GroupEvent;
    try {
      event = JSON.parse(bufferToUtf8(base64ToBuffer(frame.groupCiphertext ?? ''))) as GroupEvent;
    } catch (error) {
      console.warn('[groups] Unreadable group event', frame.messageId, error);
      return false;
    }

    const discovered = await this.ensureConversationKnown(frame.conversationId);
    await this.store(frame, {
      body: JSON.stringify(event),
      contentType: SYSTEM_GROUP_EVENT,
      undecryptable: false,
      preview: undefined,
      countsAsUnread: false,
    });

    const aboutMe = event.userIds?.includes(this.selfUserId) ?? false;
    if (removesSomeone(event)) {
      await senderKeys.rotate(frame.conversationId);
      if (aboutMe) {
        await db.conversations.update(frame.conversationId, { left: true });
        return discovered;
      }
    }
    if (!discovered) {
      await refreshGroupDetails(frame.conversationId).catch((error) =>
        console.warn('[groups] Could not refresh group after event', error),
      );
    }
    return discovered;
  }

  private async store(
    frame: MessagePayload,
    content: {
      body: string;
      contentType: string;
      undecryptable: boolean;
      media?: MediaDescriptor;
      replyTo?: ReplyRef;
      forwarded?: boolean;
      location?: LocationInfo;
      mentions?: string[];
      /** undefined leaves the chat-list preview as it was. */
      preview: string | undefined;
      countsAsUnread: boolean;
    },
  ): Promise<void> {
    await db.transaction('rw', db.messages, db.conversations, async () => {
      await db.messages.put({
        clientMessageId: frame.clientMessageId,
        messageId: frame.messageId,
        conversationId: frame.conversationId,
        senderId: frame.senderId,
        seq: frame.seq,
        body: content.body,
        contentType: content.contentType,
        state: 'DELIVERED',
        undecryptable: content.undecryptable,
        createdAt: frame.createdAt,
        expiresAt: frame.expiresAt,
        media: content.media,
        replyTo: content.replyTo,
        forwarded: content.forwarded,
        location: content.location,
        mentions: content.mentions,
      });

      const conversation = await db.conversations.get(frame.conversationId);
      if (conversation) {
        await db.conversations.update(frame.conversationId, {
          lastSeq: Math.max(conversation.lastSeq, frame.seq),
          lastMessageAt: frame.createdAt,
          ...(content.preview !== undefined ? { lastMessagePreview: content.preview } : {}),
          unreadCount: conversation.unreadCount + (content.countsAsUnread ? 1 : 0),
        });
      }
    });
  }

  private async advanceCursor(frame: MessagePayload): Promise<void> {
    const conversation = await db.conversations.get(frame.conversationId);
    if (conversation && frame.seq > conversation.lastSeq) {
      await db.conversations.update(frame.conversationId, { lastSeq: frame.seq });
    }
  }

  /**
   * Applies a control message to its target. Authorship is checked here as well as on the
   * server: a client must not let one member edit or delete another's message just because a
   * well-formed control arrived. Reactions are per person, so the reactor is simply the sender.
   * A control whose target this device never had (it predates a link, or was already deleted)
   * has nothing to act on and is dropped.
   */
  private async applyControl(conversationId: string, actorId: string, inner: InnerPayload): Promise<void> {
    if (!inner.targetId) return;
    const target = await db.messages.where('messageId').equals(inner.targetId).first();
    if (!target || target.conversationId !== conversationId) return;

    if (inner.kind === 'reaction') {
      const reactions = { ...(target.reactions ?? {}) };
      if (inner.emoji) reactions[actorId] = inner.emoji;
      else delete reactions[actorId];
      await db.messages.update(target.clientMessageId, { reactions });
      return;
    }
    if (target.senderId !== actorId || target.deletedForAll) return;

    if (inner.kind === 'location') {
      // Only the sharer moves their own pin, and a delayed update never rewinds a newer one.
      if (!target.location || !inner.location) return;
      const current = target.location.live?.updatedAt ?? 0;
      if ((inner.location.live?.updatedAt ?? 0) < current) return;
      await db.messages.update(target.clientMessageId, { location: inner.location });
      return;
    }

    if (inner.kind === 'edit') {
      await db.messages.update(target.clientMessageId, { body: inner.body, editedAt: inner.sentAt || Date.now() });
    } else if (inner.kind === 'delete') {
      await db.transaction('rw', db.messages, db.mediaBlobs, async () => {
        await db.messages.update(target.clientMessageId, {
          body: '',
          media: undefined,
          replyTo: undefined,
          reactions: undefined,
          deletedForAll: true,
        });
        if (target.media?.mediaId) await db.mediaBlobs.delete(target.media.mediaId);
      });
    }
    await this.refreshPreview(conversationId);
  }

  /** Keeps the chat-list preview honest after an edit or delete changes the latest message. */
  private async refreshPreview(conversationId: string): Promise<void> {
    const latest = await db.messages
      .where('[conversationId+seq]')
      .between([conversationId, 0], [conversationId, Number.MAX_SAFE_INTEGER], true, true)
      .reverse()
      .filter((m) => !m.control && !m.contentType.startsWith('system/'))
      .first();
    if (!latest) return;
    await db.conversations.update(conversationId, {
      lastMessagePreview: latest.deletedForAll
        ? 'This message was deleted'
        : latest.media
          ? mediaPreview(latest.media, latest.body)
          : latest.body,
    });
  }

  /**
   * Pulls in a conversation, and the people in it, the first time we see traffic for it.
   *
   * @returns true if it was newly added
   */
  private async ensureConversationKnown(conversationId: string): Promise<boolean> {
    if (await db.conversations.get(conversationId)) return false;

    try {
      await saveConversation(await api.conversationById(conversationId));
      return true;
    } catch (error) {
      // Offline, or we lost access. The message itself is still stored, and the next successful
      // sync will attach it to a conversation rather than losing it.
      console.warn('[pipeline] Could not resolve conversation', conversationId, error);
      return false;
    }
  }
}

/** The plaintext for a stored outgoing row, message or control. */
function innerFor(message: LocalMessage): InnerPayload {
  return message.control
    ? innerFromControl(message.control, message.createdAt)
    : {
        contentType: message.contentType,
        body: message.body,
        sentAt: message.createdAt,
        media: message.media,
        replyTo: message.replyTo,
        forwarded: message.forwarded,
        location: message.location,
        mentions: message.mentions,
      };
}

/** Disappearing messages for sealed rows, which get no server-computed expiry. */
function expiryFor(conversation: LocalConversation | undefined, createdAt: number): number | undefined {
  return conversation?.disappearingSeconds ? createdAt + conversation.disappearingSeconds * 1000 : undefined;
}

/** The encrypted payload a control message carries, for sending and for applying locally. */
function innerFromControl(control: ControlAction, sentAt: number): InnerPayload {
  return {
    kind: control.type,
    targetId: control.targetId,
    emoji: control.type === 'reaction' ? control.emoji : undefined,
    body: control.type === 'edit' ? control.body : '',
    location: control.type === 'location' ? control.location : undefined,
    contentType: 'text/plain',
    sentAt,
  };
}
