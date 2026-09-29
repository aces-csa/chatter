# High-Level Design — "Chatter" (WhatsApp-like Web Messenger)

Status: DRAFT for review · Owner: Abhilash CS · Date: 2026-09-27

---

## 1. Goals & Non-Goals

### Goals
1. 1:1 and group text messaging, in real time, with WhatsApp's exact delivery semantics (sent → delivered → read, the one/two/blue tick model).
2. Offline-first: the client owns a local copy of history; the server is a relay plus a short-term mailbox, not the source of truth for reading history.
3. Media sharing (image/video/audio/document) with thumbnails, resumable upload, progressive download.
4. Presence (online / last seen), typing indicators, per-chat privacy controls over both.
5. Group chats with roles (admin/member), invite links, up to 1024 members.
6. Voice notes, replies, reactions, forwards, star, edit (15 min window), delete-for-everyone (2 days).
7. Multi-device: one account, several linked web sessions, all kept in sync.
8. Push notifications when the tab is closed (Web Push / VAPID).
9. Optional but designed-for: end-to-end encryption using the Signal protocol.

### Non-Goals (v1)
- Voice/video calling (WebRTC). The architecture leaves a seam for it; it is not built in v1.
- Status/Stories, Channels, Communities, Payments.
- Native mobile apps. Web only, installable as a PWA.
- Multi-region active-active. Single region, multi-AZ.

### Scale we design for (not what we deploy on day one)

| Metric | Target |
|---|---|
| Registered users | 10 M |
| DAU | 2 M |
| Peak concurrent WebSocket connections | 500 K |
| Messages/day | 500 M (~15 K msg/s peak) |
| p99 in-region delivery latency | < 300 ms |
| Media stored | 200 TB |
| Availability | 99.95 % |

---

## 2. Architecture Overview

```
     Browser (React PWA)                    ┌──────────────────────────┐
     ├─ IndexedDB (local history)           │  CDN (static + media)    │
     ├─ Service Worker (Web Push)           └────────────┬─────────────┘
     └─ WebSocket / STOMP                                │ signed URLs
                 │                                       │
                 ▼                                       │
     ┌───────────────────────────────────────────────────┴───┐
     │   Edge: Nginx / ALB   (TLS, sticky routing by session) │
     └───────┬──────────────────────────────────┬─────────────┘
             │ HTTPS REST                       │ WSS
             ▼                                  ▼
     ┌────────────────┐                ┌──────────────────────────┐
     │  API Gateway   │                │   Connection Gateway     │  N stateful nodes
     │ (Spring Cloud  │                │   ws-gateway             │  50-100K sockets each
     │  Gateway)      │                └──────────┬───────────────┘
     └───┬────┬───┬───┘                           │        ▲ "deliver to user U"
         │    │   │                               ▼        │
     ┌───┴────┴───┴──────┬───────────┬───────────┬─────────┴──────┐
     │  auth   │  user   │   chat    │   media   │    presence    │   Spring Boot
     └────┬────┴────┬────┴─────┬─────┴─────┬─────┴────────┬───────┘
          ▼         ▼          ▼           ▼              ▼
     ┌──────────────────────────────────────────────────────────┐
     │ PostgreSQL  │ Cassandra │  Redis   │  Kafka  │ S3/MinIO   │
     │ identity,   │ message   │ presence │ fan-out │ media      │
     │ groups      │ store     │ routing  │ jobs    │ blobs      │
     └──────────────────────────┬───────────────────────────────┘
                                ▼
                  ┌───────────────────────────┐
                  │ notification-service  ──> │ Web Push (VAPID)
                  │ media-worker          ──> │ transcode, thumbnails
                  └───────────────────────────┘
```

### Deployment shape

We build this as a **modular monolith with hard module boundaries** (one Spring Boot app, `com.chatter.<module>`, no cross-module imports except through `*-api` interfaces), plus the **ws-gateway as a separate deployable from day one** — because it is the only component with fundamentally different scaling and lifecycle characteristics: stateful, long-lived sockets, drain-on-deploy.

Each module can be pulled out into its own service later by swapping an in-process `@Service` call for a Feign/gRPC client; the interfaces already exist. ArchUnit tests enforce the boundaries so they do not rot.

Rationale: a seven-microservice deployment for a greenfield product is mostly distributed-systems tax. The boundaries are what matter, not the process count.

---

## 3. Component Responsibilities

