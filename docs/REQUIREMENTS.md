# Functional Requirements — "Chatter"

Status: **CONFIRMED 2026-09-27** · Companion to [HLD.md](./HLD.md) and [LLD.md](./LLD.md)

The *Default* column is the agreed scope. **IN** = build it, **OUT** = skip, **LATER** = after v1.

> **Confirmed architecture decisions** (details and consequences in the section at the bottom):
> **D-1 Full Signal E2EE from day one** · **D-2/D-3 Postgres + modular monolith + ws-gateway + Kafka** ·
> **D-4 Java 21 LTS** · **D-6 Walking skeleton first, then review**
>
> Consequence of D-1: FR-3.13 (server-side link previews) is **OUT permanently**, and FR-7.4 (search)
> is client-side only. See "Consequences of D-1" below.

---

## FR-1 · Accounts & Authentication

| # | Requirement | Default |
|---|---|---|
| 1.1 | Register with a phone number; verify with a 6-digit OTP | **BUILT** |
| 1.2 | OTP delivered via a pluggable sender — console/Mailhog in dev, Twilio in prod | **BUILT** (console/log in dev; Twilio sender not wired) |
| 1.3 | JWT access (15 min) + rotating refresh (30 d) with reuse detection | **BUILT** |
| 1.4 | Profile: display name, about, avatar | **BUILT** (profile editing, photo as a small data URL) |
| 1.5 | Link additional web devices by QR code; see and revoke active sessions | **BUILT** (history is not copied to a linked device: E2EE) |
| 1.6 | Delete account (purges profile, memberships, mailbox) | **BUILT** (post-v1) |

## FR-2 · Contacts & Privacy

| # | Requirement | Default |
|---|---|---|
| 2.1 | Contact sync by hashed phone numbers; show which contacts are on Chatter | **BUILT** (contact sync now records contacts, which "My contacts" privacy uses) |
| 2.2 | Block / unblock a user — blocked users cannot message you or see your presence | **BUILT** (blocked messages tick once and are never delivered; calls do not ring) |
| 2.3 | Privacy controls for last-seen, profile photo, about: everyone / contacts / nobody | **BUILT** (enforced for last seen, photo and about) |
| 2.4 | Read-receipts toggle (off = you send none and receive none) | **BUILT** (reciprocal) |
| 2.5 | Report a user / conversation | OUT (v1) |

## FR-3 · 1:1 Messaging

| # | Requirement | Default |
|---|---|---|
| 3.1 | Send and receive plain text in real time | **BUILT** |
| 3.2 | Delivery states with WhatsApp's tick semantics: clock (pending) → ✓ sent → ✓✓ delivered → blue ✓✓ read | **BUILT** |
| 3.3 | Optimistic send: the bubble appears instantly, reconciles on ACK, shows a red "!" with retry on failure | **BUILT** |
| 3.4 | Offline queue: messages composed offline send automatically on reconnect | **BUILT** |
| 3.5 | Emoji picker and native emoji rendering | **BUILT** (native emoji; reaction picker) |
| 3.6 | Reply-to (quoted preview, tap to jump to the original) | **BUILT** |
| 3.7 | Reactions (one emoji per user per message) | **BUILT** |
| 3.8 | Forward to one or more chats | **BUILT** (media re-shared, not re-uploaded) |
| 3.9 | Star / unstar, with a starred-messages view | **BUILT** (per device) |
| 3.10 | Edit within 15 minutes, marked "edited" | **BUILT** (text messages; server-enforced window) |
| 3.11 | Delete for me / delete for everyone (2-hour window, tombstone bubble) | **BUILT** (server purges ciphertext) |
| 3.12 | Copy, select-multiple, bulk delete/forward | **BUILT** |
| 3.13 | Link previews | **Client-side only** — server never sees plaintext (D-1) |
| 3.14 | Disappearing messages (24 h / 7 d / 90 d) | **BUILT** (post-v1) |

## FR-4 · Group Messaging

