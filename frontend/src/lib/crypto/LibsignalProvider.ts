import {
  FingerprintGenerator,
  KeyHelper,
  SessionBuilder,
  SessionCipher,
  SignalProtocolAddress,
} from '@privacyresearch/libsignal-protocol-typescript';
import { db } from '@/db/db';
import {
  base64ToBinaryString,
  base64ToBuffer,
  binaryStringToBase64,
  bufferToBase64,
  bufferToUtf8,
  utf8ToBuffer,
} from '@/lib/bytes';
import { signalStore } from './DexieSignalStore';
import type {
  AccountIdentity,
  Ciphertext,
  CryptoProvider,
  DeviceBundle,
  GeneratedKeys,
} from './CryptoProvider';

const SIGNED_PREKEY_ID = 1;

/**
 * Our device ids are UUIDs but SignalProtocolAddress wants (name, number). We put the device
 * UUID in the name and pin the numeric part to 1, so the encoded address "<uuid>.1" is unique
 * per device, which is all the protocol needs it to be.
 */
function addressFor(deviceId: string): SignalProtocolAddress {
  return new SignalProtocolAddress(deviceId, 1);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export class LibsignalProvider implements CryptoProvider {
  async generateRegistrationKeys(oneTimeCount: number): Promise<GeneratedKeys> {
    const identityKeyPair = await KeyHelper.generateIdentityKeyPair();
    const registrationId = KeyHelper.generateRegistrationId();

    await signalStore.saveIdentityKeyPair(identityKeyPair, registrationId);

    const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, SIGNED_PREKEY_ID);
    await signalStore.storeSignedPreKey(signedPreKey.keyId, signedPreKey.keyPair);

    const oneTimePreKeys = await this.mintOneTimeKeys(1, oneTimeCount);

    return {
      identityKey: bufferToBase64(identityKeyPair.pubKey),
      registrationId,
      signedPreKey: {
        keyId: signedPreKey.keyId,
        publicKey: bufferToBase64(signedPreKey.keyPair.pubKey),
        signature: bufferToBase64(signedPreKey.signature),
      },
      oneTimePreKeys,
    };
  }

  async generateMoreOneTimeKeys(
    count: number,
    startId: number,
  ): Promise<Array<{ keyId: number; publicKey: string }>> {
    // Take the higher of what the server reports and what we hold locally. The server is
    // authoritative for collisions; the local store guards against handing out an id whose
    // private half we still have but the server has already consumed and forgotten.
    const localHighest = (await db.signalPreKeys.orderBy('keyId').last())?.keyId ?? 0;
    return this.mintOneTimeKeys(Math.max(startId, localHighest + 1), count);
  }

  /**
   * Curve25519 keygen in pure JS is CPU-bound, and a batch of them back to back locks the main
   * thread hard enough that the browser cannot even paint the progress spinner. Yielding after
   * every key caps the longest block at a single keygen; it does not make the work faster, but
   * it keeps the tab alive and the spinner turning.
   *
   * <p>The real fix is a Web Worker. Tracked as a known gap -- this is mitigation, not a cure.
   */
  private async mintOneTimeKeys(
    startId: number,
    count: number,
  ): Promise<Array<{ keyId: number; publicKey: string }>> {
    const generated: Array<{ keyId: number; publicKey: string }> = [];
    for (let i = 0; i < count; i += 1) {
      const preKey = await KeyHelper.generatePreKey(startId + i);
      await signalStore.storePreKey(preKey.keyId, preKey.keyPair);
      generated.push({ keyId: preKey.keyId, publicKey: bufferToBase64(preKey.keyPair.pubKey) });
      await yieldToEventLoop();
    }
    return generated;
  }

  async hasSession(deviceId: string): Promise<boolean> {
    return signalStore.hasSession(addressFor(deviceId).toString());
  }

  async establishSession(bundle: DeviceBundle): Promise<void> {
    const builder = new SessionBuilder(signalStore, addressFor(bundle.deviceId));
    await builder.processPreKey({
      identityKey: base64ToBuffer(bundle.identityKey),
      registrationId: bundle.registrationId,
      signedPreKey: {
        keyId: bundle.signedPreKey.keyId,
        publicKey: base64ToBuffer(bundle.signedPreKey.publicKey),
        signature: base64ToBuffer(bundle.signedPreKey.signature),
      },
      preKey: bundle.preKey
        ? { keyId: bundle.preKey.keyId, publicKey: base64ToBuffer(bundle.preKey.publicKey) }
        : undefined,
    });
  }

  async encrypt(deviceId: string, plaintext: string): Promise<Ciphertext> {
    const cipher = new SessionCipher(signalStore, addressFor(deviceId));
    const message = await cipher.encrypt(utf8ToBuffer(plaintext));
    return {
      cipherType: message.type,
      ciphertext: binaryStringToBase64(message.body ?? ''),
    };
  }

  async decrypt(deviceId: string, cipherType: number, ciphertext: string): Promise<string> {
    const cipher = new SessionCipher(signalStore, addressFor(deviceId));
    const body = base64ToBinaryString(ciphertext);

    // Type 3 carries the session setup; type 1 assumes a session already exists.
    const plaintext =
      cipherType === 3
        ? await cipher.decryptPreKeyWhisperMessage(body, 'binary')
        : await cipher.decryptWhisperMessage(body, 'binary');

    return bufferToUtf8(plaintext);
  }

  async localIdentityKey(): Promise<string> {
    const self = await signalStore.getIdentityKeyPair();
    if (!self) throw new Error('This device has no identity key yet');
    return bufferToBase64(self.pubKey);
  }

  async remoteIdentityKey(deviceId: string): Promise<string | undefined> {
    return (await db.signalRemoteIdentities.get(addressFor(deviceId).toString()))?.identityKey;
  }

  /**
   * Each account has one key per device, but the fingerprint takes one key per side. We feed it
   * the sorted concatenation, so the number covers every device and does not depend on the
   * order either client happened to learn about them in.
   */
  async safetyNumber(local: AccountIdentity, remote: AccountIdentity): Promise<string> {
    if (local.identityKeys.length === 0 || remote.identityKeys.length === 0) {
      throw new Error('Cannot compute a safety number before both identities are known');
    }
    const generator = new FingerprintGenerator(5200);
    return generator.createFor(
      local.userId,
      concatKeys(local.identityKeys),
      remote.userId,
      concatKeys(remote.identityKeys),
    );
  }
}

function concatKeys(keys: string[]): ArrayBuffer {
  const buffers = [...new Set(keys)].sort().map((key) => new Uint8Array(base64ToBuffer(key)));
  const joined = new Uint8Array(buffers.reduce((total, b) => total + b.length, 0));
  let offset = 0;
  for (const buffer of buffers) {
    joined.set(buffer, offset);
    offset += buffer.length;
  }
  return joined.buffer;
}

export const crypto: CryptoProvider = new LibsignalProvider();
