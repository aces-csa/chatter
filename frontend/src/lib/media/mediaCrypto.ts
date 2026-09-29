import { base64ToBuffer, bufferToBase64 } from '@/lib/bytes';

/**
 * Attachment encryption (requirement 11.8): a random AES-256-CBC key plus a separate
 * HMAC-SHA256 key per blob, encrypt-then-MAC. Wire layout: IV (16) || ciphertext || MAC (32).
 *
 * <p>The key travels only inside the end-to-end encrypted message, so the object store holds
 * bytes nobody but the conversation can open.
 */

const subtle = globalThis.crypto.subtle;
const IV_BYTES = 16;
const MAC_BYTES = 32;

export interface EncryptedMedia {
  ciphertext: Uint8Array;
  /** base64 of 64 bytes: AES key || HMAC key */
  key: string;
  iv: string;
  /** base64 SHA-256 of the full ciphertext */
  digest: string;
}

function copy(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

async function importKeys(key: string): Promise<{ aes: CryptoKey; mac: CryptoKey }> {
  const raw = new Uint8Array(base64ToBuffer(key));
  if (raw.length !== 64) throw new Error('Media key must be 64 bytes');
  const [aes, mac] = await Promise.all([
    subtle.importKey('raw', copy(raw.subarray(0, 32)), 'AES-CBC', false, ['encrypt', 'decrypt']),
    subtle.importKey('raw', copy(raw.subarray(32)), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ]),
  ]);
  return { aes, mac };
}

export function newMediaKey(): { key: string; iv: string } {
  return {
    key: bufferToBase64(copy(globalThis.crypto.getRandomValues(new Uint8Array(64)))),
    iv: bufferToBase64(copy(globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES)))),
  };
}

/**
 * Deterministic for a given key and IV. That is what lets an interrupted upload resume: after a
 * reload the file is re-encrypted with the stored key and IV into the same bytes, so the parts
 * already in the bucket are still valid.
 */
export async function encryptMedia(
  plaintext: ArrayBuffer,
  key: string,
  iv: string,
): Promise<EncryptedMedia> {
  const { aes, mac } = await importKeys(key);
  const ivBytes = new Uint8Array(base64ToBuffer(iv));
  const body = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: copy(ivBytes) }, aes, plaintext));

  const signed = new Uint8Array(IV_BYTES + body.length);
  signed.set(ivBytes, 0);
  signed.set(body, IV_BYTES);
  const tag = new Uint8Array(await subtle.sign('HMAC', mac, copy(signed)));

  const ciphertext = new Uint8Array(signed.length + MAC_BYTES);
  ciphertext.set(signed, 0);
  ciphertext.set(tag, signed.length);
  const digest = await subtle.digest('SHA-256', copy(ciphertext));
  return { ciphertext, key, iv, digest: bufferToBase64(digest) };
}

/** Checks the digest and the MAC before decrypting anything; a tampered blob never reaches AES. */
export async function decryptMedia(
  ciphertext: ArrayBuffer,
  key: string,
  digest: string,
): Promise<ArrayBuffer> {
  const actual = bufferToBase64(await subtle.digest('SHA-256', ciphertext));
  if (actual !== digest) throw new Error('Media digest mismatch');

  const bytes = new Uint8Array(ciphertext);
  if (bytes.length < IV_BYTES + MAC_BYTES + 16) throw new Error('Media blob too short');
  const signed = bytes.subarray(0, bytes.length - MAC_BYTES);
  const tag = bytes.subarray(bytes.length - MAC_BYTES);

  const { aes, mac } = await importKeys(key);
  if (!(await subtle.verify('HMAC', mac, copy(tag), copy(signed)))) {
    throw new Error('Media MAC mismatch');
  }
  return subtle.decrypt(
    { name: 'AES-CBC', iv: copy(signed.subarray(0, IV_BYTES)) },
    aes,
    copy(signed.subarray(IV_BYTES)),
  );
}

/** AES-CBC pads to 16 bytes; plus IV and MAC. Lets the size check run before encrypting. */
export function encryptedSizeOf(plaintextSize: number): number {
  return IV_BYTES + (Math.floor(plaintextSize / 16) + 1) * 16 + MAC_BYTES;
}
