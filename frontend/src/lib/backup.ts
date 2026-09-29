import {
  db,
  getMeta,
  setMeta,
  type ContactTrustRow,
  type LocalConversation,
  type LocalMessage,
  type LocalUser,
} from '@/db/db';
import { base64ToBuffer, bufferToBase64 } from '@/lib/bytes';

/**
 * Encrypted local backups: the answer to "lost device = lost history" (REQUIREMENTS, D-1).
 *
 * <p>Under end-to-end encryption the server has nothing to restore from, so the backup is made
 * here, from this device's own store, and encrypted before it leaves the page:
 * <ul>
 *   <li>key = PBKDF2-SHA256(passphrase, random salt, 600 000 iterations) -- OWASP's 2023 figure;</li>
 *   <li>AES-256-GCM over the gzipped JSON, with the file header as associated data, so the salt,
 *       iteration count or account id cannot be altered without the decrypt failing.</li>
 * </ul>
 * What is deliberately <em>not</em> in it: Signal private keys and sessions. They belong to one
 * device; restoring them onto another would clone an identity, which is exactly what safety
 * numbers exist to detect. A restored device gets its history back and keeps its own keys.
 */

const MAGIC = 'CHATTER-BACKUP';
const VERSION = 1;
const ITERATIONS = 600_000;
const LAST_BACKUP_KEY = 'lastBackupAt';

interface Header {
  magic: typeof MAGIC;
  v: number;
  userId: string;
  createdAt: number;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string };
}

interface Contents {
  conversations: LocalConversation[];
  messages: LocalMessage[];
  users: LocalUser[];
  contactTrust: ContactTrustRow[];
  media: Array<{ id: string; type: string; data: string }>;
}

export interface RestoreSummary {
  messages: number;
  conversations: number;
  media: number;
}

export class BackupError extends Error {}

function copy(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', copy(new TextEncoder().encode(passphrase)), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: copy(salt), iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function gzip(bytes: Uint8Array): Promise<ArrayBuffer> {
  return new Response(new Blob([copy(bytes)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
}

async function gunzip(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

export async function lastBackupAt(): Promise<number | undefined> {
  return getMeta<number>(LAST_BACKUP_KEY);
}

export async function createBackup(
  passphrase: string,
  options: { userId: string; includeMedia: boolean },
  onStage: (stage: string) => void = () => {},
): Promise<Blob> {
  onStage('Collecting chats…');
  const [conversations, allMessages, users, contactTrust] = await Promise.all([
    db.conversations.toArray(),
    db.messages.toArray(),
    db.users.toArray(),
    db.contactTrust.toArray(),
  ]);
  // Outgoing control rows and unsent messages are in-flight state, not history.
  const messages = allMessages
    .filter((m) => !m.control && m.state !== 'PENDING')
    .map(({ upload: _upload, ...rest }) =>
      // A view-once item must not become re-viewable by restoring a backup.
      rest.media?.viewOnce ? { ...rest, media: { ...rest.media, key: undefined, digest: undefined, viewOnceSpent: true } } : rest,
    );

  const media: Contents['media'] = [];
  if (options.includeMedia) {
    onStage('Collecting media…');
    for (const row of await db.mediaBlobs.toArray()) {
      if (row.id.startsWith('local:')) continue;
      media.push({ id: row.id, type: row.blob.type, data: bufferToBase64(await row.blob.arrayBuffer()) });
    }
  }

  onStage('Encrypting…');
  const contents: Contents = { conversations, messages, users, contactTrust, media };
  const compressed = await gzip(new TextEncoder().encode(JSON.stringify(contents)));

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header: Header = {
    magic: MAGIC,
    v: VERSION,
    userId: options.userId,
    createdAt: Date.now(),
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: bufferToBase64(copy(salt)) },
    cipher: { name: 'AES-GCM', iv: bufferToBase64(copy(iv)) },
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: copy(iv), additionalData: copy(headerBytes) },
    key,
    compressed,
  );

  await setMeta(LAST_BACKUP_KEY, header.createdAt);
  // Layout: header JSON, newline, ciphertext. The header stays readable so a restore can say
  // "this backup is from another account" before asking for, or wasting, a passphrase attempt.
  return new Blob([copy(headerBytes), '\n', ciphertext], { type: 'application/octet-stream' });
}

export async function readBackupHeader(file: Blob): Promise<Header> {
  const bytes = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  const newline = bytes.indexOf(10);
  if (newline < 0) throw new BackupError('This is not a Chatter backup file');
  let header: Header;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(0, newline))) as Header;
  } catch {
    throw new BackupError('This is not a Chatter backup file');
  }
  if (header.magic !== MAGIC) throw new BackupError('This is not a Chatter backup file');
  if (header.v > VERSION) throw new BackupError('This backup was made by a newer version of Chatter');
  return header;
}

/**
 * Merges a backup into this device's store. Never overwrites: anything already here is newer or
 * equal, so a restore can be repeated safely and cannot roll a chat backwards.
 */
export async function restoreBackup(file: Blob, passphrase: string, selfUserId: string): Promise<RestoreSummary> {
  const header = await readBackupHeader(file);
  if (header.userId !== selfUserId) {
    throw new BackupError('This backup belongs to a different account');
  }
  const all = new Uint8Array(await file.arrayBuffer());
  const newline = all.indexOf(10);
  const headerBytes = all.subarray(0, newline);
  const ciphertext = all.subarray(newline + 1);

  let contents: Contents;
  try {
    const key = await deriveKey(passphrase, new Uint8Array(base64ToBuffer(header.kdf.salt)), header.kdf.iterations);
    const compressed = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBuffer(header.cipher.iv), additionalData: copy(headerBytes) },
      key,
      copy(ciphertext),
    );
    contents = JSON.parse(new TextDecoder().decode(await gunzip(compressed))) as Contents;
  } catch {
    // GCM cannot tell a wrong passphrase from a damaged file, and neither should we pretend to.
    throw new BackupError('Wrong passphrase, or the file is damaged');
  }

  const summary: RestoreSummary = { messages: 0, conversations: 0, media: 0 };
  await db.transaction('rw', [db.conversations, db.messages, db.users, db.contactTrust, db.mediaBlobs], async () => {
    for (const conversation of contents.conversations) {
      const existing = await db.conversations.get(conversation.id);
      if (!existing) {
        await db.conversations.put({ ...conversation, unreadCount: 0 });
        summary.conversations += 1;
      } else if (conversation.lastSeq > existing.lastSeq) {
        await db.conversations.update(conversation.id, { lastSeq: conversation.lastSeq });
      }
    }
    for (const message of contents.messages) {
      const known =
        (await db.messages.get(message.clientMessageId)) ??
        (message.messageId ? await db.messages.where('messageId').equals(message.messageId).first() : undefined);
      if (!known) {
        await db.messages.put(message);
        summary.messages += 1;
      }
    }
    for (const user of contents.users) {
      if (!(await db.users.get(user.id))) await db.users.put(user);
    }
    for (const trust of contents.contactTrust) {
      if (!(await db.contactTrust.get(trust.userId))) await db.contactTrust.put(trust);
    }
    for (const item of contents.media) {
      if (!(await db.mediaBlobs.get(item.id))) {
        await db.mediaBlobs.put({ id: item.id, blob: new Blob([base64ToBuffer(item.data)], { type: item.type }), savedAt: Date.now() });
        summary.media += 1;
      }
    }
  });
  return summary;
}
