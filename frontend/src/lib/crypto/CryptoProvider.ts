/**
 * Everything cryptographic goes through this interface.
 *
 * <p>The implementation is a community TypeScript port of Signal's protocol, which is correct in
 * construction but does not carry Signal's audit history. This seam exists so it can be swapped
 * for a self-built libsignal WASM bundle without touching a single call site. That is the
 * weakest link in the security story, and it is deliberate, visible and replaceable.
 */
export interface DeviceBundle {
  deviceId: string;
  registrationId: number;
  /** base64 */
  identityKey: string;
  signedPreKey: { keyId: number; publicKey: string; signature: string };
  preKey: { keyId: number; publicKey: string } | null;
}

export interface GeneratedKeys {
  identityKey: string;
  registrationId: number;
  signedPreKey: { keyId: number; publicKey: string; signature: string };
  oneTimePreKeys: Array<{ keyId: number; publicKey: string }>;
}

export interface Ciphertext {
  /** 1 = SignalMessage (established session), 3 = PreKeySignalMessage (session setup). */
  cipherType: number;
  /** base64 */
  ciphertext: string;
}

export interface CryptoProvider {
  /** Generates the identity, signed prekey and an initial batch of one-time prekeys. */
  generateRegistrationKeys(oneTimeCount: number): Promise<GeneratedKeys>;

  /**
   * Extra one-time prekeys for a top-up.
   *
   * @param startId the first id to mint. The caller passes the server's highest known id + 1,
   *   because the local store is not authoritative: it can be cleared or partially written
   *   while the server's copy survives, and reusing an id the server already holds is a
   *   collision the client would otherwise retry forever.
   */
  generateMoreOneTimeKeys(
    count: number,
    startId: number,
  ): Promise<Array<{ keyId: number; publicKey: string }>>;

  hasSession(deviceId: string): Promise<boolean>;

  /** X3DH. Establishes a session against a freshly fetched bundle. */
  establishSession(bundle: DeviceBundle): Promise<void>;

  encrypt(deviceId: string, plaintext: string): Promise<Ciphertext>;

  /** @throws if the session is desynchronised; the caller renders a recoverable placeholder. */
  decrypt(deviceId: string, cipherType: number, ciphertext: string): Promise<string>;

  /** This device's public identity key, base64. */
  localIdentityKey(): Promise<string>;

  /** The identity key we hold for a remote device's session, base64, or undefined if none. */
  remoteIdentityKey(deviceId: string): Promise<string | undefined>;

  /**
   * 60-digit safety number for out-of-band verification, over every device key of each account.
   * Symmetric: both sides compute the same digits from the same two key sets.
   */
  safetyNumber(local: AccountIdentity, remote: AccountIdentity): Promise<string>;
}

export interface AccountIdentity {
  userId: string;
  /** base64 identity keys, one per device; order does not matter. */
  identityKeys: string[];
}
