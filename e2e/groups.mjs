/**
 * End-to-end proof for groups (LLD step 11): membership and roles, sender-key fan-out, the
 * server-authored timeline events, invite links, and -- most importantly -- that someone who
 * leaves stops receiving the group's traffic.
 *
 * Group ciphertexts here are opaque bytes. The server must never interpret them, so routing and
 * permissions can be proven without the browser's sender-key implementation (which has its own
 * unit tests in frontend/src/lib/crypto/__tests__).
 */
import { check, connect, envelope, failureCount, http, signUp } from './lib.mjs';

const opaque = (label) => Buffer.from(`opaque:${label}`).toString('base64');

/** The HTTP status of a request expected to fail, or 'ok' if it did not. */
async function statusOf(promise) {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return Number(/-> (\d{3})/.exec(error.message)?.[1] ?? 0);
  }
}

const isEvent = (kind, conversationId) => (f) =>
  f.type === 'MESSAGE' &&
  f.payload.conversationId === conversationId &&
  f.payload.encoding === 'system/v1' &&
  JSON.parse(Buffer.from(f.payload.groupCiphertext, 'base64').toString()).kind === kind;

const isMessage = (messageId) => (f) => f.type === 'MESSAGE' && f.payload.messageId === messageId;

async function main() {
  const stamp = Date.now().toString().slice(-7);
  console.log('\n=== Chatter groups walkthrough ===\n');

  console.log('1. Four users, four sockets');
  const [alice, bob, carol, dave] = await Promise.all([
    signUp(`+1551${stamp}`, 'Alice'),
    signUp(`+1552${stamp}`, 'Bob'),
    signUp(`+1553${stamp}`, 'Carol'),
    signUp(`+1554${stamp}`, 'Dave'),
  ]);
  const [aWs, bWs, cWs, dWs] = await Promise.all([alice, bob, carol, dave].map(connect));
  await Promise.all([aWs, bWs, cWs, dWs].map((ws) => ws.waitFor('CONNECT_OK')));
  check('All four connected', true);

  console.log('\n2. Alice creates a group with Bob and Carol');
  const group = await http('/api/v1/conversations', {
    method: 'POST',
    token: alice.token,
    body: { type: 'GROUP', subject: 'Weekend plans', participantIds: [bob.userId, carol.userId] },
  });
  const roleOf = (g, user) => g.members.find((m) => m.userId === user.userId)?.role;
  check('Group has three members', group.members.length === 3);
  check('Creator is the owner', roleOf(group, alice) === 'OWNER');
  check('Others are plain members', roleOf(group, bob) === 'MEMBER');

  const created = await bWs.waitForMatch(isEvent('CREATED', group.id), 'CREATED event', 45_000);
  check('Members receive a CREATED timeline event', !!created);
  check('The event is sequenced like a message', created.payload.seq >= 1);
  await new Promise((r) => setTimeout(r, 1000));
  check('A non-member receives nothing', !dWs.frames.some((f) => f.payload?.conversationId === group.id));

  console.log('\n3. Sender keys: the first message hands out the key, later ones carry none');
  aWs.send('/app/send', envelope('SEND', {
    clientMessageId: crypto.randomUUID(),
    conversationId: group.id,
    groupCiphertext: opaque('m1'),
    payloads: [bob, carol].map((u) => ({
      recipientUserId: u.userId,
      recipientDeviceId: u.deviceId,
      cipherType: 3,
      ciphertext: opaque(`skdm-for-${u.name}`),
    })),
  }));
  const ack1 = await aWs.waitFor('ACK');
  const m1Bob = await bWs.waitForMatch(isMessage(ack1.payload.messageId), 'm1 at Bob');
  const m1Carol = await cWs.waitForMatch(isMessage(ack1.payload.messageId), 'm1 at Carol');
  check('Bob gets the shared group ciphertext', m1Bob.payload.groupCiphertext === opaque('m1'));
  check('Bob gets only his own key handoff', m1Bob.payload.ciphertext === opaque('skdm-for-Bob'));
  check('Carol gets only hers', m1Carol.payload.ciphertext === opaque('skdm-for-Carol'));

  const secondId = crypto.randomUUID();
  aWs.send('/app/send', envelope('SEND', {
    clientMessageId: secondId,
    conversationId: group.id,
    groupCiphertext: opaque('m2'),
    payloads: [],
  }));
  const ack2 = await aWs.waitForMatch((f) => f.type === 'ACK' && f.payload.clientMessageId === secondId, 'ACK m2');
  const m2Bob = await bWs.waitForMatch(isMessage(ack2.payload.messageId), 'm2 at Bob');
  check('A settled group message carries no pairwise payload', m2Bob.payload.ciphertext === undefined && m2Bob.payload.cipherType === 0);
  check('...but still reaches every member device', m2Bob.payload.groupCiphertext === opaque('m2'));

  console.log('\n4. The server refuses misaddressed sends');
  const nackFor = async (ws, frame) => {
    const id = crypto.randomUUID();
    ws.send('/app/send', envelope('SEND', { clientMessageId: id, ...frame }));
    return ws.waitForMatch((f) => (f.type === 'NACK' || f.type === 'ACK') && f.payload.clientMessageId === id, 'send result');
  };
  const smuggle = await nackFor(aWs, {
    conversationId: group.id,
    groupCiphertext: opaque('leak'),
    payloads: [{ recipientUserId: dave.userId, recipientDeviceId: dave.deviceId, cipherType: 3, ciphertext: opaque('leak') }],
  });
  check('Addressing a non-member device is rejected', smuggle.type === 'NACK', smuggle.type);

  const direct = await http('/api/v1/conversations', {
    method: 'POST', token: alice.token, body: { type: 'DIRECT', participantIds: [bob.userId] },
  });
  const skInDirect = await nackFor(aWs, { conversationId: direct.id, groupCiphertext: opaque('x'), payloads: [] });
  check('Sender-key messages are refused outside groups', skInDirect.type === 'NACK', skInDirect.type);

  console.log('\n5. Roles: only admins manage the group');
  check('A member cannot add people',
    (await statusOf(http(`/api/v1/conversations/${group.id}/members`, {
      method: 'POST', token: bob.token, body: { userIds: [dave.userId] },
    }))) === 403);
  const promoted = await http(`/api/v1/conversations/${group.id}/members/${bob.userId}/role`, {
    method: 'PUT', token: alice.token, body: { role: 'ADMIN' },
  });
  check('Owner promotes Bob to admin', roleOf(promoted, bob) === 'ADMIN');
  await cWs.waitForMatch(isEvent('ROLE_CHANGED', group.id), 'ROLE_CHANGED');
  check('Members see the ROLE_CHANGED event', true);
  check('An admin cannot demote the owner',
    (await statusOf(http(`/api/v1/conversations/${group.id}/members/${alice.userId}/role`, {
      method: 'PUT', token: bob.token, body: { role: 'MEMBER' },
    }))) === 403);

  await http(`/api/v1/conversations/${group.id}/members`, {
    method: 'POST', token: bob.token, body: { userIds: [dave.userId] },
  });
  const added = await dWs.waitForMatch(isEvent('MEMBERS_ADDED', group.id), 'MEMBERS_ADDED at Dave');
  check('The new member is told they were added', !!added);

  console.log('\n6. A new member cannot read what came before');
  dWs.send('/app/sync', envelope('SYNC', { cursors: {}, limit: 500 }));
  const daveSync = await dWs.waitFor('SYNC_PAGE');
  const daveSees = new Set(daveSync.payload.envelopes.map((e) => e.payload.messageId));
  check('History before joining is not delivered', !daveSees.has(ack1.payload.messageId) && !daveSees.has(ack2.payload.messageId));
  check('The join event is', daveSees.has(added.payload.messageId));

  console.log('\n7. Only-admins-can-post');
  await http(`/api/v1/conversations/${group.id}`, {
    method: 'PATCH', token: alice.token, body: { onlyAdminsCanPost: true },
  });
  const carolBlocked = await nackFor(cWs, { conversationId: group.id, groupCiphertext: opaque('c'), payloads: [] });
  check('A member is refused', carolBlocked.type === 'NACK' && carolBlocked.payload.code === 'CONVERSATION_FORBIDDEN',
    JSON.stringify(carolBlocked.payload));
  const bobAllowed = await nackFor(bWs, { conversationId: group.id, groupCiphertext: opaque('b'), payloads: [] });
  check('An admin may still post', bobAllowed.type === 'ACK', bobAllowed.type);
  check('A member cannot flip the setting back',
    (await statusOf(http(`/api/v1/conversations/${group.id}`, {
      method: 'PATCH', token: carol.token, body: { onlyAdminsCanPost: false },
    }))) === 403);
  await http(`/api/v1/conversations/${group.id}`, {
    method: 'PATCH', token: alice.token, body: { onlyAdminsCanPost: false },
  });

  console.log('\n8. Removal cuts a member off');
  await http(`/api/v1/conversations/${group.id}/members/${carol.userId}`, { method: 'DELETE', token: alice.token });
  const removed = await cWs.waitForMatch(isEvent('MEMBER_REMOVED', group.id), 'MEMBER_REMOVED at Carol');
  check('The removed member is told', !!removed);
  const afterId = crypto.randomUUID();
  aWs.send('/app/send', envelope('SEND', {
    clientMessageId: afterId, conversationId: group.id, groupCiphertext: opaque('after-removal'), payloads: [],
  }));
  const ackAfter = await aWs.waitForMatch((f) => f.type === 'ACK' && f.payload.clientMessageId === afterId, 'ACK after removal');
  await bWs.waitForMatch(isMessage(ackAfter.payload.messageId), 'post-removal message at Bob');
  await new Promise((r) => setTimeout(r, 1500));
  check('...and does not receive later messages', !cWs.frames.some(isMessage(ackAfter.payload.messageId)));
  check('...nor can read the group any more',
    (await statusOf(http(`/api/v1/conversations/${group.id}`, { token: carol.token }))) === 403);
  const carolAddressed = await nackFor(aWs, {
    conversationId: group.id, groupCiphertext: opaque('y'),
    payloads: [{ recipientUserId: carol.userId, recipientDeviceId: carol.deviceId, cipherType: 3, ciphertext: opaque('y') }],
  });
  check('...nor be addressed by a stale sender', carolAddressed.type === 'NACK');

  console.log('\n9. Invite links');
  const invite = await http(`/api/v1/conversations/${group.id}/invite`, { method: 'POST', token: alice.token, body: {} });
  const again = await http(`/api/v1/conversations/${group.id}/invite`, { method: 'POST', token: alice.token, body: {} });
  check('One live link per group', invite.code === again.code);
  const preview = await http(`/api/v1/invites/${invite.code}`, { token: carol.token });
  check('Preview shows the subject and size', preview.subject === 'Weekend plans' && preview.memberCount === 3);
  await http(`/api/v1/invites/${invite.code}/join`, { method: 'POST', token: carol.token });
  await aWs.waitForMatch(isEvent('JOINED_VIA_INVITE', group.id), 'JOINED_VIA_INVITE');
  check('Joining by link is announced', true);
  await http(`/api/v1/conversations/${group.id}/invite`, { method: 'DELETE', token: alice.token });
  check('A reset link stops working',
    (await statusOf(http(`/api/v1/invites/${invite.code}`, { token: dave.token }))) === 404);

  console.log('\n10. The owner leaves; the group is handed on');
  await http(`/api/v1/conversations/${group.id}/leave`, { method: 'POST', token: alice.token });
  const afterLeave = await http(`/api/v1/conversations/${group.id}`, { token: bob.token });
  check('The longest-serving admin becomes owner', roleOf(afterLeave, bob) === 'OWNER');
  check('The leaver is gone', !afterLeave.participantIds.includes(alice.userId));

  [aWs, bWs, cWs, dWs].forEach((ws) => ws.client.deactivate());
  console.log(`\n=== ${failureCount() === 0 ? 'ALL CHECKS PASSED' : `${failureCount()} CHECK(S) FAILED`} ===\n`);
  process.exit(failureCount() === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nFATAL:', error.message);
  process.exit(1);
});
