import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { createBranch } from '../dist/index.js';
import { startServer } from '../dist/server.js';
import { discardTemp } from './temp-dir.mjs';
import { installScreenStandIn } from './local-screen-fixture.mjs';

async function world(t) {
  const root = await mkdtemp('C:/Users/bishi/AppData/Local/Temp/Codex-session-files/local-screen-http-');
  const app = await createBranch({ workspace: join(root, 'work'), dataDir: join(root, 'data'), provider: { name: 'scripted', async complete() { return { content: 'ok', toolCalls: [] }; } } });
  const seen = installScreenStandIn(app), sid = app.store.createSession(app.runtime.owner);
  const server = await startServer(app, { dataDir: join(root, 'data'), port: 0, host: '127.0.0.1' });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body, key = server.token, headers = {}) => fetch(server.url + path, {
    method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { app, seen, sid, server, call };
}

test('real local routes require explicit owned target and deny short keys, doors, wrong origin/session and Lockdown', async t => {
  const { app, seen, sid, call } = await world(t);
  assert.equal((await call('/api/panels/screen?width=900')).status, 400);
  assert.equal((await call(`/api/panels/screen/targets?session=${sid}`, undefined, 'bad')).status, 401);
  assert.equal((await call('/api/panels/screen/targets?session=foreign')).status, 403);
  for (const scope of ['read', 'run']) {
    const key = app.sessionTokens.create(app.runtime.owner, { name: scope, scope, minutes: 5 }).token;
    assert.equal((await call(`/api/panels/screen/targets?session=${sid}`, undefined, key)).status, 401);
  }
  assert.equal((await call(`/api/panels/screen/targets?session=${sid}`, undefined, undefined, { 'x-branch-tunnel': '1' })).status, 403);
  assert.equal((await call(`/api/panels/screen/targets?session=${sid}`, undefined, undefined, { origin: 'https://other.example' })).status, 403);
  await call('/api/lockdown', { on: true });
  assert.equal((await call(`/api/panels/screen/targets?session=${sid}`)).status, 403);
  assert.equal(seen.enumerated, 0); assert.equal(seen.opened, 0);
});

test('route journey enumerates opaque external editor, streams painted frame, controls once and releases on disconnect', async t => {
  const { seen, sid, server, call } = await world(t);
  const list = await (await call(`/api/panels/screen/targets?session=${sid}`)).json();
  assert.equal(list.targets.length, 1); assert.equal(list.targets[0].kind, 'window');
  assert.equal(list.targets[0].handle, undefined); assert.equal(list.targets[0].processId, undefined);
  assert.equal((await call('/api/panels/screen/target', { sessionId: sid, targetId: list.targets[0].id, handle: '12' })).status, 400);
  const chosen = await (await call('/api/panels/screen/target', { sessionId: sid, targetId: list.targets[0].id })).json();
  const cancel = new AbortController();
  const response = await fetch(`${server.url}/api/panels/screen?session=${sid}&view=${chosen.viewId}&width=900`, { headers: { authorization: `Bearer ${server.token}` }, signal: cancel.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), first = await reader.read();
  const frame = JSON.parse(new TextDecoder().decode(first.value).trim());
  const body = { sessionId: sid, viewId: chosen.viewId, frameId: frame.frameId };
  assert.equal((await call('/api/panels/screen/control', { ...body, held: true })).status, 409);
  assert.equal((await call('/api/panels/screen/painted', body)).status, 200);
  assert.equal((await call('/api/panels/screen/control', { ...body, held: true })).status, 200);
  const next = JSON.parse(new TextDecoder().decode((await reader.read()).value).trim());
  body.frameId = next.frameId;
  assert.equal((await call('/api/panels/screen/painted', body)).status, 200);
  const input = { ...body, input: { action: 'click', window: 'Fixture editor', x: .25, y: .75 } };
  assert.equal((await call('/api/panels/screen/input', input)).status, 200);
  assert.equal((await call('/api/panels/screen/input', input)).status, 409);
  assert.equal(seen.effects.length, 1);
  cancel.abort(); await reader.cancel().catch(() => {});
  for (let i = 0; i < 100 && !seen.closed; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(seen.closed, 1); assert.equal(seen.held, false);
});