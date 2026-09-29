import { Curve25519Wrapper } from '@privacyresearch/curve25519-typescript';
import { db, type OwnSenderKeyRow, type SenderKeyRow } from '@/db/db';
import { base64ToBuffer, bufferToBase64, utf8ToBuffer } from '@/lib/bytes';

/**
 * Group encryption with sender keys (LLD 3.6, requirement 11.5).
 *
 * <p>Each device keeps one symmetric chain per group it sends to. The chain seed and a signing
 * public key -- the "distribution" -- are handed to every member device once, over the pairwise
 * Signal sessions. After that a group message is encrypted <em>once</em>, not once per device:
 * O(1) per message instead of O(members), which is what makes 1024-member groups possible.
 *
 * <p>Construction, following Signal's SenderKey scheme:
 * <ul>
 *   <li>message-key seed = HMAC-SHA256(chainKey, 0x01); next chainKey = HMAC-SHA256(chainKey, 0x02).
 *       Old chain keys are discarded, so a key that leaks later cannot read earlier messages.</li>
 *   <li>message key = HKDF-SHA256(seed) to AES-256-GCM, with the group id as associated data so a
 *       ciphertext cannot be replayed into another group.</li>
 *   <li>every message is signed with the sender's Curve25519 signing key. Without the signature
 *       any member holding the chain could forge messages "from" the sender.</li>
 * </ul>
 * One deliberate difference from Signal: AES-GCM rather than AES-CBC + HMAC. It is authenticated
 * encryption in one primitive, and WebCrypto implements it natively.
 */

export interface SenderKeyDistribution {
  groupId: string;
  keyId: number;
  iteration: number;
  chainKey: string;
  signingPub: string;
}

interface WireMessage {
  v: 1;
  /** key id */
  k: number;
  /** iteration */
  n: number;
  iv: string;
  ct: string;
  sig: string;
}

/** Thrown when we have never been handed this sender's key. The UI shows a placeholder. */
export class MissingSenderKeyError extends Error {}

/** How far ahead of our position a message may be before we refuse to ratchet to it. */
const MAX_FORWARD_JUMP = 2000;
/** Out-of-order message keys we are willing to hold per sender. */
const MAX_SKIPPED = 2000;

const subtle = globalThis.crypto.subtle;
const SEED_LABEL = new Uint8Array([0x01]);
const CHAIN_LABEL = new Uint8Array([0x02]);
const HKDF_INFO = new TextEncoder().encode('ChatterSenderKey');

let curvePromise: Promise<Curve25519Wrapper> | null = null;
function curve(): Promise<Curve25519Wrapper> {
  curvePromise ??= Curve25519Wrapper.create();
  return curvePromise;
}

/**
 * Ratchet state is read, advanced and written back across several awaits of WebCrypto, which
 * IndexedDB transactions cannot span. Two messages from one sender decrypting concurrently would
 * both read iteration n and one would lose. So each chain gets a promise-chain lock.
 */
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, job: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(job, job);
  const settled = next.catch(() => undefined);
  locks.set(key, settled);
  void settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key);
  });
  return next;
}

function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

function b64(bytes: Uint8Array | ArrayBuffer): string {
  return bufferToBase64(bytes instanceof Uint8Array ? copy(bytes) : bytes);
}

