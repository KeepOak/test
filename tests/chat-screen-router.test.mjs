import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBranch, TelegramAdapter } from '../dist/index.js';
import { saveChatScreenSettings, chatScreenSettings } from '../dist/channels/screen-settings.js';
import { discardTemp } from './temp-dir.mjs';
const chat = { channel: 'bot', senderId: '42', chatId: '42', chatKind: 'direct', trunk: null };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'branch-screen-router-')); let completions = 0;
  const app = await createBranch({ workspace: join(root, 'w'), dataDir: join(root, 'd'),
    provider: { name: 'stand-in', complete: async () => { completions++; return { content: 'unexpected model task', toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const sent = [], adapter = { id: 'bot', kind: 'telegram', start: async () => {}, stop: async () => {},
    send: async (_, text) => { sent.push(text); return String(sent.length); } };
  app.channels.mergeWindowMs = 0;
  await app.channels.attach(adapter, { activation: 'always', pairing: true, allowlist: ['42', '77'] });
  app.store.save('settings', app.runtime.owner, 'channel-pair:bot:42', { status: 'approved', code: '123456', name: 'Owner',
    requestedAt: new Date().toISOString(), approvedAt: new Date().toISOString() });
  return { app, adapter, sent, completions: () => completions };
}
test('real router entry is off by default, requires a current approved exact owner and respects lock/revocation', async (t) => {
  const w = await fixture(t), { app } = w;
  assert.equal(chatScreenSettings(app.store, app.runtime.owner).on, false); assert.equal(app.channels.screenEligible(chat), false);
  saveChatScreenSettings(app.store, app.runtime.owner, { on: true, accounts: [{ channel: 'bot', sender: '42' }] });
  assert.equal(app.channels.screenEligible(chat), true);
  for (const changed of [{ ...chat, senderId: '77' }, { ...chat, chatKind: 'group' }, { ...chat, caughtUp: true }])
    assert.equal(app.channels.screenEligible(changed), false);
  w.adapter.kind = 'email'; assert.equal(app.channels.screenEligible(chat), false); w.adapter.kind = 'telegram';
  app.sessionLock.lock(); assert.equal(app.channels.screenEligible(chat), false);
  app.sessionLock.unlock({}); app.channels.remove(app.runtime.owner, { channel: 'bot', senderId: '42' });
  assert.equal(app.channels.screenEligible(chat), false);
});
test('intrinsic screen and Stop never become a model task when optional commands are off', async (t) => {
  const w = await fixture(t), { app } = w; let serial = 0;
  for (const text of ['/screen', '/screen stop']) await app.channels.handle({ ...chat, text, messageId: `screen${++serial}`,
    addressed: true, senderName: 'Owner' });
  assert.equal(w.completions(), 0); assert.equal(app.store.runs(app.runtime.owner).length, 0);
  assert.equal(w.sent.length, 2); assert.ok(w.sent.every(text => /screen session|paired direct chat/i.test(text)));
});
test('Telegram screen link uses an actual DM web_app button and rejects groups before sending', async () => {
  const calls = [], adapter = new TelegramAdapter({ id: 'bot', token: '1234:FAKE', apiBase: 'https://stand-in.invalid',
    fetch: async (url, init) => { calls.push({ method: String(url).split('/').at(-1), body: JSON.parse(init.body) }); return Response.json({ ok: true, result: { message_id: 1 } }); } });
  await adapter.sendScreenLink('42', 'https://stand-in.invalid/chat-screen?request=opaque');
  assert.equal(calls[0].body.reply_markup.inline_keyboard[0][0].web_app.url, 'https://stand-in.invalid/chat-screen?request=opaque');
  await assert.rejects(adapter.sendScreenLink('-100', 'https://stand-in.invalid/chat-screen'), /direct chat/);
  await assert.rejects(adapter.sendScreenLink('42', 'https://stand-in.invalid/api/panels/screen'), /screen address/);
  assert.equal(calls.length, 1);
});
