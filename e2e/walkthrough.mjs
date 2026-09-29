  /**
 * End-to-end proof: two users register, generate real Signal keys, open a conversation, and
 * exchange an encrypted message over the WebSocket gateway. Asserts the plaintext round-trips
 * and that the sender's ticks advance.
 */
import {
  SessionBuilder,
  SessionCipher,
  SignalProtocolAddress,
} from '@privacyresearch/libsignal-protocol-typescript';
import {
  b64ToBin,
  binToB64,
  check,
  connect,
  dec,
  enc,
  envelope,
  failureCount,
  http,
  signUp,
  unb64,
} from './lib.mjs';

async function main() {
  const stamp = Date.now().toString().slice(-8);
  console.log('\n=== Chatter end-to-end walkthrough ===\n');

  console.log('1. Registering two users with real Signal key generation');
  const alice = await signUp(`+1555${stamp}`, 'Alice');
  const bob = await signUp(`+1666${stamp}`, 'Bob');
  check('Alice registered', !!alice.userId);
  check('Bob registered', !!bob.userId);

  console.log('\n2. Opening a direct conversation');
  const conversation = await http('/api/v1/conversations', {
    method: 'POST',
    token: alice.token,
    body: { type: 'DIRECT', participantIds: [bob.userId] },
  });
  check('Conversation created', !!conversation.id);

  // Determinism check: the same pair must resolve to the same conversation, from either side.
  const again = await http('/api/v1/conversations', {
    method: 'POST',
    token: bob.token,
    body: { type: 'DIRECT', participantIds: [alice.userId] },
  });
  check('Direct conversation id is deterministic', again.id === conversation.id,
    `${again.id} vs ${conversation.id}`);

  console.log('\n3. Connecting both clients to the gateway');
  const aliceWs = await connect(alice);
  const bobWs = await connect(bob);
  await aliceWs.waitFor('CONNECT_OK');
  await bobWs.waitFor('CONNECT_OK');
  check('Both sockets authenticated', true);

  console.log('\n4. Alice builds a Signal session with Bob and encrypts');
  const bundles = await http(`/api/v1/keys/${bob.userId}/bundle`, { token: alice.token });
  check('Bob published a prekey bundle', bundles.devices.length === 1);
  check('Bundle includes a one-time prekey', bundles.devices[0].preKey !== null);

  const bobBundle = bundles.devices[0];
  const bobAddress = new SignalProtocolAddress(bob.deviceId, 1);
  await new SessionBuilder(alice.store, bobAddress).processPreKey({
    identityKey: unb64(bobBundle.identityKey),
    registrationId: bobBundle.registrationId,
    signedPreKey: {
      keyId: bobBundle.signedPreKey.keyId,
      publicKey: unb64(bobBundle.signedPreKey.publicKey),
      signature: unb64(bobBundle.signedPreKey.signature),
    },
    preKey: bobBundle.preKey
      ? { keyId: bobBundle.preKey.keyId, publicKey: unb64(bobBundle.preKey.publicKey) }
      : undefined,
  });

  const PLAINTEXT = 'Meet me at 8 — this must survive the round trip intact. 🔐';
  const inner = JSON.stringify({ contentType: 'text/plain', body: PLAINTEXT, sentAt: Date.now() });
  const encrypted = await new SessionCipher(alice.store, bobAddress).encrypt(enc(inner));
  check('Ciphertext is a PreKeySignalMessage (type 3)', encrypted.type === 3, `got ${encrypted.type}`);
  check('Ciphertext differs from plaintext', !encrypted.body.includes('Meet me at 8'));

  console.log('\n5. Sending over the socket');
  const clientMessageId = crypto.randomUUID();
  aliceWs.send(
    '/app/send',
    envelope('SEND', {
      clientMessageId,
      conversationId: conversation.id,
      payloads: [
        {
          recipientUserId: bob.userId,
          recipientDeviceId: bob.deviceId,
          cipherType: encrypted.type,
          ciphertext: binToB64(encrypted.body),
        },
      ],
    }),
  );

  const ack = await aliceWs.waitFor('ACK');
  check('Alice got an ACK (one tick)', ack.payload.clientMessageId === clientMessageId);
  check('ACK carries a sequence number', ack.payload.seq >= 1, `seq=${ack.payload.seq}`);

  console.log('\n6. Bob receives and decrypts');
  // Generous timeout: on a cold start the Kafka consumer group may still be rebalancing, so
  // the first message of a fresh boot can wait on partition assignment before it fans out.
  const delivered = await bobWs.waitFor('MESSAGE', 45_000);
  check('Bob received the message frame', delivered.payload.messageId === ack.payload.messageId);
  check('Frame carries only ciphertext', !JSON.stringify(delivered.payload).includes('Meet me at 8'));

  const bobCipher = new SessionCipher(bob.store, new SignalProtocolAddress(alice.deviceId, 1));
  const plainBuf = await bobCipher.decryptPreKeyWhisperMessage(
    b64ToBin(delivered.payload.ciphertext),
    'binary',
  );
  const decrypted = JSON.parse(dec(plainBuf));
  check('Decrypted plaintext matches exactly', decrypted.body === PLAINTEXT,
    `got "${decrypted.body}"`);

  console.log('\n7. Tick transitions: Bob acknowledges, Alice sees it');
  bobWs.send(
    '/app/receipt',
    envelope('DELIVERED', { conversationId: conversation.id, uptoSeq: delivered.payload.seq }),
  );
  const deliveredReceipt = await aliceWs.waitFor('DELIVERED');
  check('Alice got a DELIVERED receipt (two ticks)',
    deliveredReceipt.payload.uptoSeq === delivered.payload.seq,
    `uptoSeq=${deliveredReceipt.payload.uptoSeq}`);

  bobWs.send(
    '/app/receipt',
    envelope('READ', { conversationId: conversation.id, uptoSeq: delivered.payload.seq }),
  );
  const readReceipt = await aliceWs.waitFor('READ');
  check('Alice got a READ receipt (blue ticks)',
    readReceipt.payload.uptoSeq === delivered.payload.seq);
  check('Receipt names who acknowledged', readReceipt.payload.userId === bob.userId);

  console.log('\n8. Idempotency: replaying the same client message id');
  aliceWs.send(
    '/app/send',
    envelope('SEND', {
      clientMessageId,
      conversationId: conversation.id,
      payloads: [
        {
          recipientUserId: bob.userId,
          recipientDeviceId: bob.deviceId,
          cipherType: encrypted.type,
          ciphertext: binToB64(encrypted.body),
        },
      ],
    }),
  );
  await new Promise((r) => setTimeout(r, 1500));
  const acks = aliceWs.frames.filter((f) => f.type === 'ACK');
  const distinctMessageIds = new Set(acks.map((a) => a.payload.messageId));
  check('Retry produced no duplicate message', distinctMessageIds.size === 1,
    `${distinctMessageIds.size} distinct message ids from ${acks.length} acks`);
  check('Retry returned the original sequence',
    acks.every((a) => a.payload.seq === ack.payload.seq));

  console.log('\n9. Presence: Alice subscribes and sees Bob online');
  aliceWs.send('/app/presence/subscribe', envelope('PRESENCE_SUB', { userIds: [bob.userId] }));
  const presence = await aliceWs.waitFor('PRESENCE');
  check('Alice received a presence frame for Bob', presence.payload.userId === bob.userId);
  check('Bob reads as online while connected', presence.payload.status === 'online',
    `got "${presence.payload.status}"`);

  console.log('\n10. Typing: Bob types, Alice sees it');
  bobWs.send('/app/typing', envelope('TYPING', { conversationId: conversation.id, state: 'start' }));
  const typing = await aliceWs.waitFor('TYPING');
  check('Alice received a typing frame', typing.payload.conversationId === conversation.id);
  check('Typing frame names the sender', typing.payload.userId === bob.userId);
  check('Typing state is start', typing.payload.state === 'start');

  console.log('\n11. Catch-up: a fresh SYNC returns the backlog');
  bobWs.send('/app/sync', envelope('SYNC', { cursors: {}, limit: 100 }));
  const syncPage = await bobWs.waitFor('SYNC_PAGE');
  check('SYNC returned the message', syncPage.payload.envelopes.length >= 1,
    `got ${syncPage.payload.envelopes.length}`);
  check('SYNC uses the same MESSAGE envelope type as live delivery',
    syncPage.payload.envelopes[0]?.type === 'MESSAGE');

  aliceWs.client.deactivate();
  bobWs.client.deactivate();

  console.log(`\n=== ${failureCount() === 0 ? 'ALL CHECKS PASSED' : `${failureCount()} CHECK(S) FAILED`} ===\n`);
  process.exit(failureCount() === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nFATAL:', error.message);
  process.exit(1);
});
