import { beforeEach, describe, expect, it } from 'vitest';
import { db, SYSTEM_IDENTITY_CHANGED } from '@/db/db';
import { identityTrust } from '../IdentityTrust';

const BOB = 'bob';

async function notices() {
  return db.messages.filter((m) => m.contentType === SYSTEM_IDENTITY_CHANGED).toArray();
}

describe('identity trust', () => {
  beforeEach(async () => {
    await db.wipe();
    await db.conversations.put({
      id: 'direct-bob',
      type: 'DIRECT',
      participantIds: ['me', BOB],
      lastSeq: 7,
      unreadCount: 0,
      lastReadSeq: 0,
      pinned: false,
      archived: false,
    });
  });

  it('trusts the first key set it sees without raising a notice', async () => {
    await identityTrust.observeAccount(BOB, ['k1', 'k2']);
    expect(await notices()).toHaveLength(0);
    expect((await db.contactTrust.get(BOB))?.knownKeys).toEqual(['k1', 'k2']);
  });

  it('flags a new key, clears verification and drops a notice after the last message', async () => {
    await identityTrust.observeAccount(BOB, ['k1']);
    await identityTrust.setVerified(BOB, true);

    await identityTrust.observeAccount(BOB, ['k1', 'k2']);

    expect((await db.contactTrust.get(BOB))?.verified).toBe(false);
    const [notice] = await notices();
    expect(notice.conversationId).toBe('direct-bob');
    expect(notice.seq).toBe(7.5);
  });

  it('stays quiet when a device merely disappears', async () => {
    await identityTrust.observeAccount(BOB, ['k1', 'k2']);
    await identityTrust.observeAccount(BOB, ['k1']);
    expect(await notices()).toHaveLength(0);
  });

  it('does not set a baseline from a single decrypted device', async () => {
    await identityTrust.observeDevice(BOB, 'k2');
    await identityTrust.observeAccount(BOB, ['k1', 'k2']);
    expect(await notices()).toHaveLength(0);
  });
});
