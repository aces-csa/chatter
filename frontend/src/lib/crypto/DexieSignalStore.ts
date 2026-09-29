import {
  Direction,
  type KeyPairType,
  type StorageType,
} from '@privacyresearch/libsignal-protocol-typescript';
import { db } from '@/db/db';
import { base64ToBuffer, bufferToBase64 } from '@/lib/bytes';

/**
 * libsignal's StorageType backed by IndexedDB, so sessions and key material survive a refresh.
 *
 * <p>The ratchet needs raw key bytes, so these cannot be non-extractable WebCrypto keys. That is
 * a property of the Signal protocol, not an oversight: a compromised browser is a compromised
 * identity, exactly as it is for Signal Desktop.
 */
export class DexieSignalStore implements StorageType {
  async getIdentityKeyPair(): Promise<KeyPairType | undefined> {
    const row = await db.signalIdentity.get('self');
    if (!row) return undefined;
    return {
      pubKey: base64ToBuffer(row.identityKeyPub),
      privKey: base64ToBuffer(row.identityKeyPriv),
    };
  }

  async getLocalRegistrationId(): Promise<number | undefined> {
    const row = await db.signalIdentity.get('self');
    return row?.registrationId;
  }

  async saveIdentityKeyPair(keyPair: KeyPairType, registrationId: number): Promise<void> {
    await db.signalIdentity.put({
      id: 'self',
      identityKeyPub: bufferToBase64(keyPair.pubKey),
      identityKeyPriv: bufferToBase64(keyPair.privKey),
      registrationId,
    });
  }

  /**
   * Always trusted. A changed key is accepted, because refusing would let anyone break a
   * conversation by reinstalling (and libsignal throws on false, which would turn a key change
   * into undecryptable messages). The warning the user sees is raised per account by
   * IdentityTrust, which is the part that makes E2EE auditable.
   *
   * <p>Note libsignal passes the bare address name here but the full "name.id" to saveIdentity,
   * so a lookup keyed on {@code identifier} would never match a stored row anyway.
   */
  async isTrustedIdentity(
    _identifier: string,
    _identityKey: ArrayBuffer,
    _direction: Direction,
  ): Promise<boolean> {
    return true;
  }

  async saveIdentity(encodedAddress: string, publicKey: ArrayBuffer): Promise<boolean> {
    const encoded = bufferToBase64(publicKey);
    const existing = await db.signalRemoteIdentities.get(encodedAddress);

    if (!existing) {
      await db.signalRemoteIdentities.put({
        address: encodedAddress,
        identityKey: encoded,
        verified: false,
        firstSeenAt: Date.now(),
      });
      return false;
    }

    if (existing.identityKey === encoded) {
      return false;
    }

    // Key change: store the new key and drop the verified flag. The return value of true tells
    // libsignal the identity changed, which the caller surfaces to the user.
    await db.signalRemoteIdentities.put({
      address: encodedAddress,
      identityKey: encoded,
      verified: false,
      firstSeenAt: existing.firstSeenAt,
    });
    return true;
  }

  async loadPreKey(keyId: string | number): Promise<KeyPairType | undefined> {
    const row = await db.signalPreKeys.get(Number(keyId));
    return row ? { pubKey: base64ToBuffer(row.pubKey), privKey: base64ToBuffer(row.privKey) } : undefined;
  }

  async storePreKey(keyId: string | number, keyPair: KeyPairType): Promise<void> {
    await db.signalPreKeys.put({
      keyId: Number(keyId),
      pubKey: bufferToBase64(keyPair.pubKey),
      privKey: bufferToBase64(keyPair.privKey),
    });
  }

  async removePreKey(keyId: string | number): Promise<void> {
    // A one-time prekey is deleted the moment it is used. Keeping it would mean a replayed
    // session setup could reuse the same key, which is the one thing it must never do.
    await db.signalPreKeys.delete(Number(keyId));
  }

  async loadSignedPreKey(keyId: string | number): Promise<KeyPairType | undefined> {
    const row = await db.signalSignedPreKeys.get(Number(keyId));
    return row ? { pubKey: base64ToBuffer(row.pubKey), privKey: base64ToBuffer(row.privKey) } : undefined;
  }

  async storeSignedPreKey(keyId: string | number, keyPair: KeyPairType): Promise<void> {
    await db.signalSignedPreKeys.put({
      keyId: Number(keyId),
      pubKey: bufferToBase64(keyPair.pubKey),
      privKey: bufferToBase64(keyPair.privKey),
    });
  }

  async removeSignedPreKey(keyId: string | number): Promise<void> {
    await db.signalSignedPreKeys.delete(Number(keyId));
  }

  async loadSession(encodedAddress: string): Promise<string | undefined> {
    const row = await db.signalSessions.get(encodedAddress);
    return row?.record;
  }

  async storeSession(encodedAddress: string, record: string): Promise<void> {
    await db.signalSessions.put({ address: encodedAddress, record });
  }

  async removeSession(encodedAddress: string): Promise<void> {
    await db.signalSessions.delete(encodedAddress);
  }

  async hasSession(encodedAddress: string): Promise<boolean> {
    return (await db.signalSessions.get(encodedAddress)) !== undefined;
  }
}

export const signalStore = new DexieSignalStore();
