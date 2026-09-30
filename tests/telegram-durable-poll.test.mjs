import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TelegramAdapter, telegramInbox } from '../dist/index.js';

const update = (id) => ({ update_id: id, message: { message_id: id, text: String(id), from: { id: 42, first_name: 'A' }, chat: { id: 42, type: 'private' } } });
async function until(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await delay(10); }
  assert.fail('timed out waiting for poll');
}

test('Telegram is told an update arrived once the inbox saved it; a restart hands over only unfinished work', async (t) => {
  const pending = [update(10), update(11), update(12)];
  const offsets = [];
  let saved = 0;
  const position = { load: () => saved, save: (value) => { saved = value; } };
  // One database file, opened again for the second adapter as Branch would after a restart.
  const dir = mkdtempSync(join(tmpdir(), 'branch-tg-poll-'));
  const opened = [];
  t.after(() => { for (const db of opened) db.close(); rmSync(dir, { recursive: true, force: true }); });
  const store = () => { const db = new DatabaseSync(join(dir, 'inbox.sqlite')); opened.push(db); return { sqlite: db }; };
  const fakeFetch = async (url, init) => {
    const method = url.split('/').pop();
    if (method === 'getMe') return { json: async () => ({ ok: true, result: { id: 1, is_bot: true, username: 'TestBot' } }) };
    assert.equal(method, 'getUpdates');
    const offset = JSON.parse(init.body).offset;
    offsets.push(offset);
    // Telegram deletes all lower updates when it receives this offset, not when the client saves.
    while (pending.length && pending[0].update_id < offset) pending.shift();
    await delay(5);
    return { json: async () => ({ ok: true, result: [...pending] }) };
  };
  const options = () => ({ id: 'telegram', token: 'fake', fetch: fakeFetch, position, inbox: telegramInbox(store(), 'fake', 'telegram'), pollTimeoutSeconds: 1 });
  let finish10, finish11;
  const delivered = [];
  const first = new TelegramAdapter(options());
  await first.start(async (message) => {
    delivered.push(message.text);
    if (message.text === '10') await new Promise((resolve) => { finish10 = resolve; });
    if (message.text === '11') await new Promise((resolve) => { finish11 = resolve; });
  });
  t.after(async () => { finish10?.(); finish11?.(); await first.stop(); });
  await until(() => delivered.length === 3 && offsets.includes(13));
  assert.deepEqual(delivered, ['10', '11', '12'], 'each update handed over once');
  assert.equal(saved, 13, 'the position moved past all three as soon as they were saved');
  assert.equal(pending.length, 0, 'Telegram confirmed them: none is asked for again while 10 and 11 work');
  finish10();
  await delay(20);
  await first.stop(); // simulate process exit while 11 is still in flight
  const replay = [];
  const second = new TelegramAdapter(options());
  t.after(() => second.stop());
  await second.start(async (message) => { replay.push(message); });
  await until(() => replay.length >= 1);
  await delay(100);
  assert.deepEqual(replay.map((m) => m.text), ['11'], 'restart hands over the unfinished update, not the finished ones');
  assert.equal(replay[0].caughtUp, true);
  finish11();
});

test('a failed position write does not stop intake: the inbox holds the update and Telegram is told', async (t) => {
  const pending = [update(30)];
  const offsets = [];
  const position = { load: () => 0, save: () => { throw new Error('disk unavailable'); } };
  const fakeFetch = async (url, init) => {
    const method = url.split('/').pop();
    if (method === 'getMe') return { json: async () => ({ ok: true, result: { id: 1, is_bot: true, username: 'TestBot' } }) };
    const offset = JSON.parse(init.body).offset;
    offsets.push(offset);
    while (pending.length && pending[0].update_id < offset) pending.shift();
    await delay(5);
    return { json: async () => ({ ok: true, result: [...pending] }) };
  };
  const received = [];
  const adapter = new TelegramAdapter({ id: 'telegram', token: 'fake', fetch: fakeFetch, position, pollTimeoutSeconds: 1,
    inbox: telegramInbox({ sqlite: new DatabaseSync(':memory:') }, 'fake', 'telegram') });
  t.after(() => adapter.stop());
  await adapter.start(async (message) => { received.push(message.text); });
  await until(() => received.length === 1 && offsets.includes(31));
  await delay(50);
  assert.deepEqual(received, ['30'], 'handed over once');
});
