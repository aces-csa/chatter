import { db, getMeta, setMeta } from '@/db/db';
import { api, ApiError } from '@/lib/api';
import { sealedSender } from '@/lib/crypto/SealedSender';
import { readReceiptsEnabled } from '@/lib/quietHours';
import { crypto } from '@/lib/crypto/LibsignalProvider';
import {
  DELETE_FOR_EVERYONE_WINDOW_MS,
  EDIT_WINDOW_MS,
  MessagePipeline,
  PENDING_SEQ,
  type ComposeOptions,
  type SealedPlan,
} from './MessagePipeline';
import type { LocalMessage, LocationInfo } from '@/db/db';
import { LiveLocationTracker } from './LiveLocation';
import { CallManager, type CallEventPayload, type CallSignalPayload } from './CallManager';
import { currentPosition } from '@/lib/location';
import { SWEEP_INTERVAL_MS, sweepExpiredMessages } from './expiry';
import { MediaUploads } from './MediaUploads';
import { ensurePushSubscription, notifyIncoming } from '@/lib/notifications';
import { useUiStore } from '@/state/uiStore';
import { getValidAccessToken, useAuthStore } from '@/state/authStore';
import type { PreparedMedia } from '@/lib/media/prepare';
import { realtime, type ConnectionStatus } from './StompConnection';
import { usePresenceStore } from '@/state/presenceStore';
import {
  envelope,
  type AckPayload,
  type ConnectOkPayload,
  type Envelope,
  type MessagePayload,
  type NackPayload,
  type PresencePayload,
  type ReceiptPayload,
  type SealedPayload,
  type SyncPagePayload,
  type TypingFromPayload,
} from './envelope';

const PREKEY_LOW_WATER_MARK = 20;
const PREKEY_TOP_UP_BATCH = 50;
const MAX_SEND_ATTEMPTS = 8;
/** One typing frame at most this often, while the user keeps typing. */
const TYPING_THROTTLE_MS = 2_500;

/**
 * Owns the connection, the sync cursor and the outbox. Everything it learns is written to Dexie;
 * the UI reads Dexie. That inversion is what makes the app work offline without a second code path.
 */
export class RealtimeService {
  private pipeline: MessagePipeline | null = null;
  private unsubscribers: Array<() => void> = [];
  private flushing = false;
  private flushTimer: number | null = null;
  private readonly lastTypingSentAt = new Map<string, number>();
  private sweepTimer: number | null = null;
  private selfUserId: string | null = null;
  private readonly uploads = new MediaUploads(() => this.flushSoon());
  private deviceId: string | null = null;
  readonly calls = new CallManager({
    selfUserId: () => this.selfUserId,
    selfDeviceId: () => this.deviceId,
    ensureSessions: async (userId) => {
      await this.requirePipeline().ensureSessions(userId, true);
    },
    send: (destination, body) => realtime.send(destination, body),
  });
  private readonly liveLocation = new LiveLocationTracker(async (target, location) => {
    await this.requirePipeline().composeControl(target, { type: 'location', location });
    this.flushSoon();
  });

  async start(userId: string, deviceId: string): Promise<void> {
    this.stop();
    this.selfUserId = userId;
    this.deviceId = deviceId;
    void ensurePushSubscription().catch((error) => console.warn('[push] subscription failed', error));
    this.pipeline = new MessagePipeline(userId, deviceId);

    this.unsubscribers = [
      realtime.on('CONNECT_OK', (frame) => void this.onConnected(frame as Envelope<ConnectOkPayload>)),
      realtime.on('MESSAGE', (frame) => void this.onMessage(frame as Envelope<MessagePayload>)),
      realtime.on('SEALED', (frame) => void this.processSealed([(frame as Envelope<SealedPayload>).payload], true)),
      realtime.on('SYNC_PAGE', (frame) => void this.onSyncPage(frame as Envelope<SyncPagePayload>)),
      realtime.on('ACK', (frame) => void this.onAck(frame as Envelope<AckPayload>)),
      realtime.on('NACK', (frame) => void this.onNack(frame as Envelope<NackPayload>)),
      realtime.on('DELIVERED', (frame) => void this.onReceipt(frame as Envelope<ReceiptPayload>, 'DELIVERED')),
      realtime.on('READ', (frame) => void this.onReceipt(frame as Envelope<ReceiptPayload>, 'READ')),
      realtime.on('PRESENCE', (frame) => this.onPresence(frame as Envelope<PresencePayload>)),
      realtime.on('TYPING', (frame) => this.onTyping(frame as Envelope<TypingFromPayload>)),
      realtime.on('ERROR', (frame) => this.onError(frame as Envelope<{ code: string; message: string }>)),
      realtime.on('CALL_EVENT', (frame) => this.calls.onEvent((frame as Envelope<CallEventPayload>).payload)),
      realtime.on('CALL_SIGNAL', (frame) => this.calls.onSignal((frame as Envelope<CallSignalPayload>).payload)),
      // The gateway refuses a revoked device's frames too, in case the pushed notice was missed.
      realtime.onRefusal((code) => {
        if (code === 'DEVICE_REVOKED') void useAuthStore.getState().signOut();
      }),
    ];

    realtime.connect(getValidAccessToken, deviceId);

    void sweepExpiredMessages();
    void this.uploads.resumeAll();
    void this.liveLocation.resume();
    this.sweepTimer = window.setInterval(() => void sweepExpiredMessages(), SWEEP_INTERVAL_MS);

    // Retry pending sends whenever the browser thinks the network came back, not only on a tick.
    window.addEventListener('online', this.flushSoon);
  }

