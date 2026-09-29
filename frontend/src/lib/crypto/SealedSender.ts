import signalFactory from '@privacyresearch/libsignal-protocol-typescript';
import { getMeta, setMeta } from '@/db/db';
import { api } from '@/lib/api';
import { base64ToBuffer, bufferToBase64, bufferToUtf8, utf8ToBuffer } from '@/lib/bytes';
import { signalStore } from './DexieSignalStore';

/**
 * Sealed sender: 1:1 messages the server delivers without knowing who sent them (Signal's design,
 * simplified where the simplification does not weaken it).
 *
 * <p>An envelope for one recipient device is built like this:
 * <ol>
 *   <li>The content is Signal-encrypted to that device as usual (the inner ciphertext).</li>
 *   <li>A fresh ephemeral X25519 key is agreed with the device's identity key, and HKDF turns the
 *       shared secret into an AES-256-GCM key.</li>
 *   <li>That key encrypts {sender certificate, inner ciphertext}. The ephemeral public key goes
 *       in the clear and is also the associated data.</li>
 * </ol>
 * The server sees an ephemeral key and a blob. Only the recipient device can open it; inside,
 * the server-signed certificate says who sent it, and decrypting the inner Signal message proves
 * it: a certificate is only accepted when its identity key is the one the Signal session with
 * that device is bound to. Signal adds a second, static-static layer that binds the certificate
 * before decryption; here the session check after decryption does the same job, because a
 * ratchet message cannot be decrypted by anyone else's session.
 */

export interface SenderCertificate {
  /** base64 of the signed JSON bytes */
  certificate: string;
  /** base64 ECDSA P-256 raw r||s */
  signature: string;
  expiresAt: number;
}

interface CertificateBody {
  userId: string;
  deviceId: string;
  identityKey: string;
  expires: number;
}

/** What the recipient learns from a sealed envelope, once it checks out. */
export interface Unsealed {
  senderUserId: string;
  senderDeviceId: string;
  /** The identity key the certificate vouches for; the caller checks it against the session. */
  identityKey: string;
  cipherType: number;
  ciphertext: string;
}

interface Envelope {
  v: 1;
  /** ephemeral public key, base64 (33 bytes, libsignal's 0x05-prefixed form) */
  e: string;
  iv: string;
  c: string;
}

interface Sealed {
  certificate: string;
  signature: string;
  type: number;
  body: string;
}

const HKDF_INFO = 'ChatterSealedSender v1';
const CERTIFICATE_KEY = 'senderCertificate';
const TRUST_ROOT_KEY = 'sealedTrustRoot';
const OWN_ACCESS_KEY = 'ownAccessKey';
/** Renew this long before expiry, so a send never goes out with a certificate about to lapse. */
const RENEW_BEFORE_MS = 60 * 60 * 1000;
/** Clocks drift; the server's delivery time is compared against expiry with this much grace. */
const EXPIRY_GRACE_MS = 5 * 60 * 1000;

let curvePromise: ReturnType<typeof signalFactory> | null = null;
function curve() {
  curvePromise ??= signalFactory();
  return curvePromise.then((lib) => lib.Curve);
}

function concat(...parts: ArrayBuffer[]): ArrayBuffer {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(new Uint8Array(part), offset);
    offset += part.byteLength;
  }
  return out.buffer;
}

async function envelopeKey(shared: ArrayBuffer, ephemeralPub: ArrayBuffer, recipientPub: ArrayBuffer): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: concat(ephemeralPub, recipientPub), info: utf8ToBuffer(HKDF_INFO) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * The key certificates are checked against. A production build pins it at build time
 * (VITE_SEALED_TRUST_ROOT); without that, it is trusted on first use and then never re-fetched,
 * so a server that later swaps it cannot quietly start vouching for forged senders.
 */