| # | Requirement | Default |
|---|---|---|
| 4.1 | Create a group with subject, avatar, description; up to 1024 members | **BUILT** (subject + description; no group avatar yet) |
| 4.2 | Roles: owner, admin, member; promote/demote; remove members | **BUILT** |
| 4.3 | Settings: only-admins-can-post, only-admins-can-edit-info | **BUILT** |
| 4.4 | System messages in the timeline ("X added Y", "X changed the subject") | **BUILT** |
| 4.5 | Invite links with revoke and optional expiry | **BUILT** |
| 4.6 | Leave group; per-group mute (8 h / 1 week / always) | **BUILT** |
| 4.7 | @mentions with a mention-only notification even when muted | **BUILT** (mentions notify through a muted group) |
| 4.8 | Per-message read-by list for groups ("message info") | **BUILT** (group ticks turn blue only when everyone has read) |
| 4.9 | Communities / subgroups | OUT |

## FR-5 · Media

| # | Requirement | Default |
|---|---|---|
| 5.1 | Images (JPEG/PNG/WebP/GIF) with client-side compression + server thumbnail + blurhash | **BUILT** (client-side compression and thumbnail (server cannot thumbnail ciphertext); no blurhash) |
| 5.2 | Video (MP4/WebM, ≤100 MB) with poster frame, transcode to H.264/AAC, inline playback | **BUILT** (poster frame + inline playback; no server transcode under E2EE) |
| 5.3 | Documents (any type, ≤100 MB) with icon, name, size, download | **BUILT** |
| 5.4 | Voice notes: hold-to-record, waveform, variable-speed playback | **BUILT** |
| 5.5 | Resumable chunked upload with progress and cancel | **BUILT** |
| 5.6 | Media gallery per conversation (media / docs / links tabs) | **BUILT** (media / docs / links tabs, built on-device) |
| 5.7 | Drag-and-drop and paste-from-clipboard to send | **BUILT** |
| 5.8 | View-once media | **BUILT** (erased from the device after one view; no sender copy) |
| 5.9 | Stickers / GIF search (Tenor) | OUT |

## FR-6 · Presence & Indicators

| # | Requirement | Default |
|---|---|---|
| 6.1 | Online / last-seen, honouring privacy settings | **BUILT** |
| 6.2 | Typing indicator ("typing…", "X is typing" in groups) | **BUILT** |
| 6.3 | Recording-audio indicator | **BUILT** |
| 6.4 | Connection banner ("Connecting…", "Waiting for network") | **BUILT** |

## FR-7 · Chat Management

| # | Requirement | Default |
|---|---|---|
| 7.1 | Chat list ordered by recency, with last-message preview, timestamp, unread badge, ticks | **BUILT** |
| 7.2 | Pin up to 3 chats; archive / unarchive | **BUILT** (max 3 pinned, synced via the server) |
| 7.3 | Mark as read / unread | **BUILT** (synced via the server) |
| 7.4 | Search: across chats, within a chat, by contact — client-side over the local store | **BUILT** (across chats, within a chat, and by contact; client-side scan) |
| 7.5 | Clear chat history; delete chat | **BUILT** (this device only; groups must be exited first) |
| 7.6 | Export chat as a text file | **BUILT** (post-v1, client-side) |

## FR-8 · Notifications

| # | Requirement | Default |
|---|---|---|
| 8.1 | Web Push when the tab is closed or backgrounded, with per-chat collapse | **BUILT** (content-free payload; names resolved on-device) |
| 8.2 | In-app sound + title-bar unread count | **BUILT** |
| 8.3 | Per-chat and global mute; reply-from-notification | **BUILT** (mute per chat, global per device; inline reply where the platform supports it) |
| 8.4 | Quiet hours | **BUILT** (enforced server-side for push and in-page) |

## FR-9 · Platform

| # | Requirement | Default |
|---|---|---|
| 9.1 | Installable PWA with an offline shell | **BUILT** (manifest + service-worker offline shell) |
| 9.2 | Responsive: usable at mobile width, two-pane on desktop | **BUILT** |
| 9.3 | Light / dark theme following the OS | **BUILT** (CSS-variable palette following prefers-color-scheme) |
| 9.4 | Keyboard shortcuts (new chat, search, next/prev chat, send) | **BUILT** (Ctrl+K, Ctrl+Alt+N, Alt+Up/Down, Esc) |
| 9.5 | i18n scaffolding (English only shipped) | **BUILT** (lib/i18n.ts; chat list migrated, rest incremental) |
| 9.6 | Accessibility: keyboard-navigable, screen-reader labels on bubbles and ticks | **BUILT** (labels on bubbles, ticks and controls; not audited with a screen reader) |

## FR-10 · Explicitly Out of Scope for v1

Voice/video calls · Status/Stories · Channels · Payments · Business API · Native apps · Multi-region.

