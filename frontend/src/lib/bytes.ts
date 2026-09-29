/**
 * Conversions between the three byte representations this app juggles:
 * ArrayBuffer (what libsignal speaks), binary strings (what its ciphertexts come out as)
 * and base64 (what the wire and IndexedDB hold).
 */

export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // Chunked so a large buffer cannot blow the argument limit on String.fromCharCode.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** libsignal's SessionCipher.encrypt returns its body as a latin1 binary string. */
export function binaryStringToBase64(binary: string): string {
  return btoa(binary);
}

export function base64ToBinaryString(base64: string): string {
  return atob(base64);
}

export function utf8ToBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

export function bufferToUtf8(buffer: ArrayBuffer): string {
  return new TextDecoder().decode(buffer);
}
