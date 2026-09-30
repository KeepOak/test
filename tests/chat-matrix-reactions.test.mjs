import test from 'node:test';
import assert from 'node:assert/strict';
import { MatrixAdapter } from '../dist/channels/matrix.js';
const room = '!room:matrix.test', other = '!other:matrix.test';
function world() {
  const calls = []; let next = 1, failRedact = 0, slowRedact = false;
  const adapter = new MatrixAdapter({ id: 'matrix', homeserver: 'https://matrix.test', accessToken: 'stand-in-token',
    userId: '@branch:matrix.test', fetch: async (url, options) => {
      const path = new URL(url).pathname, body = JSON.parse(options.body);
      calls.push({ path, body, headers: options.headers });
      if (path.includes('/redact/') && slowRedact) return new Response(JSON.stringify({ retry_after_ms: 2000 }), { status: 429 });
      if (path.includes('/redact/') && failRedact-- > 0) return new Response('{}', { status: 500 });
      return new Response(JSON.stringify({ event_id: `$made${next++}:matrix.test` }), { status: 200 });
    } });
  const incoming = (roomId, eventId = '$original:matrix.test') => adapter.inbound(roomId,
    { type: 'm.room.message', event_id: eventId, sender: '@owner:matrix.test', content: { msgtype: 'm.text', body: 'Hello Branch' } });
  return { adapter, calls, incoming, fail: () => failRedact = 1, slow: value => slowRedact = value };
}
test('Matrix reacts to the real inbound event and redacts its own previous status before replacing it', async () => {
  const w = world(), message = w.incoming(room);
  await w.adapter.react(message.chatId, message.messageId, '👀');
  assert.match(w.calls[0].path, /\/send\/m.reaction\//);
  assert.deepEqual(w.calls[0].body, { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$original:matrix.test', key: '👀' } });
  assert.equal(w.calls[0].headers.authorization, 'Bearer stand-in-token');
  await w.adapter.react(message.chatId, message.messageId, '👀'); assert.equal(w.calls.length, 1);
  await w.adapter.react(message.chatId, message.messageId, '👍', '👀');
  assert.match(w.calls[1].path, /\/redact\/%24made1%3Amatrix.test\//);
  assert.match(w.calls[2].path, /\/send\/m.reaction\//);
  assert.equal(w.calls[2].body['m.relates_to'].key, '👍');
});
test('Matrix refuses guessed, unsourced or other-room handles before any network action', async () => {
  const w = world(), message = w.incoming(room);
  await assert.rejects(w.adapter.react(other, message.messageId, '👀'), /not in this room/);
  await assert.rejects(w.adapter.react(message.chatId, '$forged', '👀'), /not in this room/);
  const missing = w.incoming(room, null);
  await assert.rejects(w.adapter.react(missing.chatId, missing.messageId, '👀'), /not in this room/);
  assert.equal(w.calls.length, 0);
});
test('a failed or rate-limited redaction leaves the prior reaction tracked for a later retry', async () => {
  const w = world(), message = w.incoming(room);
  await w.adapter.react(message.chatId, message.messageId, '👀');
  w.fail(); await assert.rejects(w.adapter.react(message.chatId, message.messageId, '🤔'), /refused/);
  assert.equal(w.calls.length, 2);
  w.slow(true); await assert.rejects(w.adapter.react(message.chatId, message.messageId, '🤔'), error => error.retryAfter === 2);
  assert.equal(w.calls.length, 3);
  w.slow(false); await w.adapter.react(message.chatId, message.messageId, '🤔');
  assert.equal(w.calls.length, 5);
  assert.match(w.calls[3].path, /\/redact\/%24made1%3Amatrix.test\//);
});
test('CHAT-169: a Matrix thread is its own conversation, and replies, quotes and edits stay inside it', async () => {
  const w = world(), root = '$root:matrix.test';
  const threaded = w.adapter.inbound(room, { type: 'm.room.message', event_id: '$inthread:matrix.test', sender: '@owner:matrix.test',
    content: { msgtype: 'm.text', body: 'In the thread', 'm.relates_to': { rel_type: 'm.thread', event_id: root } } });
  const plain = w.incoming(room);
  assert.match(threaded.chatId, /^thread:[0-9a-f]{32}$/);
  assert.notEqual(threaded.chatId, plain.chatId, 'the thread is not the room');
  assert.equal(w.incoming(room, '$again:matrix.test').chatId, plain.chatId, 'room messages keep their address');
  // A reply in the thread goes into the thread and quotes the person's own message there.
  const sent = await w.adapter.send(threaded.chatId, 'Answer', threaded.messageId);
  assert.deepEqual(w.calls[0].body['m.relates_to'], { rel_type: 'm.thread', event_id: root, is_falling_back: false,
    'm.in_reply_to': { event_id: '$inthread:matrix.test' } });
  // A room reply never quotes a message from the thread, and stays out of it.
  await w.adapter.send(plain.chatId, 'Room answer', threaded.messageId);
  assert.equal(w.calls[1].body['m.relates_to'], undefined);
  // An edit keeps its m.replace relation; one aimed from another conversation is refused before any network call.
  await w.adapter.edit(threaded.chatId, sent, 'Answer, better');
  assert.equal(w.calls[2].body['m.relates_to'].rel_type, 'm.replace');
  await assert.rejects(w.adapter.edit(plain.chatId, sent, 'x'), /not sent in this conversation/);
  await assert.rejects(w.adapter.deleteMessage(plain.chatId, sent), /not sent in this conversation/);
  await assert.rejects(w.adapter.react(plain.chatId, threaded.messageId, '👀'), /not in this thread/);
  assert.equal(w.calls.length, 3);
});
test('CHAT-169: a thread not read since the adapter started is refused, not sent to the room', async () => {
  const w = world();
  await assert.rejects(w.adapter.send('thread:0123456789abcdef0123456789abcdef', 'Hello'), /has not been read since reconnecting/);
  assert.equal(w.calls.length, 0);
});