  stop(): void {
    window.removeEventListener('online', this.flushSoon);
    this.uploads.stopAll();
    this.liveLocation.stopAll();
    this.calls.reset();
    if (this.sweepTimer !== null) {
      window.clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.unsubscribers.forEach((off) => off());
    this.unsubscribers = [];
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    realtime.disconnect();
    usePresenceStore.getState().reset();
    this.pipeline = null;
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    return realtime.onStatus(listener);
  }

  async composeText(conversationId: string, body: string, options: ComposeOptions = {}): Promise<void> {
    await this.requirePipeline().composeText(conversationId, body, options);
    this.flushSoon();
  }

  /** Queues an attachment: it uploads in the background, then the message sends itself. */
  async composeMedia(
    conversationId: string,
    prepared: PreparedMedia,
    caption: string,
    options: ComposeOptions = {},
  ): Promise<void> {
    const clientMessageId = await this.requirePipeline().composeMedia(conversationId, prepared, caption, options);
    this.uploads.run(clientMessageId);
  }

  // --- Location ------------------------------------------------------------------------------

  async shareLocation(conversationId: string, options: ComposeOptions = {}): Promise<void> {
    const position = await currentPosition();
    await this.requirePipeline().composeLocation(
      conversationId,
      { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy },
      options,
    );
    this.flushSoon();
  }

  async startLiveLocation(conversationId: string, durationMs: number, options: ComposeOptions = {}): Promise<void> {
    const position = await currentPosition();
    const now = Date.now();
    const location: LocationInfo = {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy,
      live: { until: now + durationMs, updatedAt: now },
    };
    const clientMessageId = await this.requirePipeline().composeLocation(conversationId, location, options);
    await this.liveLocation.track(clientMessageId, now + durationMs);
    this.flushSoon();
  }

  /** Ends a live share early; every device showing it is told it stopped. */
  async stopLiveLocation(message: LocalMessage): Promise<void> {
    await this.liveLocation.untrack(message.clientMessageId);
    if (!message.location?.live || !message.messageId) return;
    const now = Date.now();
    await this.requirePipeline().composeControl(message, {
      type: 'location',
      location: { ...message.location, live: { ...message.location.live, updatedAt: now, stoppedAt: now } },
    });
    this.flushSoon();
  }

  // --- Message actions (step 12) ---------------------------------------------------------------

  /** Tapping the emoji you already reacted with takes the reaction back (FR-3.7). */
  async react(target: LocalMessage, emoji: string): Promise<void> {
    const mine = target.reactions?.[this.selfUserId ?? ''];
    await this.requirePipeline().composeControl(target, { type: 'reaction', emoji: mine === emoji ? '' : emoji });
    this.flushSoon();
  }

  async editMessage(target: LocalMessage, body: string): Promise<void> {
    if (!body.trim() || body === target.body) return;
    if (Date.now() - target.createdAt > EDIT_WINDOW_MS) throw new Error('Messages can only be edited for 15 minutes');
    await this.requirePipeline().composeControl(target, { type: 'edit', body });
    this.flushSoon();
  }

  async deleteForEveryone(targets: LocalMessage[]): Promise<void> {
    for (const target of targets) {
      if (Date.now() - target.createdAt > DELETE_FOR_EVERYONE_WINDOW_MS) continue;
      await this.requirePipeline().composeControl(target, { type: 'delete' });
    }
    this.flushSoon();
  }

  /**
   * Delete for me: this device only. A message still waiting to send is withdrawn from the
   * outbox too, or it would be deleted here and delivered everywhere else.
   */
  async deleteForMe(targets: LocalMessage[]): Promise<void> {
    await db.transaction('rw', [db.messages, db.outbox, db.mediaBlobs], async () => {
      for (const target of targets) {
        await db.messages.delete(target.clientMessageId);
        await db.outbox.delete(target.clientMessageId);
        await db.mediaBlobs.delete(`local:${target.clientMessageId}`);
      }
    });
    for (const target of targets) {
      if (target.upload && !target.upload.done) await this.uploads.cancel(target.clientMessageId);
    }
  }

  /** Stars all of them, unless all are already starred, in which case it unstars them. */
  async toggleStar(targets: LocalMessage[]): Promise<void> {
    const starring = targets.some((t) => !t.starredAt);
    const now = Date.now();
    await db.transaction('rw', db.messages, async () => {
      for (const target of targets) {
        await db.messages.update(target.clientMessageId, { starredAt: starring ? now : undefined });
      }
    });
  }

  /** FR-3.8: each message goes to each chosen conversation, oldest first so order survives. */
  async forward(sources: LocalMessage[], conversationIds: string[]): Promise<void> {
    const ordered = [...sources].sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt);
    for (const conversationId of conversationIds) {
      for (const source of ordered) {
        await this.requirePipeline().composeForward(conversationId, source);
      }
    }
    this.flushSoon();
  }

