/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** SPKI base64 of the sender-certificate key; pins sealed sender's trust root at build time. */
  readonly VITE_SEALED_TRUST_ROOT?: string;
}
