# Low-Level Design — "Chatter"

Status: DRAFT for review · Companion to [HLD.md](./HLD.md) · Date: 2026-09-27

This document is the implementation contract: repository layout, schemas, wire formats, class-level responsibilities and algorithms. Where the HLD says *what*, this says *exactly what to type*.

---

## 1. Repository Layout

```
chatter/
├─ docker-compose.yml                # postgres, redis, redpanda, minio, mailhog
├─ docs/                             # HLD.md, LLD.md, REQUIREMENTS.md, adr/
├─ backend/
│  ├─ pom.xml                        # parent, <packaging>pom</packaging>
│  ├─ mvnw, mvnw.cmd, .mvn/          # Maven wrapper (no system Maven needed)
│  ├─ common/                        # shared: envelope DTOs, error codes, ids, jackson cfg
│  ├─ app/                           # the modular monolith (Spring Boot, port 8080)
│  │  └─ src/main/java/com/chatter/
│  │     ├─ ChatterApplication.java
│  │     ├─ auth/       {api,web,domain,persistence,config}
│  │     ├─ user/       {api,web,domain,persistence}
│  │     ├─ chat/       {api,web,domain,persistence,fanout}
│  │     ├─ media/      {api,web,domain,persistence}
│  │     ├─ presence/   {api,domain,persistence}
│  │     ├─ notification/
│  │     └─ platform/   {security,ratelimit,outbox,observability,error}
│  ├─ ws-gateway/                    # separate Spring Boot app (port 8081)
│  └─ media-worker/                  # separate Spring Boot app (Kafka consumer)
└─ frontend/
   ├─ package.json                   # vite + react 18 + ts
   └─ src/
      ├─ app/            # router, providers, layout shell
      ├─ features/       # auth, chats, messages, groups, media, presence, settings
      ├─ realtime/       # stomp client, envelope codec, reconnect, sync engine
      ├─ db/             # dexie schema, repositories, migrations
      ├─ state/          # zustand stores
      ├─ ui/             # design-system primitives
      └─ lib/            # crypto (P4), format, hooks
```

**Module boundary rule.** `com.chatter.<m>.api` holds interfaces + DTOs and is the *only* package another module may import. Everything else in `<m>` is package-private-by-convention and enforced by an ArchUnit test in `app/src/test/java/com/chatter/ArchitectureTest.java`.

---

## 2. Identifiers

| Entity | Type | Generation |
|---|---|---|
| `user_id` | UUIDv7 | server, at registration |
| `device_id` | UUIDv7 | server, at device registration |
| `conversation_id` | UUIDv7 | server; for 1:1, deterministic from the sorted user pair (see §4.2) so two people cannot create two chats by racing |
| `message_id` | UUIDv7 | server at ingest |
| `client_message_id` | UUIDv7 | **client**, before send — the idempotency key |
| `seq` | bigint | Redis `INCR conv:{id}:seq`, monotonic per conversation |

UUIDv7 everywhere because it is time-ordered: it keeps B-tree indexes from fragmenting the way UUIDv4 does, and it sorts usefully in logs.

---

## 3. Wire Protocol

### 3.1 The envelope

Every realtime frame, in both directions, is one envelope. This is what lets live delivery and catch-up share a code path (HLD §5.2).

```jsonc
{
  "v": 1,
  "type": "MESSAGE",          // see table below
  "id": "01924f...",          // envelope id, for tracing
  "ts": 1790000000123,        // server time, ms
  "payload": { /* type-specific */ }
}
```

| `type` | Direction | Payload |
|---|---|---|
| `CONNECT_OK` | S→C | `{userId, deviceId, serverTime, resumeToken}` |
| `SEND` | C→S | `{clientMessageId, conversationId, contentType, replyToId?, mediaId?, payloads:[{recipientUserId, recipientDeviceId, registrationId, cipherType, ciphertext}]}` — one entry per recipient **device**, see §3.6 |
| `ACK` | S→C | `{clientMessageId, messageId, seq, ts}` |
| `NACK` | S→C | `{clientMessageId, code, message, retryable}` |
| `MESSAGE` | S→C | full message DTO (§3.2) |
| `DELIVERED` | C→S, S→C | `{conversationId, uptoSeq, deviceId}` |
| `READ` | C→S, S→C | `{conversationId, uptoSeq, userId}` |
| `TYPING` | C↔S | `{conversationId, state: "start"\|"stop"}` |
| `PRESENCE` | S→C | `{userId, status, lastSeenAt}` |
| `PRESENCE_SUB` | C→S | `{userIds: []}` — scopes presence fan-out |
| `REACTION` | C↔S | `{messageId, emoji, action: "add"\|"remove"}` |
| `EDIT` | C↔S | `{messageId, body, editedAt}` |
| `DELETE` | C↔S | `{messageId, scope: "me"\|"everyone"}` |
| `SYNC` | C→S | `{cursors: {convId: lastSeq}, limit}` |
| `SYNC_PAGE` | S→C | `{envelopes: [...], hasMore, nextCursor}` |
| `CONV_UPDATE` | S→C | conversation DTO (created, renamed, membership changed) |
| `ERROR` | S→C | `{code, message}` |

Compact frames (`DELIVERED`, `READ`, `TYPING`) carry `uptoSeq`, never arrays of ids. That single choice is the difference between a receipt storm and a quiet socket.

### 3.2 Message DTO (as delivered to one recipient device)

```jsonc
{
  "messageId": "01924f…",
  "clientMessageId": "01924e…",
  "conversationId": "01924a…",
  "senderId": "019240…",
  "senderDeviceId": "019241…",
  "seq": 10427,
  "encoding": "signal/v3",          // the only value in v1
  "cipherType": 3,                  // 3 = PreKeySignalMessage, 1 = SignalMessage, 4 = SenderKey
  "ciphertext": "MwohBc…",          // base64; opaque to the server
  "state": "SENT",                  // sender's view: SENT | DELIVERED | READ
  "createdAt": 1790000000123
}
```

Everything a client renders — text, content type, reply target, media key, reactions — lives **inside** the ciphertext as the decrypted inner payload:

