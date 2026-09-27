import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleChatScreen, chatScreenDoorPath } from '../dist/channels/screen-http.js';
import { chatScreenWindowApi } from '../dist/channels/screen-window-api.js';
import { chatScreenSettings } from '../dist/channels/screen-settings.js';
import { WebhookTunnel, tunnelPath } from '../dist/personal/tunnel.js';
import { createBranch, setLockdown } from '../dist/index.js';
import { startServer } from '../dist/server.js';
import { fakeStore, on } from './personal-kit.mjs';
import { discardTemp } from './temp-dir.mjs';
const id = '00000000-0000-4000-8000-000000000001', key = 'x'.repeat(43), proof = 'f'.repeat(32);
const mark = { 'x-branch-tunnel': '1', 'x-forwarded-proto': 'https' };
function response() { return { status: 0, headers: {}, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } }; }
function entry() {
  const calls = [];
  return { calls, targets: async (...args) => { calls.push(['targets', ...args]); return [{ id: proof, label: 'Notes' }]; },
    start: async (...args) => { calls.push(['start', ...args]); return { id, key, expires: 100000 }; },
    frame: async (...args) => { calls.push(['frame', ...args]); return { bytes: Buffer.from('picture'), type: 'image/jpeg', width: 640, height: 360,
      windows: [{ handle: 'secret-hwnd' }], screen: { x: 0, y: 0, w: 640, h: 360 }, control: 'agent', session: id, inputFrame: proof }; },
    action: async (...args) => calls.push(['action', ...args]),
    sessions: { control: (...args) => calls.push(['control', ...args]), stop: (...args) => calls.push(['stop', ...args]), stopLaunch: (...args) => calls.push(['stopLaunch', ...args]) } };
}
async function call(port, path, body, headers = mark, method = 'POST') {
  const result = response();
  await handleChatScreen({ entry: port, publicAddress: () => 'https://stand-in.trycloudflare.com', readBody: async () => body,
    errorText: error => error.message }, { method, headers: { 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' } }, result, path);
  return result;
}
test('the door allows exactly the phone files and dedicated POSTs, never general app or computer endpoints', () => {
  for (const path of ['/chat-screen', '/chat-screen.js', '/chat-screen.css']) assert.equal(tunnelPath('GET', path), true);
  for (const path of ['/api/chat-screen/targets', '/api/chat-screen/start', '/api/chat-screen/frame', '/api/chat-screen/action', '/api/chat-screen/control', '/api/chat-screen/stop']) {
    assert.equal(chatScreenDoorPath('POST', path), true); assert.equal(chatScreenDoorPath('GET', path), false);
  }
  for (const path of ['/', '/app.js', '/api/run', '/api/panels/screen', '/api/channels/owner-screen', '/api/chat-screen/action/extra', '/chat-screen/../app.js']) assert.equal(tunnelPath('POST', path), false);
});
test('purpose HTTP proof is strict; window bearer keys never substitute; frame projection excludes native identities', async () => {
  const port = entry();
  assert.equal((await call(port, '/api/chat-screen/frame', { key }, { authorization: `Bearer ${key}` })).status, 403);
  assert.equal((await call(port, '/api/chat-screen/frame', { key }, { 'x-branch-tunnel': '0', 'x-forwarded-proto': 'https' })).status, 403);
  assert.equal((await call(port, '/api/chat-screen/frame', { key }, { 'x-branch-tunnel': '1', 'x-forwarded-proto': 'http' })).status, 403);
  assert.equal((await call(port, '/api/chat-screen/frame', { key: 'bad' })).status, 400);
  assert.equal((await call(port, '/api/chat-screen/frame', { key, windowKey: key })).status, 400);
  assert.equal((await call(port, '/api/chat-screen/frame', { key, width: 10000 })).status, 400);
  assert.equal((await call(port, '/api/chat-screen/action', { key, inputFrame: proof, action: { action: 'scroll', window: 'Notes', steps: 11 } })).status, 400);
  assert.equal(port.calls.length, 0);
  const frame = await call(port, '/api/chat-screen/frame', { key }); assert.equal(frame.status, 200);
  const body = JSON.parse(frame.body); assert.equal(body.frame, Buffer.from('picture').toString('base64')); assert.equal(body.control, 'agent');
  assert.equal('screen' in body, false); assert.equal('windows' in body, false); assert.equal(frame.headers['cache-control'], 'no-store');
  await call(port, '/api/chat-screen/stop', { request: id, initData: 'signed' }); assert.deepEqual(port.calls.at(-1), ['stopLaunch', id, 'signed']);
  const page = await call(port, '/chat-screen', undefined, mark, 'GET'); assert.equal(page.status, 200); assert.match(page.headers['content-security-policy'], /default-src 'none'/);
});
test('the actual proxy drops window credentials, preserves CSP, refuses generic routes and revokes before closing', async t => {
  const port = entry(), received = [];
  const engine = createServer(async (req, res) => { received.push(req.headers);
    const handled = await handleChatScreen({ entry: port, publicAddress: () => 'https://stand-in.trycloudflare.com',
      readBody: async () => { let bytes = ''; for await (const part of req) bytes += part; return JSON.parse(bytes); }, errorText: e => e.message }, req, res, new URL(req.url, 'http://stand-in').pathname);
    if (!handled) res.writeHead(404).end();
  });
  await new Promise(r => engine.listen(0, '127.0.0.1', r));
  const store = fakeStore(); on(store, 'tunnel'); const stdout = new PassThrough(); let killed = false, revoked = false;
  const tunnel = new WebhookTunnel({ store, owner: 'local', refusal: () => null, spawn: () => {
    setImmediate(() => stdout.write('https://stand-in.trycloudflare.com')); return { stdout, stderr: null, once() {}, kill() { killed = true; return true; } }; } });
  tunnel.onStop = () => { revoked = true; }; tunnel.localAddress = `http://127.0.0.1:${engine.address().port}`;
  t.after(async () => { await tunnel.stop(); await new Promise(r => engine.close(r)); }); await tunnel.start();
  const url = `http://127.0.0.1:${tunnel.door.address().port}`;
  const page = await fetch(url + '/chat-screen?request=' + id, { headers: { authorization: 'Bearer window-key', cookie: 'secret', 'x-branch-key': 'window-key', 'x-branch-tunnel': '0' } });
  assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /frame-ancestors/); assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(received[0].authorization, undefined); assert.equal(received[0].cookie, undefined); assert.equal(received[0]['x-branch-key'], undefined); assert.equal(received[0]['x-branch-tunnel'], '1');
  for (const path of ['/api/panels/screen', '/api/run', '/api/channels/owner-screen']) assert.equal((await fetch(url + path)).status, 404);
  assert.equal(received.length, 1); await tunnel.stop(); assert.equal(revoked, true); assert.equal(killed, true);
});
test('real owner server routes require the owner window, deny generic keys and stop on permission changes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'branch-screen-http-'));
  const app = await createBranch({ workspace: join(root, 'w'), dataDir: join(root, 'd'), provider: { name: 'stand-in', complete: async () => ({ content: 'done', toolCalls: [] }) } });
  const server = await startServer(app, { dataDir: join(root, 'd'), port: 0 }); t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const ask = (path, body, token = server.token, extra = {}) => fetch(server.url + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, origin: server.url, 'content-type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await ask('/api/channels/owner-screen')).status, 200);
  assert.equal((await ask('/api/channels/owner-screen', { on: true, accounts: [{ channel: 'bot', sender: '42' }] })).status, 200);
  assert.deepEqual((await (await ask('/api/channels/owner-screen')).json()).ownerScreen.accounts, [{ channel: 'bot', sender: '42' }]);
  await app.channels.attach({ id: 'bot', kind: 'telegram', start: async () => {}, stop: async () => {}, send: async () => '1' },
    { activation: 'always', pairing: true, allowlist: ['42'] });
  app.store.save('settings', app.runtime.owner, 'channel-pair:bot:42', { status: 'approved', code: '123456', name: 'Owner',
    requestedAt: new Date().toISOString(), approvedAt: new Date().toISOString() });
  const pending = app.chatScreen.sessions.request({ channel: 'bot', senderId: '42', chatId: '42', chatKind: 'direct', trunk: null });
  assert.equal((await ask('/api/channels/screen-confirmations/confirm', { id: pending.id })).status, 200);
  assert.ok(app.chatScreen.sessions.pending.get(pending.id).confirmedUntil > Date.now());
  assert.equal((await ask('/api/channels/screen-stop', {})).status, 200);
  assert.equal(app.chatScreen.sessions.waiting().length, 0);
  assert.equal((await ask('/api/chat-screen/frame', { key }, server.token)).status, 403);
  assert.equal((await ask('/api/channels/owner-screen', { on: false, accounts: [] }, server.token, mark)).status, 403);
  setLockdown(app.store, app.runtime.owner, { on: true }); assert.equal((await ask('/api/channels/screen-confirmations')).status, 403);
});
test('delayed owner-screen bodies cannot save after Lockdown, App lock or window key rotation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'branch-screen-race-'));
  const app = await createBranch({ workspace: join(root, 'w'), dataDir: join(root, 'd'), provider: { name: 'stand-in', complete: async () => ({ content: 'done', toolCalls: [] }) } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  let current = true, locked = false, revokes = 0;
  const lock = { locked: () => locked, pinSet: () => false };
  const entry = { revoke: () => { revokes++; } };
  const before = chatScreenSettings(app.store, app.runtime.owner);
  for (const deny of [
    () => setLockdown(app.store, app.runtime.owner, { on: true }),
    () => { locked = true; },
    () => { current = false; },
  ]) {
    setLockdown(app.store, app.runtime.owner, { on: false }); locked = false; current = true;
    let deliver; const body = new Promise(resolve => { deliver = resolve; });
    const pending = chatScreenWindowApi({ store: app.store, owner: app.runtime.owner, lock, entry,
      viaDoor: false, windowKeyCurrent: () => current, readBody: () => body }, 'POST', '/api/channels/owner-screen');
    deny(); deliver({ on: true, accounts: [{ channel: 'bot', sender: '42' }] });
    await assert.rejects(pending, /Unlock Branch|Screen sessions are configured/);
    assert.deepEqual(chatScreenSettings(app.store, app.runtime.owner), before);
    assert.equal(revokes, 0);
  }
});
test('delayed confirm and Stop bodies cannot act after the window key rotates', async () => {
  let current = true, deliver, confirmations = 0, stops = 0;
  const body = new Promise(resolve => { deliver = resolve; });
  const entry = { sessions: { confirmInWindow: () => { confirmations++; }, stopFromWindow: () => { stops++; } } };
  const store = { profiles: { requireOwner: () => {} }, get: () => null }, lock = { locked: () => false };
  const parts = { store, owner: 'owner', lock, entry, viaDoor: false, windowKeyCurrent: () => current, readBody: () => body };
  const pending = chatScreenWindowApi(parts, 'POST', '/api/channels/screen-confirmations/confirm');
  current = false; deliver({ id });
  await assert.rejects(pending, /Screen sessions are configured/); assert.equal(confirmations, 0);
  current = true;
  const stop = chatScreenWindowApi({ ...parts, readBody: async () => { current = false; return {}; } }, 'POST', '/api/channels/screen-stop');
  await assert.rejects(stop, /Screen sessions are configured/); assert.equal(stops, 0);
});
