import { v7 as uuidv7 } from 'uuid';
import { db, SYSTEM_IDENTITY_CHANGED, type ContactTrustRow } from '@/db/db';

/**
 * Per-account trust: which identity keys we have actually used for a contact, whether the user
 * has verified them, and the "security code changed" notice when that set grows.
 *
 * <p>Device ids are minted per login, so a reinstall shows up as a <em>new device</em> with a new
 * key rather than a changed key on a known address. Tracking the account's key set catches both.
 */
export const identityTrust = {
  /**
   * Called with the complete key set for an account, right after every one of its devices has a
   * session. The first call is trust-on-first-use. Afterwards, any key we have not seen before
   * is a change the user must be told about; a key disappearing (a device logged out) is not.
   */
  async observeAccount(userId: string, identityKeys: string[]): Promise<void> {
    const keys = normalise(identityKeys);
    const known = await db.contactTrust.get(userId);
    if (!known) {
      await db.contactTrust.put({ userId, knownKeys: keys, verified: false });
      return;
    }
    const added = keys.filter((key) => !known.knownKeys.includes(key));
    if (added.length > 0) {
      await recordChange(known, keys);
    } else if (keys.length !== known.knownKeys.length) {
      await db.contactTrust.update(userId, { knownKeys: keys });
    }
  },

  /**
   * Called after a successful decrypt. We only know one device here, so this can add a key but
   * never establish the baseline -- that waits for {@link observeAccount}, or a contact with two
   * devices who messages first would look like a key change.
   */
  async observeDevice(userId: string, identityKey: string): Promise<void> {
    const known = await db.contactTrust.get(userId);
    if (!known || known.knownKeys.includes(identityKey)) return;
    await recordChange(known, normalise([...known.knownKeys, identityKey]));
  },

  async setVerified(userId: string, verified: boolean): Promise<void> {
    const known = await db.contactTrust.get(userId);
    if (!known) throw new Error('No keys known for this contact yet');
    await db.contactTrust.update(userId, {
      verified,
      verifiedAt: verified ? Date.now() : undefined,
    });
  },
};

function normalise(keys: string[]): string[] {
  return [...new Set(keys)].sort();
}

/**
 * Clears verification and drops a notice into every conversation with this person, so the
 * change is visible wherever they are talking to them -- including groups.
 */
async function recordChange(known: ContactTrustRow, keys: string[]): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', db.contactTrust, db.conversations, db.messages, async () => {
    await db.contactTrust.put({
      ...known,
      knownKeys: keys,
      verified: false,
      verifiedAt: undefined,
      lastChangedAt: now,
    });

    const conversations = await db.conversations
      .filter((c) => c.participantIds.includes(known.userId))
      .toArray();
    for (const conversation of conversations) {
      await db.messages.put({
        clientMessageId: uuidv7(),
        conversationId: conversation.id,
        senderId: known.userId,
        seq: conversation.lastSeq + 0.5,
        body: '',
        contentType: SYSTEM_IDENTITY_CHANGED,
        state: 'READ',
        createdAt: now,
      });
    }
  });
}