  private requirePipeline(): MessagePipeline {
    if (!this.pipeline) throw new Error('Realtime service is not started');
    return this.pipeline;
  }

  cancelUpload(clientMessageId: string): Promise<void> {
    return this.uploads.cancel(clientMessageId);
  }

  private flushSoon = (): void => {
    if (this.flushTimer !== null) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      void this.flushOutbox();
    }, 50);
  };

  /**
   * FR-8.3: replies typed into a notification. The service worker cannot encrypt (the keys and
   * ratchet live with the page), so it parks the text in IndexedDB and the page sends it.
   */
  async sendPendingReplies(): Promise<void> {
    const pending = (await getMeta<Array<{ conversationId: string; text: string }>>('pendingReplies')) ?? [];
    if (pending.length === 0 || !this.pipeline) return;
    await setMeta('pendingReplies', []);
    for (const reply of pending) {
      if (reply.text.trim() && (await db.conversations.get(reply.conversationId))) {
        await this.pipeline.composeText(reply.conversationId, reply.text.trim());
      }
    }
    this.flushSoon();
  }

  private async onConnected(frame: Envelope<ConnectOkPayload>): Promise<void> {
    console.info('[realtime] connected as device', frame.payload.deviceId);
    await this.topUpPreKeysIfLow();
    // Every connect, so a key rotated on another of our devices reaches this one before it is
    // shared again in an outgoing message.
    await sealedSender.refreshOwnAccessKey().catch((error) => console.warn('[sealed] access key refresh failed', error));
    await this.requestSync();
    await this.drainSealed();
    await this.subscribeToPresence();
    await this.flushOutbox();
    await this.sendPendingReplies();
  }

  /**
   * Running out of one-time prekeys is not fatal -- X3DH falls back to the signed prekey alone,
   * losing forward secrecy on that first message -- but it should be rare, so we top up early.
   */
  private async topUpPreKeysIfLow(): Promise<void> {
    try {
      const { available, highestKeyId } = await api.preKeyCount();
      if (available >= PREKEY_LOW_WATER_MARK) return;
      const keys = await crypto.generateMoreOneTimeKeys(PREKEY_TOP_UP_BATCH, highestKeyId + 1);
      await api.topUpKeys(keys);
      console.info('[crypto] topped up %d one-time prekeys', keys.length);
    } catch (error) {
      console.warn('[crypto] prekey top-up failed; will retry on next connect', error);
    }
  }

  /** One compact frame carries every conversation's cursor. */
  private async requestSync(): Promise<void> {
    const conversations = await db.conversations.toArray();
    const cursors: Record<string, number> = {};
    for (const conversation of conversations) {
      cursors[conversation.id] = conversation.lastSeq;
    }
    realtime.send('/app/sync', envelope('SYNC', { cursors, limit: 500 }));
  }

  private async onSyncPage(frame: Envelope<SyncPagePayload>): Promise<void> {
    let discovered = false;
    for (const inner of frame.payload.envelopes) {
      discovered = (await this.pipeline?.receive(inner.payload)) === true || discovered;
    }
    if (discovered) {
      await this.subscribeToPresence();
    }
    if (frame.payload.hasMore) {
      await this.requestSync();
    }
    await setMeta('lastSyncAt', Date.now());
  }

  private async onMessage(frame: Envelope<MessagePayload>): Promise<void> {
    const payload = frame.payload;
    const conversation = await db.conversations.get(payload.conversationId);

    // Gap detection: a sequence jump means we missed frames. Ask for a backfill rather than
    // trusting the stream, which is cheap insurance against a silently torn history.
    if (conversation && payload.seq > conversation.lastSeq + 1) {
      console.warn(
        '[realtime] sequence gap in %s (have %d, got %d); backfilling',
        payload.conversationId,
        conversation.lastSeq,
        payload.seq,
      );
      await this.requestSync();
    }

    // A message arriving is the most reliable "stopped typing" signal there is; waiting for
    // the explicit stop frame leaves the indicator up under the message that was just sent.
    usePresenceStore.getState().setTyping(payload.conversationId, payload.senderId, null);

    // A brand-new conversation is not in our presence subscription yet, so the peer would
    // show no status until the next reconnect. Widen it as soon as we learn about the chat.
    const discovered = await this.pipeline?.receive(payload);
    if (discovered) {
      await this.subscribeToPresence();
    }

    // Live frames only: a reconnect SYNC replaying the backlog must not ring 200 times.
    if (payload.senderId !== this.selfUserId && payload.encoding !== 'system/v1') {
      const stored = await db.messages.where('messageId').equals(payload.messageId).first();
      if (stored) {
        void notifyIncoming(stored, useUiStore.getState().activeConversationId, this.selfUserId).catch((error) =>
          console.debug('[notify] skipped', error),
        );
      }
    }

    // Tell the sender it landed. This is what turns their single tick into a double tick.
    realtime.send(
      '/app/receipt',
      envelope('DELIVERED', {
        conversationId: payload.conversationId,
        uptoSeq: payload.seq,
      }),
    );
  }

  // --- Sealed sender ---------------------------------------------------------------------------

  /** Sealed envelopes stored while we were away. They are not part of SYNC: they have no sequence. */
  private async drainSealed(): Promise<void> {
    try {
      const pending = await api.pendingSealed();
      if (pending.length > 0) await this.processSealed(pending, false);
    } catch (error) {
      console.warn('[sealed] could not fetch pending sealed messages', error);
    }
  }

  /**
   * Opens, stores and acknowledges sealed envelopes, then sends each sender one sealed DELIVERED
   * receipt covering everything of theirs in the batch.
   *
   * <p>Acknowledging deletes the server's copy, so it happens only after the message is stored.
   * Crash in between and the envelope comes again; its Signal message key is already spent, it
   * fails to decrypt, and the stored copy stands.
   */
  private async processSealed(items: SealedPayload[], live: boolean): Promise<void> {
    const pipeline = this.pipeline;
    if (!pipeline) return;
    const handled: string[] = [];
    const bySender = new Map<string, { conversationId: string; messageIds: string[] }>();
    let discovered = false;

    for (const item of items) {
      const outcome = await pipeline.receiveSealed(item).catch((error) => {
        console.warn('[sealed] receive failed', error);
        return null;
      });
      if (!outcome) continue; // unexpected failure: leave it on the server and try again later
      handled.push(item.id);
      if (outcome.kind !== 'message') continue;
      discovered = discovered || outcome.discovered;
      if (outcome.senderId === this.selfUserId) continue;

      usePresenceStore.getState().setTyping(outcome.conversationId, outcome.senderId, null);
      const group = bySender.get(outcome.senderId) ?? { conversationId: outcome.conversationId, messageIds: [] };
      group.messageIds.push(outcome.messageId);
      bySender.set(outcome.senderId, group);
      if (live) {
        const stored = await db.messages.get(outcome.messageId);
        if (stored) {
          void notifyIncoming(stored, useUiStore.getState().activeConversationId, this.selfUserId).catch((error) =>
            console.debug('[notify] skipped', error),
          );
        }
      }
    }

    if (handled.length > 0) {
      await api.ackSealed(handled).catch((error) => console.warn('[sealed] ack failed; will be redelivered', error));
    }
    for (const [senderId, group] of bySender) {
      await this.sendSealedReceipt(group.conversationId, senderId, 'DELIVERED', group.messageIds);
    }
    if (discovered) await this.subscribeToPresence();
  }

  /**
   * Best effort, like a live identified receipt: if it cannot go now, the READ that follows
   * carries the tick forward. It never falls back to an identified receipt -- that would tell
   * the server who wrote to whom, which is the thing sealed sender exists to hide.
   */
  private async sendSealedReceipt(
    conversationId: string,
    peer: string,
    state: 'DELIVERED' | 'READ',
    messageIds: string[],
  ): Promise<void> {
    try {
      const plan = await this.pipeline?.buildSealedReceipt(conversationId, peer, state, messageIds);
      if (!plan) return;
      await api.sealedDeliver(plan.recipientUserId, plan.accessKey, plan.peerTargets);
      await db.messages.where('clientMessageId').anyOf(messageIds).modify((message) => {
        if (message.receiptSent !== 'READ') message.receiptSent = state;
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'UNIDENTIFIED_ACCESS_DENIED') {
        await sealedSender.forgetPeerAccessKey(peer);
      }
      console.debug('[sealed] receipt not sent', error);
    }
  }

  /**
   * Sends one outbox item sealed, if it can go that way.
   *
   * @returns true if sent; false if it must go identified instead
   * @throws on a failure worth retrying sealed (network, the recipient's devices changed)
   */
  private async trySealed(clientMessageId: string): Promise<boolean> {
    const pipeline = this.requirePipeline();
    let plan: SealedPlan | null;
    try {
      plan = await pipeline.buildSealedPlan(clientMessageId);
    } catch (error) {
      // Could not get a certificate or seal: identified still works, and still end-to-end encrypted.
      console.warn('[sealed] cannot prepare a sealed send; sending identified', error);
      return false;
    }
    if (!plan) return false;

    try {
      await api.sealedDeliver(plan.recipientUserId, plan.accessKey, plan.peerTargets);
      if (plan.selfTargets.length > 0) await api.sealedToSelf(plan.selfTargets);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'UNIDENTIFIED_ACCESS_DENIED') {
        // Rotated (perhaps because they blocked us) or never valid. Identified from here on,
        // until their next message carries a key again.
        await sealedSender.forgetPeerAccessKey(plan.recipientUserId);
        return false;
      }
      if (error instanceof ApiError && error.code === 'DEVICES_CHANGED') pipeline.forgetDeviceCache();
      throw error;
    }
    await pipeline.onSealedSent(clientMessageId);
    return true;
  }

  private async onAck(frame: Envelope<AckPayload>): Promise<void> {
    const { clientMessageId, messageId, seq, ts, expiresAt } = frame.payload;
    await this.pipeline?.onAcked(clientMessageId);
    await db.transaction('rw', db.messages, db.outbox, db.conversations, async () => {
      await db.messages.update(clientMessageId, {
        messageId,
        seq,
        createdAt: ts,
        state: 'SENT',
        expiresAt,
      });
      await db.outbox.delete(clientMessageId);

      const message = await db.messages.get(clientMessageId);
      if (message) {
        const conversation = await db.conversations.get(message.conversationId);
        if (conversation && seq > conversation.lastSeq) {
          await db.conversations.update(message.conversationId, { lastSeq: seq, lastMessageAt: ts });
        }
      }
    });
  }

  private async onNack(frame: Envelope<NackPayload>): Promise<void> {
    const { clientMessageId, retryable, message } = frame.payload;
    const entry = await db.outbox.get(clientMessageId);
    // Most rejections that are not transient mean our picture of who to address is stale.
    this.pipeline?.forgetDeviceCache();

    if (!retryable || (entry?.attempts ?? 0) >= MAX_SEND_ATTEMPTS) {
      console.error('[realtime] send permanently failed:', message);
      await this.failPermanently(clientMessageId);
      return;
    }

    const attempts = (entry?.attempts ?? 0) + 1;
    await db.outbox.update(clientMessageId, {
      attempts,
      nextAttemptAt: Date.now() + Math.min(30_000, 500 * 2 ** attempts),
      lastError: message,
    });
  }

  /**
   * A message gets a red "!" and a retry button. A reaction, edit or delete has no bubble to
   * put that on, so its optimistic effect is undone instead -- e.g. an edit refused because
   * the 15-minute window passed while it sat in the outbox.
   */
  private async failPermanently(clientMessageId: string): Promise<void> {
    const row = await db.messages.get(clientMessageId);
    if (row?.control) {
      await this.pipeline?.revertControl(clientMessageId);
      return;
    }
    await db.transaction('rw', db.messages, db.outbox, async () => {
      await db.messages.update(clientMessageId, { state: 'FAILED' });
      await db.outbox.delete(clientMessageId);
    });
  }

  private async onReceipt(
    frame: Envelope<ReceiptPayload>,
    state: 'DELIVERED' | 'READ',
  ): Promise<void> {
    const { conversationId, uptoSeq, userId } = frame.payload;
    // A READ from one of our own other devices: this chat was read elsewhere, so the badge goes
    // here too. It says nothing about the messages we sent.
    if (userId && userId === this.selfUserId) {
      if (state === 'READ') {
        await db.conversations.update(conversationId, { unreadCount: 0, lastReadSeq: uptoSeq, markedUnread: false });
      }
      return;
    }
    const conversation = await db.conversations.get(conversationId);
    const others = (conversation?.participantIds ?? []).filter((id) => id !== this.selfUserId);
    const rank = { SENT: 0, DELIVERED: 1, READ: 2 } as const;

    // Applies to a range, not one message: that is why a fast scrollback does not produce a
    // receipt storm. In a group each member's receipt is recorded, and the tick shows the
    // furthest point *everyone* has reached -- blue only once all have read (FR-4.8).
    await db.messages
      .where('[conversationId+seq]')
      .between([conversationId, 0], [conversationId, uptoSeq], true, true)
      .modify((message) => {
        if (message.senderId !== this.selfUserId || message.state === 'PENDING' || message.state === 'FAILED') return;
        if (conversation?.type !== 'GROUP' || !userId) {
          if (rank[state] > rank[message.state as keyof typeof rank]) message.state = state;
          return;
        }
        const receipts = { ...(message.receipts ?? {}) };
        if (!receipts[userId] || (receipts[userId] === 'DELIVERED' && state === 'READ')) receipts[userId] = state;
        message.receipts = receipts;
        const all = (s: 'DELIVERED' | 'READ') =>
          others.length > 0 && others.every((id) => receipts[id] === 'READ' || receipts[id] === s);
        message.state = all('READ') ? 'READ' : all('DELIVERED') ? 'DELIVERED' : 'SENT';
      });
  }

  /**
   * Marks everything up to a sequence read, in one frame. Sealed messages have no sequence and
   * the server has no record of them, so their READ goes back sealed, listing them by id.
   */
  async markRead(conversationId: string, uptoSeq: number): Promise<void> {
    realtime.send('/app/receipt', envelope('READ', { conversationId, uptoSeq }));
    await db.conversations.update(conversationId, { unreadCount: 0, lastReadSeq: uptoSeq, markedUnread: false });

    const unreadSealed = await db.messages
      .where('conversationId')
      .equals(conversationId)
      .filter((m) => !!m.sealed && m.senderId !== this.selfUserId && m.receiptSent !== 'READ' && !m.undecryptable)
      .toArray();
    if (unreadSealed.length === 0) return;
    if (!(await readReceiptsEnabled())) {
      // Nothing to send, but remember we have been through them.
      await db.messages.bulkUpdate(unreadSealed.map((m) => ({ key: m.clientMessageId, changes: { receiptSent: 'READ' as const } })));
      return;
    }
    const peer = unreadSealed[0].senderId;
    await this.sendSealedReceipt(conversationId, peer, 'READ', unreadSealed.map((m) => m.clientMessageId));
  }

  /**
   * Another of our devices logged this one out. Sign out at once -- wiping local history and
   * keys -- rather than lingering until the access token expires.
   */
  private onError(frame: Envelope<{ code: string; message: string }>): void {
    if (frame.payload.code === 'DEVICE_REVOKED') {
      console.warn('[realtime] this device was revoked; signing out');
      void useAuthStore.getState().signOut();
    }
  }

  private onPresence(frame: Envelope<PresencePayload>): void {
    const { userId, status, lastSeenAt } = frame.payload;
    usePresenceStore.getState().setPresence(userId, { status, lastSeenAt });
  }

  private onTyping(frame: Envelope<TypingFromPayload>): void {
    const { conversationId, userId, state } = frame.payload;
    usePresenceStore
      .getState()
      .setTyping(conversationId, userId, state === 'stop' ? null : state === 'recording' ? 'recording' : 'typing');
  }

  /**
   * Scopes presence to the people we actually have conversations with. Subscribing to every
   * known user would make the server fan out status changes nobody is looking at.
   */
  async subscribeToPresence(): Promise<void> {
    const conversations = await db.conversations.toArray();
    const userIds = [...new Set(conversations.flatMap((c) => c.participantIds))];
    if (userIds.length === 0) return;
    realtime.send('/app/presence/subscribe', envelope('PRESENCE_SUB', { userIds }));
  }

  /**
   * Typing is rate-limited to one frame per interval while the user keeps typing, and a single
   * explicit stop. Sending per keystroke would put a frame on the wire for every character.
   */
  sendTyping(conversationId: string, state: 'start' | 'stop' | 'recording'): void {
    const now = Date.now();
    if (state === 'start') {
      const last = this.lastTypingSentAt.get(conversationId) ?? 0;
      if (now - last < TYPING_THROTTLE_MS) return;
      this.lastTypingSentAt.set(conversationId, now);
    } else {
      this.lastTypingSentAt.delete(conversationId);
    }
    realtime.send('/app/typing', envelope('TYPING', { conversationId, state }));
  }

  private async flushOutbox(): Promise<void> {
    if (this.flushing || !this.pipeline || !realtime.connected) return;
    this.flushing = true;

    try {
      const now = Date.now();
      const pending = await db.outbox.toArray();

      for (const item of pending.filter((entry) => !entry.awaitingUpload && entry.nextAttemptAt <= now)) {
        try {
          if (await this.trySealed(item.clientMessageId)) continue;
          const plan = await this.pipeline.buildSendPlan(item.clientMessageId);
          if (!plan) {
            await db.outbox.delete(item.clientMessageId);
            continue;
          }
          const sent = realtime.send(
            '/app/send',
            envelope('SEND', {
              clientMessageId: item.clientMessageId,
              conversationId: item.conversationId,
              payloads: plan.payloads,
              groupCiphertext: plan.groupCiphertext,
              silent: plan.silent,
              editOf: plan.editOf,
              deleteOf: plan.deleteOf,
              mentions: plan.mentions,
            }),
          );
          if (!sent) break; // socket went away mid-flush; the next connect will retry
        } catch (error) {
          const attempts = item.attempts + 1;
          console.warn('[realtime] send attempt %d failed', attempts, error);
          if (attempts >= MAX_SEND_ATTEMPTS) {
            await this.failPermanently(item.clientMessageId);
          } else {
            await db.outbox.update(item.clientMessageId, {
              attempts,
              nextAttemptAt: Date.now() + Math.min(30_000, 500 * 2 ** attempts),
              lastError: String(error),
            });
          }
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Puts a failed message back in the queue, from the retry affordance on the bubble. */
  async retry(clientMessageId: string): Promise<void> {
    const message = await db.messages.get(clientMessageId);
    if (!message) return;
    const needsUpload = !!message.upload && !message.upload.done;
    await db.transaction('rw', db.messages, db.outbox, async () => {
      await db.messages.update(clientMessageId, { state: 'PENDING', seq: PENDING_SEQ });
      await db.outbox.put({
        clientMessageId,
        conversationId: message.conversationId,
        attempts: 0,
        nextAttemptAt: 0,
        awaitingUpload: needsUpload,
      });
    });
    if (needsUpload) {
      this.uploads.run(clientMessageId);
    } else {
      this.flushSoon();
    }
  }

  /** Establishes any missing sessions first, so it needs the network the first time. */
  async safetyNumberWith(userId: string): Promise<string> {
    if (!this.pipeline) throw new Error('Realtime service is not started');
    return this.pipeline.safetyNumberWith(userId);
  }

  async lastSyncAt(): Promise<number | undefined> {
    return getMeta<number>('lastSyncAt');
  }
}

export const realtimeService = new RealtimeService();