| Component | Responsibility | State |
|---|---|---|
| **ws-gateway** | Terminate WSS, authenticate the socket, maintain `connectionId → userId+deviceId`, subscribe to its own Redis channel / Kafka partition, push frames down. Heartbeats and backpressure. | In-memory socket registry; Redis routing table |
| **auth-service** | Phone registration, OTP, JWT access/refresh, device registration, linked-device QR flow, session revocation | Postgres; Redis for OTP + refresh allowlist |
| **user-service** | Profile, avatar, about, contact sync (hashed phone numbers), block list, privacy settings | Postgres |
| **chat-service** | The heart. Conversations, group management, message ingest, sequencing, fan-out orchestration, receipts, reactions, edit/delete | Cassandra (messages), Postgres (conversations, members) |
| **presence-service** | online/offline/last-seen, typing indicators, subscription-scoped fan-out | Redis only (TTL keys + pub/sub) |
| **media-service** | Pre-signed upload tickets, resumable multipart, scan hook, metadata | Postgres metadata, S3 blobs |
| **media-worker** | Kafka consumer: thumbnails, H.264/AAC transcode, Opus audio, EXIF strip | stateless |
| **notification-service** | Kafka consumer on undelivered messages → Web Push; collapse keys, mute, quiet hours | Postgres subscriptions |

---

## 4. Key Design Decisions

### DD-1 · Transport: WebSocket with STOMP