async function trustRoot(): Promise<CryptoKey> {
  let spki = import.meta.env.VITE_SEALED_TRUST_ROOT || (await getMeta<string>(TRUST_ROOT_KEY));
  if (!spki) {
    spki = (await api.sealedTrustRoot()).publicKey;
    await setMeta(TRUST_ROOT_KEY, spki);
    console.warn('[sealed] trust root pinned on first use; set VITE_SEALED_TRUST_ROOT to pin it at build time');
  }
  return crypto.subtle.importKey('spki', base64ToBuffer(spki), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

export const sealedSender = {
  /** This device's certificate, renewed when it gets close to expiry. */
  async certificate(): Promise<SenderCertificate> {
    const cached = await getMeta<SenderCertificate>(CERTIFICATE_KEY);
    if (cached && cached.expiresAt - Date.now() > RENEW_BEFORE_MS) return cached;
    const fresh = await api.senderCertificate();
    await setMeta(CERTIFICATE_KEY, fresh);
    return fresh;
  },

  /**
   * The account's access key: fetched from the server so every linked device shares the same one,
   * and created by whichever device finds none.
   */
  async refreshOwnAccessKey(): Promise<string> {
    try {
      const { accessKey } = await api.ownAccessKey();
      await setMeta(OWN_ACCESS_KEY, accessKey);
      return accessKey;
    } catch {
      return this.rotateAccessKey();
    }
  },

  /** Cached copy, for putting into outgoing messages without a round trip each time. */
  async ownAccessKey(): Promise<string | undefined> {
    return getMeta<string>(OWN_ACCESS_KEY);
  },

  /**
   * A new key invalidates every copy anyone holds. Used on block: the blocked person's sealed
   * sends start failing, they fall back to identified sends, and those the server can refuse.
   * Everyone else learns the new key from our next message to them.
   */
  async rotateAccessKey(): Promise<string> {
    const accessKey = bufferToBase64(crypto.getRandomValues(new Uint8Array(16)).buffer);
    await api.setOwnAccessKey(accessKey);
    await setMeta(OWN_ACCESS_KEY, accessKey);
    return accessKey;
  },

  async peerAccessKey(userId: string): Promise<string | undefined> {
    return getMeta<string>(`ak:${userId}`);
  },

  async rememberPeerAccessKey(userId: string, accessKey: string | undefined): Promise<void> {
    if (!accessKey || (await this.peerAccessKey(userId)) === accessKey) return;
    await setMeta(`ak:${userId}`, accessKey);
  },

  /** The server said no: this copy is stale (or they blocked us). Send identified until we learn a new one. */
  async forgetPeerAccessKey(userId: string): Promise<void> {
    await setMeta(`ak:${userId}`, undefined);
  },

  /** Wraps one device's Signal ciphertext so only that device can see who it is from. */
  async seal(
    recipientIdentityKey: string,
    certificate: SenderCertificate,
    cipherType: number,
    ciphertext: string,
  ): Promise<string> {
    const lib = await curve();
    const ephemeral = lib.generateKeyPair();
    const recipientPub = base64ToBuffer(recipientIdentityKey);
    const shared = lib.calculateAgreement(recipientPub, ephemeral.privKey);
    const key = await envelopeKey(shared, ephemeral.pubKey, recipientPub);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const content: Sealed = {
      certificate: certificate.certificate,
      signature: certificate.signature,
      type: cipherType,
      body: ciphertext,
    };
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: ephemeral.pubKey },
      key,
      utf8ToBuffer(JSON.stringify(content)),
    );
    const envelope: Envelope = {
      v: 1,
      e: bufferToBase64(ephemeral.pubKey),
      iv: bufferToBase64(iv.buffer),
      c: bufferToBase64(sealed),
    };
    return bufferToBase64(utf8ToBuffer(JSON.stringify(envelope)));
  },

  /**
   * Opens an envelope addressed to this device and checks the certificate: server-signed, and
   * not expired when the server accepted the message. The caller must still decrypt the inner
   * message with the named device's session and compare identity keys.
   *
   * @param deliveredAt the server's timestamp, not ours: the recipient's clock may be anything
   */
  async unseal(sealedBase64: string, deliveredAt: number): Promise<Unsealed> {
    const envelope = JSON.parse(bufferToUtf8(base64ToBuffer(sealedBase64))) as Envelope;
    if (envelope.v !== 1) throw new Error(`Unsupported sealed envelope version ${String(envelope.v)}`);

    const self = await signalStore.getIdentityKeyPair();
    if (!self) throw new Error('This device has no identity key');
    const ephemeralPub = base64ToBuffer(envelope.e);
    const lib = await curve();
    const shared = lib.calculateAgreement(ephemeralPub, self.privKey);
    const key = await envelopeKey(shared, ephemeralPub, self.pubKey);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBuffer(envelope.iv), additionalData: ephemeralPub },
      key,
      base64ToBuffer(envelope.c),
    );
    const content = JSON.parse(bufferToUtf8(plaintext)) as Sealed;

    const certificateBytes = base64ToBuffer(content.certificate);
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      await trustRoot(),
      base64ToBuffer(content.signature),
      certificateBytes,
    );
    if (!valid) throw new Error('Sender certificate signature is invalid');
    const body = JSON.parse(bufferToUtf8(certificateBytes)) as CertificateBody;
    if (body.expires + EXPIRY_GRACE_MS < deliveredAt) throw new Error('Sender certificate had expired');

    return {
      senderUserId: body.userId,
      senderDeviceId: body.deviceId,
      identityKey: body.identityKey,
      cipherType: content.type,
      ciphertext: content.body,
    };
  },
};
