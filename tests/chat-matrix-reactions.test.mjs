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