---

## Confirmed Decisions (2026-09-27)

| # | Decision | Chosen |
|---|---|---|
| D-1 | End-to-end encryption | **Full Signal protocol from day one** |
| D-2 | Phase-1 message store | Postgres, monthly partitions, behind `MessageStore` |
| D-3 | Topology | Modular monolith + separate ws-gateway |
| D-4 | Java | **21 LTS** (virtual threads in the gateway) |
| D-5 | Local infra | Postgres, Redis, Redpanda, MinIO, Mailhog in Compose |
| D-6 | First pass | Walking skeleton (LLD §9 steps 1–6), then review |

### Consequences of D-1 that we are accepting

1. **No server-side link previews, search, moderation, spam detection or analytics on content.** The server stores ciphertext it cannot read. FR-3.13 becomes a client-side fetch; FR-7.4 search runs over IndexedDB.
2. **Registration is heavier.** A device must generate an identity key pair, a signed prekey and 100 one-time prekeys, and publish the public halves, before it can be messaged. A background job tops up one-time prekeys when the server's bucket drops below 20.
3. **Sending is per-recipient-device, not per-conversation.** A message to a user with 3 linked devices produces 3 ciphertexts. For groups we use **sender keys**: one symmetric key per sender per group, distributed pairwise, so a 1024-member group costs one ciphertext plus a one-time key distribution, not 1024 ciphertexts per message.
4. **Key material lives in the browser.** Signal's ratchet needs raw key bytes, so they sit in IndexedDB — not as non-extractable WebCrypto keys. We wrap the store with a device key held in a non-extractable `CryptoKey` so a casual IndexedDB dump is not immediately usable, but a compromised browser is a compromised identity. This is true of Signal Desktop as well; it is a property of the threat model, not a defect we can code around.
5. **Safety numbers and key-change warnings are required, not optional.** Without them E2EE is unverifiable and therefore theatre. FR-2 gains: safety-number display + QR comparison, and a "security code changed" system message.
6. **Lost device = lost history.** There is no server-side plaintext to restore from. Encrypted local backup/export is deferred, and the UI must say this plainly at registration.
7. **Library choice, stated honestly.** Signal's own `libsignal` ships Rust with Node bindings, not a browser WASM build we can consume directly. For the browser we use **`@privacyresearch/libsignal-protocol-typescript`**, a maintained TypeScript port of Signal's protocol. It implements X3DH and the Double Ratchet correctly, but it is a community port and has not had Signal's audit history. It is behind a `CryptoProvider` interface so it can be replaced with a self-built libsignal WASM bundle later without touching call sites. **If you want audited crypto, the swap is a build-pipeline problem, and I'd rather you know that now than discover it at review.**

### Added to scope by D-1

| # | Requirement |
|---|---|
| 11.1 | Identity key pair per device; registration id; published at device registration |
| 11.2 | Signed prekey with rotation every 48 h; 100 one-time prekeys with auto top-up below 20 |
| 11.3 | `GET /keys/{userId}/bundle` returns one bundle per active device, consuming a one-time prekey |
| 11.4 | X3DH session establishment, Double Ratchet message encryption, out-of-order + skipped-key handling |
| 11.5 | Sender-key (group) sessions with distribution messages on membership change |
| 11.6 | Safety numbers: 60-digit code + QR, comparison screen, "verified" state per contact |
| 11.7 | Key-change detection with an in-timeline system message |
| 11.8 | Encrypted media: random AES-256-CBC key + HMAC-SHA256 per blob, key carried inside the encrypted body |
| 11.9 | Encrypted-at-rest local store, wrapped by a non-extractable device key |

---

## Non-Functional Requirements (for the record)

| # | Requirement |
|---|---|
| NFR-1 | p99 in-region delivery < 300 ms; p99 API read < 150 ms |
| NFR-2 | Chat list interactive < 1.5 s on a warm cache; app shell < 200 KB gzipped |
| NFR-3 | Zero message loss once ACKed — this is the one hard invariant |
| NFR-4 | A single gateway node holds 50 K sockets on 4 vCPU / 8 GB |
| NFR-5 | Horizontal scaling by adding gateway nodes, no config change |
| NFR-6 | 99.95 % availability; graceful degradation per the HLD failure table |
| NFR-7 | Mailbox retention 30 days; media retention 1 year |
| NFR-8 | All PII encrypted at rest; audit log for auth events |