```jsonc
// plaintext only ever seen on the client, after Double Ratchet decryption
{
  "contentType": "text/plain",
  "body": "see you at 8",
  "replyTo": { "messageId": "…", "preview": "earlier text…" },
  "media": { "mediaId": "…", "mime": "image/jpeg", "size": 184322,
             "key": "base64-aes256", "mac": "base64-hmac",
             "width": 1600, "height": 1200, "blurhash": "L6Pj0^…" },
  "sentAt": 1790000000120
}
```

The server sees a conversation id, a sender, a sequence number, a size and a timestamp. That metadata is unavoidable — it is what routing *is* — and we do not pretend otherwise.

### 3.3 STOMP destinations

| Destination | Purpose |
|---|---|
| `/app/send` | client publishes `SEND` |
| `/app/receipt` | client publishes `DELIVERED` / `READ` |
| `/app/typing` | client publishes `TYPING` |
| `/app/sync` | client publishes `SYNC` |
| `/user/queue/events` | server pushes every S→C envelope here (Spring's user destination) |

One inbound queue per concern, one outbound queue total. Clients do not subscribe per conversation — a user in 300 groups would otherwise open 300 subscriptions.

### 3.4 Connection lifecycle

```
CONNECT (Authorization: Bearer <access>)   ── ws-gateway validates JWT
   │                                          registers conn in Redis:
   │                                            SET route:{userId}:{deviceId} = {gatewayId} EX 90
   ▼
CONNECT_OK ──> client sends PRESENCE_SUB + SYNC
   │
   ├─ heartbeat: STOMP heart-beat 30000,30000; gateway refreshes route TTL + presence TTL
   ├─ token expiry: server sends ERROR{code:AUTH_EXPIRED}; client refreshes and re-CONNECTs
   └─ close: gateway DELs the route key, publishes presence.offline after a 15 s grace
```

The 15 s offline grace matters: a page refresh should not make you flicker offline to everyone watching.

### 3.5 Reconnect policy (client)

Exponential backoff `min(30s, 500ms · 2^n)` with full jitter, reset on a successful `CONNECT_OK`. While disconnected, outbound messages queue in IndexedDB with state `PENDING` and are flushed in `seq`-agnostic client order on reconnect; idempotency (DD-5) makes a double flush harmless.

### 3.6 Sending under E2EE

A `SEND` is **one logical message, N ciphertexts** — one per recipient device, including the sender's own other devices so they can render their sent message.

```
1. resolve recipient devices     GET /api/v1/keys/{userId}/devices        (cached, invalidated on key-change)
2. for each device without a session:
       GET /api/v1/keys/{userId}/bundle?deviceId=…   → consumes a one-time prekey
       X3DH  → SessionRecord persisted in Dexie
3. encrypt the inner payload once per session (Double Ratchet)
4. SEND { clientMessageId, conversationId, payloads: [ {recipientDeviceId, cipherType, ciphertext}, … ] }
5. server: one `messages` row (metadata + seq) + N `message_payloads` rows
6. each recipient device is delivered only its own payload
```

**Groups use sender keys, not N×M pairwise encryption.** A sender creates one `SenderKey` per (group, sender), distributes it once to each member device over the pairwise sessions, then encrypts each group message *once*. Cost per message is O(1) instead of O(members); cost on membership change is one redistribution. Without this, a 1024-member group would cost over a thousand ciphertexts per message and the design would collapse.

**Failure handling that matters.** If decryption fails (a ratchet desync, a reinstalled peer), the client shows a "waiting for this message" bubble and sends a `retry` request rather than silently dropping. A message that cannot be decrypted is a visible, recoverable state — never a gap the user has no way to notice.

---

## 4. Data Model

### 4.1 PostgreSQL — identity, social graph, conversations

```sql
-- ── users ────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id              UUID PRIMARY KEY,
  phone_e164      VARCHAR(20)  NOT NULL UNIQUE,
  phone_hash      BYTEA        NOT NULL,            -- peppered, for contact sync
  display_name    VARCHAR(64)  NOT NULL,
  about           VARCHAR(160) DEFAULT 'Hey there! I am using Chatter.',
  avatar_media_id UUID,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_phone_hash ON users (phone_hash);

CREATE TABLE user_privacy (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen       VARCHAR(16) NOT NULL DEFAULT 'everyone',  -- everyone|contacts|nobody
  profile_photo   VARCHAR(16) NOT NULL DEFAULT 'everyone',
  about_visibility VARCHAR(16) NOT NULL DEFAULT 'everyone',
  read_receipts   BOOLEAN     NOT NULL DEFAULT true,
  groups_policy   VARCHAR(16) NOT NULL DEFAULT 'everyone'
);

-- ── devices & sessions ───────────────────────────────────────────────────
CREATE TABLE devices (
  id            UUID PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          VARCHAR(64),            -- "Chrome on Windows"
  platform      VARCHAR(32),
  is_primary    BOOLEAN NOT NULL DEFAULT false,
  identity_key  BYTEA,                  -- P4
  registration_id INT,                  -- P4
  last_active_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_devices_user ON devices (user_id);

CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY,
  device_id   UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  family_id   UUID NOT NULL,            -- rotation family; reuse => revoke family
  token_hash  BYTEA NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  UNIQUE (token_hash)
);

-- ── social graph ─────────────────────────────────────────────────────────
CREATE TABLE contacts (
  owner_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias       VARCHAR(64),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, contact_id)
);

CREATE TABLE blocks (
  blocker_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);

-- ── conversations ────────────────────────────────────────────────────────
CREATE TABLE conversations (
  id             UUID PRIMARY KEY,
  type           VARCHAR(8) NOT NULL,          -- DIRECT | GROUP
  subject        VARCHAR(100),                 -- group only
  description    VARCHAR(512),
  avatar_media_id UUID,
  created_by     UUID REFERENCES users(id),
  pair_key       VARCHAR(73) UNIQUE,           -- DIRECT only: "minUuid:maxUuid"
  last_seq       BIGINT NOT NULL DEFAULT 0,    -- reconciled from Redis
  last_message_at TIMESTAMPTZ,
  settings       JSONB NOT NULL DEFAULT '{"onlyAdminsCanPost":false,"onlyAdminsCanEditInfo":true}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_conv_last_msg ON conversations (last_message_at DESC);

CREATE TABLE conversation_members (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            VARCHAR(8) NOT NULL DEFAULT 'MEMBER',   -- OWNER | ADMIN | MEMBER
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at         TIMESTAMPTZ,
  muted_until     TIMESTAMPTZ,
  pinned          BOOLEAN NOT NULL DEFAULT false,
  archived        BOOLEAN NOT NULL DEFAULT false,
  last_read_seq   BIGINT NOT NULL DEFAULT 0,
  unread_count    INT    NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX idx_member_user ON conversation_members (user_id) WHERE left_at IS NULL;

CREATE TABLE group_invites (
  code            VARCHAR(24) PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_by      UUID NOT NULL,
  expires_at      TIMESTAMPTZ,
  revoked         BOOLEAN NOT NULL DEFAULT false
);

-- ── media ────────────────────────────────────────────────────────────────
CREATE TABLE media (
  id            UUID PRIMARY KEY,
  owner_id      UUID NOT NULL REFERENCES users(id),
  bucket        VARCHAR(64) NOT NULL,
  object_key    VARCHAR(256) NOT NULL,
  mime_type     VARCHAR(128) NOT NULL,
  size_bytes    BIGINT NOT NULL,
  width         INT, height INT, duration_ms INT,
  thumbnail_key VARCHAR(256),
  blurhash      VARCHAR(64),
  state         VARCHAR(16) NOT NULL,      -- PENDING | UPLOADED | PROCESSED | FAILED
  sha256        BYTEA,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Signal key material (public halves only — D-1) ───────────────────────
CREATE TABLE signed_prekeys (
  device_id   UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  key_id      INT  NOT NULL,
  public_key  BYTEA NOT NULL,
  signature   BYTEA NOT NULL,          -- signed by the device identity key
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, key_id)
);

CREATE TABLE one_time_prekeys (
  device_id   UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  key_id      INT  NOT NULL,
  public_key  BYTEA NOT NULL,
  consumed_at TIMESTAMPTZ,
  PRIMARY KEY (device_id, key_id)
);
-- the index that makes bundle fetch a single cheap lookup
CREATE INDEX idx_otpk_available ON one_time_prekeys (device_id, key_id) WHERE consumed_at IS NULL;

-- ── transactional outbox (DD-6) ──────────────────────────────────────────
CREATE TABLE outbox (
  id            BIGSERIAL PRIMARY KEY,
  aggregate_id  UUID NOT NULL,
  topic         VARCHAR(64) NOT NULL,
  partition_key VARCHAR(64) NOT NULL,
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ
);
CREATE INDEX idx_outbox_unpublished ON outbox (id) WHERE published_at IS NULL;

-- ── push subscriptions ───────────────────────────────────────────────────
CREATE TABLE push_subscriptions (
  id         UUID PRIMARY KEY,
  device_id  UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (endpoint)
);
```

### 4.2 Deterministic DIRECT conversation id

```java
// pair_key = min(uuid).toString() + ":" + max(uuid).toString()
// conversationId = UUID.nameUUIDFromBytes(pairKey.getBytes(UTF_8))  // v3, deterministic
```
Combined with the `UNIQUE (pair_key)` constraint and an `INSERT … ON CONFLICT DO NOTHING`, two clients racing to open the same chat converge on one conversation instead of two. This is the kind of bug that only shows up in production, so we design it away.

### 4.3 Messages — Postgres (P1) then Cassandra (P3+)

**Phase 1 — Postgres, partitioned by month:**

```sql
-- metadata only: the server cannot read content (D-1)
CREATE TABLE messages (
  conversation_id   UUID        NOT NULL,
  seq               BIGINT      NOT NULL,
  id                UUID        NOT NULL,
  client_message_id UUID        NOT NULL,
  sender_id         UUID        NOT NULL,
  sender_device_id  UUID        NOT NULL,
  encoding          VARCHAR(16) NOT NULL DEFAULT 'signal/v3',
  edited_at         TIMESTAMPTZ,
  deleted_for_all   BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, seq, created_at)
) PARTITION BY RANGE (created_at);

CREATE UNIQUE INDEX uq_msg_idem ON messages (sender_device_id, client_message_id);
CREATE INDEX idx_msg_id ON messages (id);

-- one opaque ciphertext per recipient device (§3.6)
CREATE TABLE message_payloads (
  message_id          UUID     NOT NULL,
  recipient_device_id UUID     NOT NULL,
  recipient_user_id   UUID     NOT NULL,
  cipher_type         SMALLINT NOT NULL,   -- 1 signal, 3 prekey, 4 senderkey
  ciphertext          BYTEA    NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, recipient_device_id)
);
CREATE INDEX idx_payload_device ON message_payloads (recipient_device_id, created_at);

CREATE TABLE message_reactions (
  message_id UUID NOT NULL, user_id UUID NOT NULL, emoji VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)          -- one reaction per user per message
);

CREATE TABLE message_deletions (              -- delete-for-me
  message_id UUID NOT NULL, user_id UUID NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE inbox (                          -- per-recipient pointer (DD-4)
  user_id         UUID   NOT NULL,
  conversation_id UUID   NOT NULL,
  seq             BIGINT NOT NULL,
  state           SMALLINT NOT NULL,          -- 0 undelivered, 1 delivered, 2 read
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, conversation_id, seq)
);
CREATE INDEX idx_inbox_undelivered ON inbox (user_id) WHERE state = 0;
```

**Phase 3 — Cassandra equivalent:**

```cql
CREATE TABLE messages (
  conversation_id uuid, bucket text, seq bigint,
  id uuid, client_message_id uuid, sender_id uuid, sender_device_id uuid,
  content_type text, encoding text, body text, media_id uuid, reply_to_id uuid,
  edited_at timestamp, deleted_for_all boolean, created_at timestamp,
  PRIMARY KEY ((conversation_id, bucket), seq)
) WITH CLUSTERING ORDER BY (seq DESC)
  AND compaction = {'class':'TimeWindowCompactionStrategy','compaction_window_unit':'DAYS',
                    'compaction_window_size':7};
```

Both sit behind one interface:

```java
public interface MessageStore {
    StoredMessage append(NewMessage m);                       // throws DuplicateMessageException
    Optional<StoredMessage> findByClientId(UUID deviceId, UUID clientMessageId);
    List<StoredMessage> readBackward(UUID convId, long beforeSeq, int limit);
    List<StoredMessage> readForward(UUID convId, long afterSeq, int limit);
    void markDeletedForAll(UUID messageId);
    void applyEdit(UUID messageId, String body, Instant editedAt);
}
```

### 4.4 Redis keyspace

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `conv:{id}:seq` | string (counter) | — | monotonic sequence, `INCR` |
| `route:{userId}:{deviceId}` | string = gatewayId | 90 s | which gateway holds the socket |
| `presence:{userId}` | hash | 40 s | status, lastSeenAt, deviceCount |
| `typing:{convId}` | set of userId | 5 s | typing indicators |
| `idem:{deviceId}:{clientMsgId}` | string = messageId | 24 h | idempotency guard |
| `members:{convId}` | set | 10 min | member cache for fan-out |
| `unread:{userId}` | hash convId→count | — | badge counts, write-through to Postgres |
| `rl:{scope}:{id}` | Bucket4j | varies | rate limiting |
| pub/sub `gw:{gatewayId}` | channel | — | deliver-to-this-gateway |

### 4.5 Kafka topics

| Topic | Key | Partitions | Consumer |
|---|---|---|---|
| `message.created` | conversationId | 32 | fan-out worker |
| `message.delivered` | conversationId | 16 | chat-service (receipt propagation) |
| `media.uploaded` | mediaId | 8 | media-worker |
| `media.processed` | mediaId | 8 | chat-service |
| `push.notify` | conversationId | 16 | notification-service (published by fan-out for offline devices; ids only) |
| `sealed.created` | recipient userId | 8 | sealed fan-out (sealed sender: no conversation to key on) |
| `<topic>.DLT` | same as source | same as source | none — parked records for inspection / replay |
| `conversation.updated` | conversationId | 8 | fan-out worker |

Keying by `conversationId` is what preserves per-conversation ordering through the bus — the same invariant DD-2 establishes in the database.

**Failure handling.** One shared `DefaultErrorHandler` serves every listener: 3 blocking retries with exponential backoff (0.5 s → 1 s → 2 s), then the record goes to `<topic>.DLT` on the **same partition**, with the exception and original offset in its headers. Parse failures skip the retries. Retries block the partition on purpose, because skipping ahead would reorder a conversation. Dead-lettering `message.created` loses nothing: the message is already in Postgres and the inbox, so devices get it on their next SYNC. Counter: `chatter.kafka.dead_lettered{topic}`.

---

## 5. Backend Class Design

### 5.1 chat module — the ingest path

```java
// com.chatter.chat.api  (the only package other modules see)
public interface MessageService {
    SendResult send(SendCommand cmd);
    void markDelivered(UUID userId, UUID deviceId, UUID convId, long uptoSeq);
    void markRead(UUID userId, UUID convId, long uptoSeq);
    Page<MessageDto> history(UUID userId, UUID convId, Long beforeSeq, int limit);
    SyncResult sync(UUID userId, UUID deviceId, Map<UUID, Long> cursors, int limit);
}

public record SendCommand(UUID senderId, UUID senderDeviceId, UUID clientMessageId,
                          UUID conversationId, String contentType, String encoding,
                          String body, UUID mediaId, UUID replyToId) {}
```

```java
// com.chatter.chat.domain
@Service
class MessageServiceImpl implements MessageService {

    @Transactional
    public SendResult send(SendCommand cmd) {
        // 1. authorize: member of conversation, not blocked, group posting policy
        membershipGuard.assertCanPost(cmd.senderId(), cmd.conversationId());

        // 2. idempotency — fast path in Redis, durable path on the unique index
        var cached = idempotency.get(cmd.senderDeviceId(), cmd.clientMessageId());
        if (cached.isPresent()) return SendResult.duplicate(cached.get());

        // 3. sequence
        long seq = sequencer.next(cmd.conversationId());

        // 4. persist message + outbox event in ONE transaction (DD-6)
        var stored = messageStore.append(NewMessage.from(cmd, seq));
        outbox.enqueue("message.created", cmd.conversationId(), MessageCreated.from(stored));

        // 5. inbox pointers + unread counters, batched
        inboxWriter.fanOut(stored, memberCache.members(cmd.conversationId()));

        idempotency.put(cmd.senderDeviceId(), cmd.clientMessageId(), stored.id());
        return SendResult.created(stored);
    }
}
```

Note what is *not* here: no direct call into the gateway. Delivery is triggered by the outbox relay consuming `message.created`, so a delivery failure can never roll back a persisted message, and a persisted message can never fail to be delivered eventually.

**Sequencer with a safe fallback (HLD failure table):**

```java
@Component
class ConversationSequencer {
    long next(UUID convId) {
        try {
            Long v = redis.opsForValue().increment("conv:" + convId + ":seq");
            if (v != null && v > 0) return v;
        } catch (RedisConnectionFailureException e) {
            metrics.counter("sequencer.redis.fallback").increment();
        }
        return jdbc.queryForObject(                       // pessimistic, slow, correct
            "UPDATE conversations SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq",
            Long.class, convId);
    }
}
```
On Redis cold start the counter is seeded from `conversations.last_seq`, and a scheduled job reconciles the column every 10 s so the fallback never hands out a seq that is already used.

### 5.2 Fan-out worker

```java
@KafkaListener(topics = "message.created", concurrency = "8")
void onMessageCreated(MessageCreated evt) {
    var members = memberCache.members(evt.conversationId());      // Redis set
    var envelope = EnvelopeFactory.message(evt);

    for (var batch : Lists.partition(members, 100)) {
        var routes = routeRegistry.lookupAll(batch);              // Redis MGET
        routes.online().groupBy(Route::gatewayId)
              .forEach((gw, targets) -> redis.convertAndSend("gw:" + gw,
                                          new GatewayPush(targets, envelope)));
        routes.offline().forEach(userId ->
              kafka.send("push.notify", userId.toString(), PushIntent.from(evt, userId)));
    }
}
```

### 5.3 ws-gateway

```java
@Component
class SocketRegistry {                       // in-memory, per node
    private final Map<UUID, Set<WebSocketSession>> byUser = new ConcurrentHashMap<>();
    void register(UUID userId, UUID deviceId, WebSocketSession s) { … }
    void deliver(UUID userId, Envelope e) { … }   // fan to all this user's sockets here
}

@Component
class GatewayPushListener implements MessageListener {   // Redis pub/sub on gw:{myId}
    public void onMessage(Message m, byte[] p) {
        GatewayPush push = codec.decode(m.getBody());
        push.targets().forEach(t -> registry.deliver(t.userId(), push.envelope()));
    }
}
```

Backpressure: if a session's outbound buffer exceeds 512 KB the gateway closes it with `1013 TRY_AGAIN_LATER` rather than accumulating heap. The client reconnects and `SYNC`s — cheaper than an OOM that takes 80 000 other sockets with it.

### 5.4 REST surface (everything that is not a live frame)

```
POST   /api/v1/auth/register            {phone}                      → {otpToken, expiresIn}
POST   /api/v1/auth/verify              {otpToken, code, deviceName} → {access, refresh, user}
POST   /api/v1/auth/refresh             {refresh}                    → {access, refresh}
POST   /api/v1/auth/logout              {refresh}                    → 204
GET    /api/v1/auth/devices                                          → [DeviceDto]
DELETE /api/v1/auth/devices/{id}                                     → 204
POST   /api/v1/auth/link/start                                       → {linkCode, qrPayload}   (P1)
POST   /api/v1/auth/link/complete       {linkCode}                   → {access, refresh}

GET    /api/v1/me                                                    → UserDto
PATCH  /api/v1/me                       {displayName?, about?, avatarMediaId?}
PUT    /api/v1/me/privacy               PrivacyDto
POST   /api/v1/contacts/sync            {phoneHashes:[…]}            → [UserDto]
GET    /api/v1/contacts                                              → [ContactDto]
POST   /api/v1/blocks/{userId}                                       → 204
DELETE /api/v1/blocks/{userId}                                       → 204

GET    /api/v1/conversations            ?cursor=&limit=              → Page<ConversationDto>
POST   /api/v1/conversations            {type, participantIds, subject?}
GET    /api/v1/conversations/{id}
PATCH  /api/v1/conversations/{id}       {subject?, description?, avatarMediaId?, settings?}
GET    /api/v1/conversations/{id}/messages ?beforeSeq=&limit=        → Page<MessageDto>
POST   /api/v1/conversations/{id}/members      {userIds:[…]}
DELETE /api/v1/conversations/{id}/members/{userId}
PUT    /api/v1/conversations/{id}/members/{userId}/role  {role}
POST   /api/v1/conversations/{id}/leave
POST   /api/v1/conversations/{id}/mute  {until}
POST   /api/v1/conversations/{id}/invite                             → {code, url}
POST   /api/v1/invites/{code}/join                                   → ConversationDto

POST   /api/v1/media/tickets            {mime, size, sha256}         → {mediaId, parts:[{url,partNo}]}
POST   /api/v1/media/{id}/complete      {parts:[{partNo, etag}]}     → MediaDto
GET    /api/v1/media/{id}/url                                        → {url, expiresAt}

POST   /api/v1/push/subscriptions       {endpoint, keys}             → 201
GET    /api/v1/keys/{userId}/bundle                                  → PreKeyBundle   (P4)
POST   /api/v1/keys                     {identityKey, signedPreKey, oneTimeKeys}  (P4)
```

History is a REST call because it is a paged, cacheable, non-urgent read; live traffic is a frame. Mixing the two is how protocols become unteachable.

### 5.5 Error model

One shape for every REST error and every `NACK`/`ERROR` frame:

```json
{ "code": "CONVERSATION_FORBIDDEN", "message": "Not a member of this conversation",
  "traceId": "4bf92f35…", "retryable": false }
```

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `AUTH_REQUIRED` / `AUTH_EXPIRED` | 401 | after refresh |
| `CONVERSATION_FORBIDDEN` | 403 | no |
| `USER_BLOCKED` | 403 | no |
| `NOT_FOUND` | 404 | no |
| `DUPLICATE_MESSAGE` | 200 + original | n/a — returns the first result |
| `RATE_LIMITED` | 429 + `Retry-After` | yes |
| `STORE_UNAVAILABLE` | 503 | yes |

`DUPLICATE_MESSAGE` returning the original result rather than an error is the whole point of DD-5: the client's retry must be indistinguishable from success.

---

## 6. Frontend Design

### 6.1 Local database (Dexie)

```ts
db.version(1).stores({
  conversations: 'id, lastMessageAt, type, *memberIds, pinned, archived',
  messages:      '[conversationId+seq], id, clientMessageId, conversationId, state, createdAt',
  outbox:        'clientMessageId, conversationId, attempts, nextAttemptAt',
  users:         'id, phoneE164, displayName',
  media:         'mediaId, state',
  meta:          'key'            // syncCursors, selfUserId, lastSyncAt
});
```

The message list renders from Dexie, never from a network response. A network response *writes to Dexie*, and the view reacts. This inversion is what makes the app work offline without a second code path.

### 6.2 Optimistic send

```ts
async function sendText(conversationId: string, body: string) {
  const clientMessageId = uuidv7();
  const optimistic: Message = {
    clientMessageId, conversationId, body, senderId: me.id,
    seq: Number.MAX_SAFE_INTEGER,        // sorts last until the ACK assigns a real seq
    state: 'PENDING', createdAt: Date.now(),
  };
  await db.messages.put(optimistic);      // UI updates here, before any I/O
  await db.outbox.put({ clientMessageId, conversationId, attempts: 0 });
  realtime.send({ type: 'SEND', payload: { clientMessageId, conversationId, body } });
}

// on ACK
async function onAck({ clientMessageId, messageId, seq, ts }) {
  await db.transaction('rw', db.messages, db.outbox, async () => {
    await db.messages.where({ clientMessageId }).modify(
      { id: messageId, seq, createdAt: ts, state: 'SENT' });
    await db.outbox.delete(clientMessageId);
  });
}
```

`MAX_SAFE_INTEGER` as the provisional seq keeps a pending bubble pinned to the bottom of the list, then it snaps into place on ACK — exactly the behaviour WhatsApp has, and it falls out of the sort rather than needing special-case rendering.

### 6.3 Realtime layer

```
realtime/
├─ StompConnection.ts     # connect, heartbeat, backoff+jitter, token refresh on AUTH_EXPIRED
├─ EnvelopeCodec.ts       # encode/decode + version negotiation
├─ SyncEngine.ts          # cursor map from Dexie, paged SYNC drain, gap detection
├─ OutboxFlusher.ts       # retries pending sends; exponential, capped, resumes on 'online'
└─ handlers/              # one handler per envelope type, each writing to Dexie
```

`SyncEngine` gap detection: if an incoming `MESSAGE` has `seq > localLastSeq + 1`, the client has missed frames — it requests a targeted backfill for that conversation instead of trusting the stream. Cheap insurance against a dropped frame silently tearing history.

### 6.4 Component tree

```
<AppShell>
  <Sidebar>
    <ProfileHeader/> <SearchBar/> <ChatFilters/>
    <ChatList>  <ChatListItem/> × n     // avatar, name, last msg, time, unread badge, ticks
  </Sidebar>
  <ChatPane>
    <ChatHeader/>            // name, presence/typing, group members, actions
    <MessageList>            // react-virtuoso, reverse infinite scroll, day separators
      <DateDivider/> <MessageBubble/> <UnreadDivider/>
    </MessageList>
    <Composer/>              // text, emoji, attach, voice record, reply preview
  </ChatPane>
  <DetailDrawer/>            // contact/group info, media grid, members, mute
</AppShell>
```

`MessageList` uses `react-virtuoso` in reverse mode. A naive `.map()` over 50 000 messages is not a rendering choice, it is a crash.

### 6.5 State ownership

| Concern | Owner |
|---|---|
| Server data cached for reads (profiles, group info) | TanStack Query |
| Messages and conversations | Dexie + `useLiveQuery` (reactive, not in a store) |
| UI state (active chat, drawer, reply target, composer draft) | Zustand |
| Connection status, presence map, typing map | Zustand, fed by the realtime layer |

Messages deliberately do not live in Zustand: they are unbounded and persistent, which is a database's job, not a store's.

---

## 6A. Cryptography (D-1: Signal from day one)

### 6A.1 Division of labour

| Concern | Where | Why |
|---|---|---|
| Key generation, X3DH, Double Ratchet, sender keys | **Client only** | The server must never hold a private key, or the property we are paying for does not exist |
| Public bundle storage, one-time-prekey vending | Server | The only thing a server can safely do |
| Ciphertext routing and retention | Server | Opaque bytes |
| Safety numbers, verification, key-change alerts | Client | Verification the server can forge is not verification |

### 6A.2 Client library and its boundary

```ts
// lib/crypto/CryptoProvider.ts — everything crypto goes through this
export interface CryptoProvider {
  generateIdentity(): Promise<IdentityBundle>;
  generatePreKeys(start: number, count: number): Promise<PreKeyRecord[]>;
  rotateSignedPreKey(): Promise<SignedPreKeyRecord>;
  hasSession(addr: ProtocolAddress): Promise<boolean>;
  processPreKeyBundle(addr: ProtocolAddress, b: PreKeyBundle): Promise<void>;
  encrypt(addr: ProtocolAddress, plaintext: Uint8Array): Promise<{type: number; body: Uint8Array}>;
  decrypt(addr: ProtocolAddress, type: number, body: Uint8Array): Promise<Uint8Array>;
  safetyNumber(localId: PublicKey, remoteId: PublicKey): Promise<string>;
}
```

Implemented by `LibsignalTsProvider` over `@privacyresearch/libsignal-protocol-typescript`. That package is a community TypeScript port of Signal's protocol — correct in construction, but without Signal's audit lineage. The interface exists so it can be replaced by a self-built `libsignal` WASM bundle without touching a single call site. **This is the weakest link in the security story and it is deliberate, visible, and swappable.**

### 6A.3 The Dexie-backed protocol store

Signal's `SignalProtocolStore` is a key-value contract; we implement it over Dexie so sessions survive a refresh:

```
signalIdentity   : 'id'                      // our identity keypair + registrationId
signalPreKeys    : 'keyId'                   // one-time prekey private halves
signalSignedKeys : 'keyId'
signalSessions   : 'address'                 // "userId.deviceId" → serialized SessionRecord
signalIdentities : 'address'                 // remote identity keys, for change detection
signalSenderKeys : '[groupId+senderAddress]'
```

Records are stored wrapped: a per-install non-extractable AES-GCM `CryptoKey` (generated via WebCrypto, itself stored as a non-exportable `CryptoKey` in IndexedDB) encrypts every value. It stops a casual IndexedDB dump; it does not stop a compromised browser, and the registration screen says so.

### 6A.4 Registration sequence

```
verify OTP ──> server returns {userId, deviceId, access, refresh}
    │
    ├─ client: generateIdentity()           → identityKeyPair, registrationId
    ├─ client: rotateSignedPreKey()         → signedPreKey + signature
    ├─ client: generatePreKeys(1, 100)      → 100 one-time prekeys
    │
    └─ POST /api/v1/keys { identityKey, registrationId, signedPreKey, oneTimePreKeys[] }
             (public halves only; privates never leave the browser)
```

A background check on every connect calls `GET /api/v1/keys/count`; below 20 remaining it uploads another 100. Running out of one-time prekeys is not fatal — X3DH degrades to the signed prekey alone, losing forward secrecy for that one initial message — but it should be rare, so we monitor it.

### 6A.5 Key-change detection

`signalIdentities` holds the remote identity key we last trusted. When a `PreKeySignalMessage` arrives bearing a different identity key for a known address, the client:
1. accepts the message (refusing would let anyone DoS a conversation by reinstalling),
2. inserts a `security_code_changed` system bubble into the timeline,
3. clears the `verified` flag for that contact.

This is exactly WhatsApp's behaviour, and it is the difference between E2EE that is auditable and E2EE that is a marketing line.

**As built (step 10).** Device ids are minted per login, so a reinstall arrives as a *new device with a new key*, not a changed key on a known address. Trust is therefore tracked per **account** in a `contactTrust` Dexie table (`userId → knownKeys[], verified`), not per address:

- The send path already visits every device of every member, so it records the account's full key set. The first sighting is trust-on-first-use; any key not seen before later clears `verified` and inserts a `system/identity-changed` notice (fractional `seq = lastSeq + 0.5`, never sent) into every conversation with that person. A key merely disappearing (logout) is silent.
- A successful decrypt can add a key but never sets the baseline, so a two-device contact who messages first is not mistaken for a key change.
- The safety number hashes the sorted concatenation of all device identity keys on each side, using the keys the sessions are bound to rather than the server's listing. `isTrustedIdentity` always returns true: libsignal throws on false, which would turn a key change into undecryptable messages.

### 6A.6 Sealed sender (as built)

**Server** (`sealed` module, migration V7):

| Piece | Detail |
|---|---|
| `unidentified_access` | `user_id → access_key` (16 bytes). One per **account**, not per device: every linked device reads it (`GET /sealed/access-key`), or they would each share a different key and invalidate one another. Rotated with `PUT`. |
| `sealed_messages` | `id, recipient_user_id, recipient_device_id, ciphertext, created_at, expires_at` (30 days). No sender, no conversation. Deleted on ack. |
| Sender certificate | `GET /sealed/certificate`: JSON `{userId, deviceId, identityKey, expires}` signed with ECDSA P-256 (`SHA256withECDSAinP1363Format`, i.e. raw r‖s, which WebCrypto verifies natively). Separate key from the JWT key; dev key in `~/.chatter/dev-sender-cert-key.pem`. Trust root public at `GET /sealed/trust-root`. |
| `POST /sealed/deliver/{userId}` | **Public.** Header `Unidentified-Access-Key`, constant-time compare; a wrong key and an unknown user get the same 401 `UNIDENTIFIED_ACCESS_DENIED`. Targets must be exactly the recipient's keyed devices, else 409 `DEVICES_CHANGED`. Limits: per source IP and per recipient (there is no sender to key on). |
| `POST /sealed/self` | Authenticated copy to the sender's own other devices; the server knows who you are when you talk to yourself, and needs to, to leave the sending device out of the required set. |
| `GET /sealed/messages`, `POST /sealed/messages/ack` | Catch-up and deletion, scoped to the calling device. |
| Delivery | Rows + outbox event in one transaction → `sealed.created` (keyed by **recipient**) → `chatter-sealed-fanout` → `SEALED` frame to online devices, and a `push.notify` job with null sender and conversation for the rest ("New message"). DLT: `sealed.created.DLT`. |

**Envelope** (per recipient device, base64 of JSON):
```
e  = ephemeral X25519 public key (libsignal 33-byte form)
k  = HKDF-SHA256(ECDH(e, recipientIdentity), salt = e ‖ recipientIdentity, info = "ChatterSealedSender v1")
c  = AES-256-GCM_k(iv, aad = e, { certificate, signature, type, body })   // body = Signal ciphertext
```

**Receive checks, in order:** open the envelope with our identity key → verify the certificate against the pinned trust root (build-time `VITE_SEALED_TRUST_ROOT`, else trust on first use) → expiry against the *server's* delivery time → drop if the sender is blocked → Signal-decrypt with the certificate's device session → require `session identity key == certificate identity key` → require the inner `conversationId` to be a DIRECT chat the sender is in. A decrypt failure after a valid unseal still yields the usual "Waiting for this message" placeholder, since the sender is known.

**Client rules.** A message goes sealed when the chat is DIRECT, it has no attachment, and we hold the peer's access key (learned from any message they send us, where it rides inside the encryption). Otherwise, or on 401, it goes identified, which is still end-to-end encrypted. Sealed rows get `messageId = clientMessageId` and `seq = lastSeq + 0.5`, like other unsequenced rows, and a client-computed disappearing expiry. Receipts for sealed messages are sealed `receipt` controls listing message ids; `READ` obeys the read-receipts setting, which is reciprocal.

**Known limits.** Typing indicators and presence still name the conversation. Message info has no server data for sealed messages. Edit/delete time windows are enforced by clients only on this path. The notification for a sealed message cannot name the chat, and mute cannot apply to it while the page is closed.

---

## 7. Security Detail

- **Passwords:** none. Phone + OTP only. OTP is 6 digits, Argon2-hashed in Redis, 5-minute TTL, 5 attempts, then the token is burned.
- **JWT:** RS256, 15-minute access. Claims: `sub` (userId), `did` (deviceId), `jti`, `exp`. Public key exposed at `/.well-known/jwks.json` so ws-gateway validates locally without calling auth.
- **Refresh rotation:** every refresh issues a new token and revokes the old one. Presenting a revoked token revokes the entire family — that is how a stolen token becomes a detected intrusion instead of a permanent one.
- **Authorization:** one `@PreAuthorize`-backed `MembershipGuard` consulted on every conversation-scoped operation, REST and WS alike. There is exactly one place to get this wrong, which means exactly one place to get it right.
- **Transport:** TLS 1.3, HSTS, strict CSP, `Secure`+`HttpOnly`+`SameSite=Strict` refresh cookie.
- **Input:** Bean Validation on every DTO; message body capped at 65 536 chars; media at 100 MB; HTML never rendered from message content (React escapes by default and we do not reach for `dangerouslySetInnerHTML`).
- **Rate limits (Bucket4j + Redis):** 30 msg/s per device, 5 OTP/hour per phone, 3 OTP/hour per IP, 100 media tickets/hour, 20 group creates/day.

---

## 8. Testing Strategy

| Level | Tool | What it proves |
|---|---|---|
| Unit | JUnit 5 + AssertJ + Mockito | Sequencer fallback, idempotency, membership rules, receipt coalescing |
| Slice | `@DataJpaTest`, `@WebMvcTest` | Schema and controller contracts |
| Integration | Testcontainers (Postgres, Redis, Redpanda, MinIO) | The real ingest path end to end, outbox relay, fan-out |
| Realtime | Custom `StompTestClient` | Two clients, one message, both tick transitions; reconnect + SYNC recovers a forced gap |
| Architecture | ArchUnit | No cross-module imports outside `*.api` |
| Frontend unit | Vitest + Testing Library | Optimistic send, ACK reconciliation, Dexie repositories |
| E2E | Playwright, two browser contexts | Real two-user conversation: send, deliver, read, typing, offline queue, reconnect |
| Load | k6 + a WS scenario | 10 K concurrent sockets, 1 K msg/s, p99 under 300 ms |

The single most valuable test in this list is the Playwright two-context one. It is the only one that can catch a tick that never turns blue.

---

## 9. Implementation Order

Revised for the confirmed decisions: **E2EE is day one**, so key management and the crypto client land inside the walking skeleton rather than at the end.

| # | Deliverable | Depends on |
|---|---|---|
| **1** | Compose stack (Postgres, Redis, Redpanda, MinIO, Mailhog), parent POM + wrapper, Flyway baseline, Vite app skeleton | — |
| **2** | auth: OTP register/verify, JWT + rotating refresh, device registration | 1 |
| **3** | keys: prekey bundle upload, bundle vend with one-time-prekey consumption, count/top-up | 2 |
| **4** | ws-gateway: authenticated STOMP connect, heartbeat, `CONNECT_OK`, Redis route registry | 2 |
| **5** | chat: DIRECT conversation, `SEND` with per-device payloads → ACK, outbox → Kafka → fan-out → Redis → gateway → `MESSAGE`; one/two ticks | 3, 4 |
| **6** | client crypto: `CryptoProvider`, Dexie protocol store, registration key generation, session setup, encrypt/decrypt | 3 |
| **7** | client data: Dexie schema, optimistic send, outbox flusher, reconnect + `SYNC`, gap detection | 5, 6 |
| **8** | UI: login, chat list, virtualised message list, composer, tick states, connection banner | 7 |
| 9 | Read receipts, unread counts, presence, typing | 8 |
| 10 | Safety numbers, verification screen, key-change system messages | 8 |
| 11 | Groups + sender keys, roles, system messages, invite links | 9, 10 |
| 12 | Reply, react, forward, star, edit, delete (both scopes) | 11 |
| 13 | Media: tickets, direct upload, client-side AES encryption, worker, bubbles | 8 |
| 14 | Voice notes (MediaRecorder → Opus), waveform, playback | 13 |
| 15 | Web Push + service worker, mute | 9 |
| 16 | Multi-device linking (QR), per-device cursors, self-echo | 10 |
| 17 | Observability, rate limits, k6 load run, hardening | 9 |

**Step 13 as built (media under E2EE).** The pre-E2EE media-worker (thumbnails, transcoding) cannot exist: the server only ever holds ciphertext. Instead the client downscales images to 1600 px, extracts a poster frame, dimensions and duration, and embeds a ~64 px JPEG thumbnail in the encrypted message body. Blobs are AES-256-CBC + HMAC-SHA256 (IV ‖ ct ‖ MAC), keyed per file; the key, digest, mime, name and dimensions travel only inside the Signal/sender-key payload. The IV is stored with the pending message, so re-encrypting after a reload yields identical bytes and a multipart upload resumes from the parts already in the bucket. Access: `POST /media/{id}/share` links a blob to a conversation; `GET /media/{id}/url` requires ownership or active membership in a linked conversation. Server-side, `media` stores only owner, size and state.

**Step 12 as built (message actions under E2EE).** Reactions, edits and deletes are ordinary encrypted messages whose inner payload carries `kind` + `targetId`; they are sequenced, synced and delivered to every device, then applied to the target rather than rendered. Three plaintext hints ride on `SEND`: `silent` (no unread bump, no push), and `editOf` / `deleteOf` naming the target so the server can enforce authorship and the 15-minute / 2-hour windows, set `edited_at` / `deleted_for_all`, and purge a deleted message's ciphertext so devices that have not fetched it never will. Cost: the server learns that an edit or delete of message X happened, never the content. Clients re-check authorship before applying. Outgoing controls are hidden outbox rows carrying the target's previous state, reverted if the server refuses them. Replies embed a snapshot quote; forwards re-share the media blob into the target chat instead of re-uploading; stars and delete-for-me are per device.

**Step 17 as built (hardening).**
- *Rate limits*: Redis token buckets via one Lua script (atomic, Redis clock), fail-open, limits collected in `platform/ratelimit/Limits.java`: OTP 5/h per phone and 20/h per IP (LLD's 3/IP raised for carrier-grade NAT), verify, refresh, link start/claim/approve, contact sync, prekey bundle fetches (a drain-the-victim's-prekeys defence), media uploads, group creation, invite lookups, push subscriptions, and 30 msg/s per device with a burst of 100. 429 carries `Retry-After`; over the socket it becomes a retryable NACK.
- *Instant revocation*: revoking a device or deleting an account writes `revoked-device:{id}` (TTL > access-token lifetime). The REST chain rejects such tokens after bearer auth; the gateway checks on CONNECT and on every inbound frame (5 s local cache).
- *Socket token expiry*: the gateway now refuses frames from a socket whose token expired (60 s grace) with `AUTH_EXPIRED`; the client reconnects through a token provider that refreshes first.
- *Drain on deploy*: gateway `SmartLifecycle` at the highest phase marks itself not-ready, refuses CONNECT with `GATEWAY_DRAINING`, and closes sockets in batches over 30 s with 1012.
- *Observability*: Prometheus on management ports (app 18080, gateway 18081; `/livez` `/readyz` stay on the main ports). Custom meters: `chatter.gateway.sockets`, `chatter.delivery.latency` (ingest→socket, histogram), `chatter.fanout.lag`, `chatter.outbox.backlog`, `chatter.inbox.undelivered`, `chatter.messages.ingested{kind}`, `chatter.sequencer.fallback`, `chatter.ratelimit.rejected{scope}`, `chatter.push.sent{outcome}`, `chatter.gateway.frames.rejected{reason}`; Kafka consumer lag from Spring Kafka's built-in metrics. Tracing via the Micrometer OTel bridge: ingest spans tagged `conversation_id` and `client_message_id`; trace ids in logs and in every error body; export by setting `MANAGEMENT_OTLP_TRACING_ENDPOINT`.
- *Also*: push endpoints limited to an allow-list of push services; ciphertext and payload-count caps on ingest.
- *Not done*: the k6 load run.

**Steps 1–8 are the walking skeleton** — the current build. Everything after is additive, and 13–14 can run in parallel with 9–12.
