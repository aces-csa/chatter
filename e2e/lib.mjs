/**
 * Shared harness for the end-to-end scripts: sign-up with real Signal keys, a STOMP client, and
 * a pass/fail tally. Point CHATTER_APP / CHATTER_WS / CHATTER_APP_LOG at the stack under test.
 */
import { readFile } from 'node:fs/promises';
import { Client } from '@stomp/stompjs';
import WebSocket from 'ws';
import { KeyHelper } from '@privacyresearch/libsignal-protocol-typescript';

Object.assign(globalThis, { WebSocket });


export const APP = process.env.CHATTER_APP ?? 'http://localhost:8080';
export const WS = process.env.CHATTER_WS ?? 'ws://localhost:8081/ws/websocket';

export const b64 = (buf) => Buffer.from(new Uint8Array(buf)).toString('base64');
export const unb64 = (s) => {
  const b = Buffer.from(s, 'base64');
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
export const binToB64 = (bin) => Buffer.from(bin, 'binary').toString('base64');
export const b64ToBin = (s) => Buffer.from(s, 'base64').toString('binary');
export const enc = (s) => new TextEncoder().encode(s).buffer;
export const dec = (b) => new TextDecoder().decode(b);

let failures = 0;
export function failureCount() {
  return failures;
}

export function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label} ${detail}`);
  }
}

/** Minimal in-memory Signal store, mirroring the browser's Dexie-backed one. */
export function makeStore() {
  const m = new Map();
  let identity;
  let registrationId;
  return {
    setIdentity(kp, rid) {
      identity = kp;
      registrationId = rid;
    },
    async getIdentityKeyPair() {
      return identity;
    },
    async getLocalRegistrationId() {
      return registrationId;
    },
    async isTrustedIdentity() {
      return true;
    },
    async saveIdentity(addr, key) {
      const prev = m.get(`ident:${addr}`);
      m.set(`ident:${addr}`, key);
      return prev !== undefined && b64(prev) !== b64(key);
    },
    async loadPreKey(id) {
      return m.get(`pk:${id}`);
    },
    async storePreKey(id, kp) {
      m.set(`pk:${id}`, kp);
    },
    async removePreKey(id) {
      m.delete(`pk:${id}`);
    },
    async loadSignedPreKey(id) {
      return m.get(`spk:${id}`);
    },
    async storeSignedPreKey(id, kp) {
      m.set(`spk:${id}`, kp);
    },
    async removeSignedPreKey(id) {
      m.delete(`spk:${id}`);
    },
    async loadSession(addr) {
      return m.get(`sess:${addr}`);
    },
    async storeSession(addr, rec) {
      m.set(`sess:${addr}`, rec);
    },
    async removeSession(addr) {
      m.delete(`sess:${addr}`);
    },
    async hasSession(addr) {
      return m.has(`sess:${addr}`);
    },
  };
}

export async function http(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${APP}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

/** Registers a user, generates Signal keys and publishes the public halves. */
export async function signUp(phone, name) {
  const { otpToken } = await http('/api/v1/auth/register', {
    method: 'POST',
    body: { phone },
  });

  // Dev mode prints the OTP to the app log; read it back from there.
  const code = await readOtpFromLog(otpToken);

  const verified = await http('/api/v1/auth/verify', {
    method: 'POST',
    body: { otpToken, code, displayName: name, deviceName: 'e2e', platform: 'node' },
  });

  const store = makeStore();
  const identityKeyPair = await KeyHelper.generateIdentityKeyPair();
  const registrationId = KeyHelper.generateRegistrationId();
  store.setIdentity(identityKeyPair, registrationId);

  const signed = await KeyHelper.generateSignedPreKey(identityKeyPair, 1);
  await store.storeSignedPreKey(signed.keyId, signed.keyPair);

  const oneTime = [];
  for (let i = 1; i <= 5; i += 1) {
    const pk = await KeyHelper.generatePreKey(i);
    await store.storePreKey(pk.keyId, pk.keyPair);
    oneTime.push({ keyId: pk.keyId, publicKey: b64(pk.keyPair.pubKey) });
  }

  await http('/api/v1/keys', {
    method: 'POST',
    token: verified.tokens.accessToken,
    body: {
      identityKey: b64(identityKeyPair.pubKey),
      registrationId,
      signedPreKey: {
        keyId: signed.keyId,
        publicKey: b64(signed.keyPair.pubKey),
        signature: b64(signed.signature),
      },
      oneTimePreKeys: oneTime,
    },
  });

  return {
    userId: verified.user.id,
    deviceId: verified.deviceId,
    token: verified.tokens.accessToken,
    refreshToken: verified.tokens.refreshToken,
    name,
    store,
  };
}

// Dev mode prints the OTP to the app log. Point this at wherever you redirected it.
const LOG = process.env.CHATTER_APP_LOG ?? 'app.log';

async function readOtpFromLog(otpToken) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const text = await readFile(LOG, 'utf8').catch(() => '');
    const match = text.match(new RegExp(`OTP for .* is (\\d{6}) \\(otpToken=${otpToken}\\)`));
    if (match) return match[1];
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Could not find the OTP in the app log');
}

export function connect(user) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const waiters = [];
    const waitUntil = (matches, label, timeoutMs) =>
      new Promise((res, rej) => {
        const existing = frames.find(matches);
        if (existing) return res(existing);
        waiters.push({ matches, resolve: res });
        setTimeout(() => rej(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      });

    const client = new Client({
      brokerURL: WS,
      connectHeaders: { Authorization: `Bearer ${user.token}` },
      heartbeatIncoming: 30000,
      heartbeatOutgoing: 30000,
      reconnectDelay: 0,
      debug: () => {},
      onConnect: () => {
        client.subscribe('/user/queue/events', (msg) => {
          const env = JSON.parse(msg.body);
          frames.push(env);
          for (let i = waiters.length - 1; i >= 0; i -= 1) {
            if (waiters[i].matches(env)) {
              waiters[i].resolve(env);
              waiters.splice(i, 1);
            }
          }
        });
        resolve({
          client,
          frames,
          send: (destination, envelope) =>
            client.publish({ destination, body: JSON.stringify(envelope) }),
          waitFor: (type, timeoutMs = 10000) =>
            waitUntil((f) => f.type === type, type, timeoutMs),
          /** First frame, already received or yet to come, that satisfies the predicate. */
          waitForMatch: (matches, label = 'matching frame', timeoutMs = 10000) =>
            waitUntil(matches, label, timeoutMs),
        });
      },
      onStompError: (f) => reject(new Error(`STOMP error: ${f.headers.message}`)),
    });
    client.activate();
  });
}

export const envelope = (type, payload) => ({ v: 1, type, ts: Date.now(), payload });

