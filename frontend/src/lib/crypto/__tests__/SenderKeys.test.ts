import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/db';
import { MissingSenderKeyError, senderKeys } from '../SenderKeys';

const GROUP = 'group-1';
// Sender and receiver share one fake IndexedDB here. That works because our own key lives in
// ownSenderKeys and keys we have received live in senderKeys, keyed by the sending device.
const ALICE_DEVICE = 'alice-device';

async function aliceSends(text: string) {
  return senderKeys.encrypt(GROUP, text);
}

describe('sender keys', () => {
  beforeEach(async () => {
    await db.wipe();
  });

  it('lets a member holding the distribution read every later message', async () => {
    const first = await aliceSends('one');
    await senderKeys.process(ALICE_DEVICE, first.distribution);
    const second = await aliceSends('two');

    expect(await senderKeys.decrypt(GROUP, ALICE_DEVICE, first.groupCiphertext)).toBe('one');
    expect(await senderKeys.decrypt(GROUP, ALICE_DEVICE, second.groupCiphertext)).toBe('two');
  });

  it('decrypts messages that arrive out of order', async () => {
    const m1 = await aliceSends('one');
    await senderKeys.process(ALICE_DEVICE, m1.distribution);
    const m2 = await aliceSends('two');
    const m3 = await aliceSends('three');

    expect(await senderKeys.decrypt(GROUP, ALICE_DEVICE, m3.groupCiphertext)).toBe('three');
    expect(await senderKeys.decrypt(GROUP, ALICE_DEVICE, m1.groupCiphertext)).toBe('one');
    expect(await senderKeys.decrypt(GROUP, ALICE_DEVICE, m2.groupCiphertext)).toBe('two');
  });

  it('refuses to decrypt the same message twice', async () => {
    const m1 = await aliceSends('one');
    await senderKeys.process(ALICE_DEVICE, m1.distribution);
    await senderKeys.decrypt(GROUP, ALICE_DEVICE, m1.groupCiphertext);

    await expect(senderKeys.decrypt(GROUP, ALICE_DEVICE, m1.groupCiphertext)).rejects.toThrow();
  });

  it('cannot read messages sent before the key was handed over', async () => {
    const early = await aliceSends('before you joined');
    const later = await aliceSends('after');
    await senderKeys.process(ALICE_DEVICE, later.distribution);

    await expect(
      senderKeys.decrypt(GROUP, ALICE_DEVICE, early.groupCiphertext),
    ).rejects.toThrow();
    expect(await senderKeys.decrypt(GROUP, ALICE_DEVICE, later.groupCiphertext)).toBe('after');
  });

  it('rejects a tampered message without advancing the chain', async () => {
    const m1 = await aliceSends('genuine');
    await senderKeys.process(ALICE_DEVICE, m1.distribution);

    const wire = JSON.parse(atob(m1.groupCiphertext));
    const tampered = btoa(JSON.stringify({ ...wire, ct: btoa('x'.repeat(24)) }));
    await expect(senderKeys.decrypt(GROUP, ALICE_DEVICE, tampered)).rejects.toThrow(/signature/);

    expect(await senderKeys.decrypt(GROUP, ALICE_DEVICE, m1.groupCiphertext)).toBe('genuine');
  });

  it('rejects a message whose signature was not made by the sender', async () => {
    const m1 = await aliceSends('hello');
    await senderKeys.process(ALICE_DEVICE, m1.distribution);

    const wire = JSON.parse(atob(m1.groupCiphertext));
    const sig = Uint8Array.from(atob(wire.sig), (c) => c.charCodeAt(0));
    sig[0] ^= 0xff;
    const forged = btoa(JSON.stringify({ ...wire, sig: btoa(String.fromCharCode(...sig)) }));

    await expect(senderKeys.decrypt(GROUP, ALICE_DEVICE, forged)).rejects.toThrow(/signature/);
  });

  it('binds a ciphertext to its group', async () => {
    const m1 = await aliceSends('for group one');
    await senderKeys.process(ALICE_DEVICE, { ...m1.distribution, groupId: 'group-2' });

    await expect(
      senderKeys.decrypt('group-2', ALICE_DEVICE, m1.groupCiphertext),
    ).rejects.toThrow();
  });

  it('reports a key it was never given as missing', async () => {
    const m1 = await aliceSends('hello');
    await expect(
      senderKeys.decrypt(GROUP, ALICE_DEVICE, m1.groupCiphertext),
    ).rejects.toBeInstanceOf(MissingSenderKeyError);
  });

  it('shuts out a holder of the old key after rotation', async () => {
    const before = await aliceSends('before');
    await senderKeys.process(ALICE_DEVICE, before.distribution);

    await senderKeys.rotate(GROUP);
    const after = await aliceSends('after');

    expect(after.distribution.keyId).not.toBe(before.distribution.keyId);
    expect(after.sharedWith).toEqual([]);
    await expect(
      senderKeys.decrypt(GROUP, ALICE_DEVICE, after.groupCiphertext),
    ).rejects.toBeInstanceOf(MissingSenderKeyError);
  });

  it('does not let a stale distribution rewind a chain already advanced', async () => {
    const m1 = await aliceSends('one');
    await senderKeys.process(ALICE_DEVICE, m1.distribution);
    await senderKeys.decrypt(GROUP, ALICE_DEVICE, m1.groupCiphertext);

    await senderKeys.process(ALICE_DEVICE, m1.distribution); // replayed handoff
    await expect(senderKeys.decrypt(GROUP, ALICE_DEVICE, m1.groupCiphertext)).rejects.toThrow();
  });

  it('records shared devices only for the current key', async () => {
    const m1 = await aliceSends('one');
    await senderKeys.markShared(GROUP, m1.distribution.keyId, ['bob-device']);
    expect((await aliceSends('two')).sharedWith).toEqual(['bob-device']);

    await senderKeys.markShared(GROUP, m1.distribution.keyId + 1, ['stale']);
    expect((await aliceSends('three')).sharedWith).toEqual(['bob-device']);
  });
});