function copy(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

async function hmac(key: ArrayBuffer, data: Uint8Array): Promise<ArrayBuffer> {
  const imported = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return subtle.sign('HMAC', imported, copy(data));
}

/** One ratchet step: the seed for this iteration's message key, and the next chain key. */
async function step(chainKey: string): Promise<{ seed: ArrayBuffer; next: string }> {
  const key = base64ToBuffer(chainKey);
  const [seed, next] = await Promise.all([hmac(key, SEED_LABEL), hmac(key, CHAIN_LABEL)]);
  return { seed, next: b64(next) };
}

async function messageKey(seed: ArrayBuffer, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  const base = await subtle.importKey('raw', seed, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(32), info: copy(HKDF_INFO) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

function signedBytes(groupId: string, m: Omit<WireMessage, 'sig' | 'v'>): ArrayBuffer {
  return utf8ToBuffer(`chatter-sk-v1|${groupId}|${m.k}|${m.n}|${m.iv}|${m.ct}`);
}

function rowId(groupId: string, senderDeviceId: string, keyId: number): string {
  return `${groupId}:${senderDeviceId}:${keyId}`;
}

async function createOwn(groupId: string): Promise<OwnSenderKeyRow> {
  const signingPriv = randomBytes(32);
  const pair = (await curve()).keyPair(copy(signingPriv));
  const row: OwnSenderKeyRow = {
    groupId,
    // Random rather than sequential: after a wipe-and-reinstall a sequential id would collide
    // with keys other members still hold for this device.
    keyId: globalThis.crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff,
    iteration: 0,
    chainKey: b64(randomBytes(32)),
    signingPub: b64(pair.pubKey),
    signingPriv: b64(pair.privKey),
    sharedWith: [],
  };
  await db.ownSenderKeys.put(row);
  return row;
}

export const senderKeys = {
  /**
   * Encrypts one group message. Returns the distribution as it stood <em>before</em> this
   * message, so a device handed it alongside the message can decrypt that very message.
   */
  async encrypt(
    groupId: string,
    plaintext: string,
  ): Promise<{ groupCiphertext: string; distribution: SenderKeyDistribution; sharedWith: string[] }> {
    return withLock(`own:${groupId}`, async () => {
      const own = (await db.ownSenderKeys.get(groupId)) ?? (await createOwn(groupId));
      const distribution: SenderKeyDistribution = {
        groupId,
        keyId: own.keyId,
        iteration: own.iteration,
        chainKey: own.chainKey,
        signingPub: own.signingPub,
      };

      const { seed, next } = await step(own.chainKey);
      const key = await messageKey(seed, 'encrypt');
      const iv = randomBytes(12);
      const ct = await subtle.encrypt(
        { name: 'AES-GCM', iv: copy(iv), additionalData: utf8ToBuffer(groupId) },
        key,
        utf8ToBuffer(plaintext),
      );
      const unsigned = { k: own.keyId, n: own.iteration, iv: b64(iv), ct: b64(ct) };
      const sig = (await curve()).sign(
        base64ToBuffer(own.signingPriv),
        signedBytes(groupId, unsigned),
      );
      const wire: WireMessage = { v: 1, ...unsigned, sig: b64(sig) };

      await db.ownSenderKeys.update(groupId, { chainKey: next, iteration: own.iteration + 1 });
      return {
        groupCiphertext: btoa(JSON.stringify(wire)),
        distribution,
        sharedWith: own.sharedWith,
      };
    });
  },

  /** Called once the server has ACKed a send that carried the key to these devices. */
  async markShared(groupId: string, keyId: number, deviceIds: string[]): Promise<void> {
    if (deviceIds.length === 0) return;
    await withLock(`own:${groupId}`, async () => {
      const own = await db.ownSenderKeys.get(groupId);
      // A rotation in between means these devices got a key we no longer use.
      if (!own || own.keyId !== keyId) return;
      await db.ownSenderKeys.update(groupId, {
        sharedWith: [...new Set([...own.sharedWith, ...deviceIds])],
      });
    });
  },

  /**
   * Discards our key for a group. The next send mints a fresh one and hands it to every current
   * member device -- which is how someone who left stops being able to read new messages.
   */
  async rotate(groupId: string): Promise<void> {
    await withLock(`own:${groupId}`, () => db.ownSenderKeys.delete(groupId));
  },

  /**
   * Stores another device's key. {@code senderDeviceId} must come from the authenticated
   * pairwise session that carried the distribution, never from inside it, or one member could
   * install a key in someone else's name.
   */
  async process(senderDeviceId: string, distribution: SenderKeyDistribution): Promise<void> {
    const id = rowId(distribution.groupId, senderDeviceId, distribution.keyId);
    await withLock(`${distribution.groupId}:${senderDeviceId}`, async () => {
      // Already holding this key means we may have ratcheted past the distributed position;
      // replacing it would rewind the chain and replay old message keys.
      if (await db.senderKeys.get(id)) return;
      const row: SenderKeyRow = {
        id,
        groupId: distribution.groupId,
        senderDeviceId,
        keyId: distribution.keyId,
        iteration: distribution.iteration,
        chainKey: distribution.chainKey,
        signingPub: distribution.signingPub,
        skipped: {},
      };
      await db.senderKeys.put(row);
    });
  },

  async decrypt(groupId: string, senderDeviceId: string, groupCiphertext: string): Promise<string> {
    const wire = JSON.parse(atob(groupCiphertext)) as WireMessage;
    if (wire.v !== 1) throw new Error(`Unsupported sender-key version ${wire.v}`);

    return withLock(`${groupId}:${senderDeviceId}`, async () => {
      const row = await db.senderKeys.get(rowId(groupId, senderDeviceId, wire.k));
      if (!row) throw new MissingSenderKeyError(`No sender key ${wire.k} for ${senderDeviceId}`);

      // Verify before touching the ratchet, so a forged message cannot advance it.
      const valid = (await curve()).signatureIsValid(
        base64ToBuffer(row.signingPub),
        signedBytes(groupId, wire),
        base64ToBuffer(wire.sig),
      );
      if (!valid) throw new Error('Invalid sender-key signature');

      const skipped = { ...row.skipped };
      let chainKey = row.chainKey;
      let iteration = row.iteration;
      let seed: ArrayBuffer;

      if (wire.n < row.iteration) {
        const cached = skipped[wire.n];
        if (!cached) throw new Error(`Message key ${wire.n} already used or never stored`);
        seed = base64ToBuffer(cached);
        delete skipped[wire.n];
      } else {
        if (wire.n - row.iteration > MAX_FORWARD_JUMP) {
          throw new Error(`Sender-key message ${wire.n} is too far ahead of ${row.iteration}`);
        }
        for (; iteration < wire.n; iteration += 1) {
          const advanced = await step(chainKey);
          skipped[iteration] = b64(advanced.seed);
          chainKey = advanced.next;
        }
        const current = await step(chainKey);
        seed = current.seed;
        chainKey = current.next;
        iteration = wire.n + 1;
      }

      const key = await messageKey(seed, 'decrypt');
      const plaintext = await subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBuffer(wire.iv), additionalData: utf8ToBuffer(groupId) },
        key,
        base64ToBuffer(wire.ct),
      );

      // Persist only after a successful decrypt: a corrupt message must not move the chain.
      const keep = Object.keys(skipped)
        .map(Number)
        .sort((a, b) => b - a)
        .slice(0, MAX_SKIPPED);
      await db.senderKeys.update(row.id, {
        chainKey,
        iteration,
        skipped: Object.fromEntries(keep.map((n) => [n, skipped[n]])),
      });
      return new TextDecoder().decode(plaintext);
    });
  },
};