Raw WebSocket gives us frames and nothing else; we would re-invent subscriptions, acks and error frames badly. STOMP over WebSocket (Spring's `@MessageMapping` + `SimpMessagingTemplate`) gives destination routing, per-frame receipts and a mature JS client. SSE is out — unidirectional. Long-polling stays as the client's automatic fallback for hostile networks.

We do **not** use STOMP's external broker relay. The gateway resolves routing itself via Redis, keeping the hot path at one network hop.

### DD-2 · Ordering: a per-conversation monotonic sequence, never wall-clock

Clocks lie, and distributed clocks lie in interesting ways. Each conversation carries a `seq` counter (Redis `INCR` on `conv:{id}:seq`, durably reconciled to the message store). Clients sort by `seq`; `created_at` is display-only.

This gives total order *within* a conversation, which is the only ordering a human can perceive. There is no global order across conversations — nobody needs it and it would cost a consensus round.

### DD-3 · Message storage: Cassandra, partitioned by conversation

```
PRIMARY KEY ((conversation_id, bucket), seq)  WITH CLUSTERING ORDER BY (seq DESC)
```

`bucket = yyyyMM` keeps partitions bounded for busy groups. The workload is write-heavy, range-read-by-recency, never updated in place — exactly Cassandra's shape and exactly not Postgres's. Every read is "last N before seq X" = one partition, one slice.

> **Phasing note.** For local dev and the first deploy we ship a `MessageStore` interface with a Postgres implementation (declaratively partitioned by month), so nobody needs a Cassandra ring on a laptop. Cassandra drops in behind that interface at the scale where it pays for itself. This is a deliberate decision to confirm, not a hedge.

### DD-4 · Fan-out: payload written once, pointers written per recipient

For a 1024-member group, copying the payload 1024 times is waste.

- The body is written **once**, keyed by conversation.
- Per recipient we write a tiny **inbox pointer** (`user_id, conversation_id, seq, state`) and bump an unread counter.
- Online recipients are pushed the payload immediately and never read the pointer.
- Offline recipients pull "everything after my last-acked seq per conversation" on reconnect.

A 1024-member broadcast costs one large write plus 1024 tiny ones, instead of 1024 large ones.

### DD-5 · Delivery: at-least-once transport, exactly-once experience

The network will duplicate; we make duplicates harmless.

- The **client** mints a `client_message_id` (UUIDv7) before sending.
- The server treats `(sender_device_id, client_message_id)` as an idempotency key: a 24 h Redis guard with a unique index as the durable backstop.
- Re-sending after a timeout is therefore always safe, and the optimistic bubble is reconciled by `client_message_id`, not by list position.

### DD-6 · The outbox pattern for everything that crosses a boundary

`chat-service` writes the message row and the Kafka intent in one transaction to an `outbox` table; a relay (poller, later Debezium) publishes. Without this, a crash between "saved" and "published" silently loses a message — the one failure mode a messenger may never have.

### DD-7 · Presence is best-effort and lives only in Redis

`presence:{userId}` = `{status, lastSeenAt, deviceCount}` with a 40 s TTL refreshed by a 30 s client heartbeat. If Redis loses it, the worst outcome is a stale "last seen" — never a lost message. Typing is pure pub/sub, 5 s TTL, never persisted.

Presence changes fan out only to users who currently have that chat open (an explicit `presence.subscribe` frame), turning an O(contacts) broadcast into O(open chats).

### DD-8 · End-to-end encryption: Signal protocol, designed in, phased on

The server stores per device: an identity key, a signed prekey, a bucket of one-time prekeys. Session setup is X3DH; the ratchet is Double Ratchet. Consequences we accept up front:

- **No server-side search, link previews, or moderation.** Search becomes client-side over IndexedDB. That is a product decision, not a technical one.
- Multi-device means **per-device sessions** (sender keys for groups), so an envelope carries N ciphertexts for N recipient devices.
- Media is encrypted client-side (AES-256-CBC + HMAC-SHA256); only the key travels inside the encrypted body. The blob store never sees plaintext.

Because this materially reshapes the client and the schema, the envelope is E2EE-ready from v1: `payload` is an opaque byte array tagged `plaintext/v1` or `signal/v3`, even if v1 ships `plaintext/v1`. **This is the single biggest scope question — flagged for your decision in REQUIREMENTS.md.**

### DD-9 · Media uploads bypass the app servers entirely

1. Client asks media-service for an upload ticket → pre-signed S3 multipart URLs.
2. Client uploads directly, resumable, 5 MB chunks.
3. Client calls "complete" → media-service HEADs the object, writes metadata, emits a Kafka event.
4. media-worker produces thumbnail and transcoded variants.
5. The chat message references `media_id`; recipients get short-lived pre-signed GETs through the CDN.

Streaming a 16 MB video through a Spring MVC thread is an excellent way to produce a heap dump.

### DD-10 · Multi-device sync

Every device has its own `device_id` and its own last-acked seq per conversation. A message sent from device A is echoed to devices B and C as a self-message so their local stores converge. Read receipts are per **user**, not per device: the first device to read marks it read for the account and the rest are told.

### DD-11 · Sealed sender for 1:1 messages

End-to-end encryption hides *what* is said; the server still sees *who* sends to whom, and when. Sealed sender removes the sender from that picture for 1:1 chats (Signal's design):

- The sender puts a **server-signed sender certificate** (user, device, identity key, 24 h expiry) and the Signal ciphertext inside an envelope encrypted to the recipient device's identity key (ephemeral X25519 → HKDF → AES-256-GCM).
- It posts that envelope to an **unauthenticated** endpoint. Instead of a token it presents the recipient's **unidentified access key**, a 16-byte secret shared only inside E2EE messages, so only people the recipient has messaged can use the path.
- The server stores it per recipient device with **no sender and no conversation**. In a 1:1 chat the conversation id alone names the sender, so a sealed message is filed under no conversation and has no sequence number.
- The recipient opens the envelope, verifies the certificate, decrypts the inner message, and accepts it only if the certificate's identity key is the one the Signal session with that device is bound to.

Scope and cost: groups and attachments stay identified (a group message names its members; an upload is already tied to its conversation). Receipts for sealed messages travel sealed too. The server can no longer enforce blocking on these messages, so the client drops sealed messages from blocked users and rotates its access key on block, pushing the blocked person back to identified sends. The IP address remains visible; hiding it is a transport concern.

---

## 5. Critical Flows

### 5.1 Send a 1:1 message (happy path)

```
Client A          ws-gw-3          chat-service        Redis/Kafka        ws-gw-9        Client B
   │  SEND            │                  │                   │                │              │
   │ {clientMsgId,    │                  │                   │                │              │
   │  convId, body}   │                  │                   │                │              │
   ├─────────────────>│   ingest(...)    │                   │                │              │
   │                  ├─────────────────>│  idempotency get  │                │              │
   │                  │                  ├──────────────────>│                │              │
   │                  │                  │  INCR conv seq    │                │              │
   │                  │                  ├──────────────────>│                │              │
   │                  │                  │  persist + outbox │                │              │
   │  ACK{id,seq,ts}  │<─────────────────┤  (one txn)        │                │              │
   │<─────────────────┤                  │                   │                │              │
   │  ✓ one tick      │                  │  route(B) lookup  │                │              │
   │                  │                  ├──────────────────>│                │              │
   │                  │                  │  publish → gw-9   │                │              │
   │                  │                  ├───────────────────┼───────────────>│   MESSAGE    │
   │                  │                  │                   │                ├─────────────>│
   │                  │                  │                   │                │  DELIVERED   │
   │  ✓✓ two ticks    │<─────────────────┤<──────────────────┼────────────────┤<─────────────┤
   │<─────────────────┤                  │                   │                │              │
```

If B has no live socket, the route lookup misses, the message stays in B's inbox and a `push.notify` event goes to notification-service. On B's next connect the client sends `SYNC {lastSeqPerConversation}` and drains.

### 5.2 Reconnect and catch-up

The client keeps `lastSeq` per conversation in IndexedDB. On connect it sends one `SYNC` frame with a compact map; the server replies with a paged backlog (500 messages per page, ordered by conversation then seq) plus any receipt / edit / delete / reaction deltas expressed as the *same* envelope types.

There is no separate "history API" for the recent window. One code path serves live and catch-up, which is what stops the two from drifting apart.

### 5.3 Group message

As 5.1, except fan-out iterates the member list (cached in Redis, invalidated on membership change) and writes inbox pointers in batches of 100. Muted members are excluded from the push event but not from delivery.

### 5.4 Read receipts

The client sends `READ {convId, uptoSeq}` — coalesced, never per message. The server marks the range, decrements unread, and emits one receipt event to the sender. One frame for N messages is what keeps a fast scrollback from producing a receipt storm.

---

## 6. Cross-Cutting Concerns

**Security.** JWT access token (15 min) plus a rotating refresh token (30 d, one-time use, reuse detection revokes the whole family). The WebSocket authenticates on CONNECT and the socket is closed when the token expires unless refreshed in-band. Rate limits at the gateway (Bucket4j on Redis): 30 msg/s per device, 5 OTP/hour per number, 100 media tickets/hour. Contact sync uses SHA-256 truncated hashes with a server-side pepper — full privacy is impossible here because the phone-number space is enumerable, so we rate-limit hard and state the limitation plainly.

**Observability.** OpenTelemetry traces carrying `conversation_id` and `client_message_id` as span attributes, so a single message is greppable end to end. Micrometer → Prometheus. The four metrics that actually matter: sockets per gateway, ingest→delivered p99, undelivered backlog depth, Kafka consumer lag.

**Deployment.** Docker Compose locally (Postgres, Redis, Kafka/Redpanda, MinIO, app, gateway). Kubernetes for anything real. ws-gateway needs `terminationGracePeriodSeconds: 120` and a pre-stop hook that stops accepting and drains, otherwise every deploy is a thundering herd.

**Failure modes we handle explicitly.**

| Failure | Behaviour |
|---|---|
| Redis down | Presence stops; seq falls back to a DB counter under a lock; messaging continues degraded |
| Kafka down | Outbox accumulates; online delivery unaffected; pushes delayed, not lost |
| A ws-gateway dies | Clients reconnect with exponential backoff + jitter; `SYNC` recovers the gap |
| Message store partial outage | Write `LOCAL_QUORUM`, read `LOCAL_ONE` with retry; a failed write surfaces to the sender as a red "!" rather than a false tick |
| Client offline 30+ days | Mailbox retention is 30 d; beyond that the backlog is gone and the UI says so |

---

## 7. Technology Choices

| Layer | Choice | Why not the alternative |
|---|---|---|
| Frontend | React 18 + TypeScript + Vite | CRA is dead; Next.js SSR buys nothing for an authenticated offline-first shell |
| State | Zustand + TanStack Query | The message store is really a local DB, not app state; Redux would wrap it in ceremony |
| Local store | IndexedDB via Dexie | localStorage is 5 MB and synchronous |
| Styling | Tailwind + Radix primitives | Velocity, and Radix gets accessibility right |
| Backend | Java 17 + Spring Boot 3.3 | As requested. Java 21 virtual threads would suit the gateway better — **flagged below** |
| Realtime | Spring WebSocket + STOMP | Netty directly means more control and much more code |
| RDBMS | PostgreSQL 16 | — |
| Message store | Cassandra 4.1 (Postgres in P1) | See DD-3 |
| Cache / presence | Redis 7 | — |
| Bus | Kafka (Redpanda locally) | RabbitMQ lacks the replayable log we want for fan-out and audit |
| Object store | S3, MinIO locally | — |
| Search | Client-side (Dexie + FlexSearch) | Forced by E2EE, and cheaper anyway |
| Push | Web Push (VAPID) | FCM adds a Google dependency for no web-side benefit |

**Flag: Java 17 vs 21.** You have 17 installed and asked for Java. The gateway is a thread-per-connection-shaped problem where virtual threads (21 LTS) remove the need for async plumbing. Everything here works on 17; 21 would make the gateway meaningfully simpler. Your call — it is in the confirmation list.

---

## 8. Phasing

| Phase | Content | Why this cut |
|---|---|---|
| **P0 — Walking skeleton** | Auth (OTP), 1:1 text over WS, single gateway, Postgres, optimistic send, one/two ticks | Proves the hard part — socket, ordering, idempotency — before any UI polish |
| **P1 — Real messenger** | Groups, read receipts, presence, typing, reply/react/forward/delete, unread counts, multi-device sync | This is where it starts to feel like WhatsApp |
| **P2 — Media** | Images, video, documents, voice notes, thumbnails, transcode worker, CDN | Independent of P1; can run in parallel |
| **P3 — Hardening** | Push notifications, Kafka fan-out, horizontal gateway + Redis routing, rate limits, observability | The parts that only matter once real users arrive |
| **P4 — E2EE** | Signal protocol, per-device sessions, sender keys, encrypted media | Deliberately last: it invalidates any server-side feature built on plaintext |
