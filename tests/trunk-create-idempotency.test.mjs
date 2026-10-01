import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { startServer } from '../dist/server.js';
import { fixture, on } from './trunks-helpers.mjs';
import { createFingerprint, requestedTrunk, initializedTrunk } from '../dist/trunks/create-request.js';

const input = () => ({ name: 'Retry helper', description: 'Fixture only', requestId: randomUUID() });

test('replaying an accepted creation returns its ID and creates only one introduction', async (t) => {
  const { app, provider } = await fixture(t);
  on(app);
  const body = input();
  const first = app.trunks.create(body); // the response is deliberately discarded by the caller
  const again = await Promise.all(Array.from({ length: 5 }, () => Promise.resolve().then(() => app.trunks.create(body))));
  assert.ok(again.every((trunk) => trunk.id === first.id));
  assert.equal(app.trunks.records.list().filter((trunk) => trunk.name === body.name).length, 1);
  await app.trunks.introduced();
  assert.equal(provider.requests.filter((request) => request.messages.some((message) => /Introduce yourself/.test(message.content))).length, 1);
});

test('a request binds normalized create fields, while distinct request IDs allow intentional same names', async (t) => {
  const { app } = await fixture(t);
  on(app);
  const body = input(), first = app.trunks.create(body);
  assert.equal(app.trunks.create({ ...body, name: ` ${body.name} ` }).id, first.id);
  assert.equal(app.trunks.create({ ...body, requestId: body.requestId.toUpperCase() }).id, first.id);
  assert.throws(() => app.trunks.create({ ...body, description: 'Changed' }), (error) => error.status === 409);
  assert.notEqual(app.trunks.create({ ...body, requestId: randomUUID() }).id, first.id);
  assert.notEqual(app.trunks.create({ name: body.name }).id, first.id, 'legacy callers retain same-name support');
});

test('a delayed retry cannot resurrect a removed Trunk', async (t) => {
  const { app } = await fixture(t);
  on(app);
  const body = input(), first = app.trunks.create(body);
  await app.trunks.introduced();
  app.trunks.remove(first.id);
  assert.throws(() => app.trunks.create(body), (error) => error.status === 409 && /removed/.test(error.message));
  assert.equal(app.trunks.records.find(first.id), undefined);
});

test('record failure rolls back the canonical conversation and receipt, so retry stays possible', async (t) => {
  const { app } = await fixture(t);
  on(app);
  const body = input(), before = app.store.runs(app.runtime.owner).length;
  const events = [], finished = [];
  const stopEvents = app.store.onEvent((id, kind) => events.push([id, kind]));
  const stopFinished = app.store.onRunFinished((id) => finished.push(id));
  const put = app.trunks.records.put.bind(app.trunks.records);
  app.trunks.records.put = (trunk) => { put(trunk); throw new Error('Fixture write failure'); };
  try { assert.throws(() => app.trunks.create(body), /Fixture write failure/); }
  finally { app.trunks.records.put = put; }
  assert.equal(app.trunks.records.list().filter((trunk) => trunk.name === body.name).length, 0);
  assert.equal(app.store.runs(app.runtime.owner).length, before);
  stopEvents(); stopFinished();
  assert.deepEqual(events, [], 'rollback must not announce phantom bootstrap or aside events');
  assert.deepEqual(finished, [], 'rollback must not notify completion observers');
  assert.equal(app.store.sqlite.prepare('SELECT COUNT(*) AS n FROM trunk_create_requests WHERE request_id=?').get(body.requestId).n, 0);
  assert.ok(app.trunks.create(body).id);
});

test('receipts are owner-scoped and interrupted initialization is reported rather than replayed blindly', async (t) => {
  const { app } = await fixture(t);
  const requestId = randomUUID(), fingerprint = createFingerprint({ name: 'Same', title: '', description: '' });
  const made = new Map();
  const create = (owner) => () => { const trunk = { id: randomUUID(), handle: 'same' }; made.set(trunk.id, trunk); return trunk; };
  const lookup = (id) => made.get(id);
  const first = requestedTrunk(app.store, 'fixture-one', requestId, fingerprint, lookup, create('fixture-one'));
  assert.throws(() => requestedTrunk(app.store, 'fixture-one', requestId, fingerprint, lookup, create('fixture-one')),
    (error) => error.status === 409 && /initial setup was interrupted/.test(error.message));
  initializedTrunk(app.store, 'fixture-one', requestId);
  assert.equal(requestedTrunk(app.store, 'fixture-one', requestId, fingerprint, lookup, create('fixture-one')).trunk.id, first.trunk.id);
  assert.notEqual(requestedTrunk(app.store, 'fixture-two', requestId, fingerprint, lookup, create('fixture-two')).trunk.id, first.trunk.id);
});

test('HTTP retry after an ignored successful response returns the committed Trunk', async (t) => {
  const { app, root } = await fixture(t);
  on(app);
  const server = await startServer(app, { dataDir: join(root, 'data'), port: 0 });
  t.after(() => server.close());
  const body = input();
  const post = (value) => fetch(server.url + '/api/trunks', { method: 'POST',
    headers: { authorization: `Bearer ${server.token}`, origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify(value) });
  const discarded = await post(body);
  assert.equal(discarded.status, 200);
  await discarded.body.cancel(); // caller does not learn the returned ID
  const retry = await post(body);
  assert.equal(retry.status, 200);
  const result = await retry.json();
  assert.equal(app.trunks.records.list().filter((trunk) => trunk.name === body.name).length, 1);
  assert.equal(app.trunks.records.find(result.trunk.id)?.name, body.name);
  const changed = await post({ ...body, name: 'Different' });
  assert.equal(changed.status, 409);
});

test('the actual Trunks API handler preserves replay IDs and rejects payload mismatch', async (t) => {
  const { trunksApi } = await import('../dist/trunks/api.js');
  const { app } = await fixture(t);
  on(app);
  const body = input();
  const call = (value) => trunksApi({ trunks: app.trunks, method: 'POST', readBody: async () => value,
    person: null, requireOwner: () => {} }, '/api/trunks');
  const first = await call(body), replay = await call(body);
  assert.equal(replay.trunk.id, first.trunk.id);
  await assert.rejects(call({ ...body, description: 'Changed' }), (error) => error.status === 409);
});

test('an acknowledged receipt survives closing and reopening its database', async (t) => {
  const { Store } = await import('../dist/store.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'branch-create-receipt-'));
  let store = new Store(join(root, 'fixture.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const requestId = randomUUID(), owner = 'fixture-owner';
  const fingerprint = createFingerprint({ name: 'Persisted', title: '', description: '' });
  const lookup = (id) => store.get('governance', owner, `trunk:${id}`)?.data;
  const first = requestedTrunk(store, owner, requestId, fingerprint, lookup, () => {
    const trunk = { id: randomUUID(), name: 'Persisted', handle: 'persisted' };
    store.save('governance', owner, `trunk:${trunk.id}`, trunk);
    return trunk;
  });
  initializedTrunk(store, owner, requestId);
  store.close();
  store = new Store(join(root, 'fixture.sqlite'));
  const replay = requestedTrunk(store, owner, requestId, fingerprint, lookup, () => assert.fail('must not recreate'));
  assert.equal(replay.created, false);
  assert.equal(replay.trunk.id, first.trunk.id);
});

test('successful observers see committed creation rows exactly once, and nested keyed calls fail closed', async (t) => {
  const { app } = await fixture(t);
  on(app);
  const body = input(), observations = [], finished = [];
  const stopEvents = app.store.onEvent((id, kind) => {
    if (kind !== 'run.bootstrap') return;
    observations.push({ id, inTransaction: app.store.sqlite.isTransaction,
      hasTrunk: app.trunks.records.list().some((trunk) => trunk.chatSessionId === app.store.run(id)?.sessionId),
      receipt: app.store.sqlite.prepare('SELECT COUNT(*) AS n FROM trunk_create_requests WHERE request_id=?').get(body.requestId).n });
  });
  const stopFinished = app.store.onRunFinished((id) => {
    if (app.store.run(id)?.prompt === `Trunk: ${body.name}`) finished.push({ id, inTransaction: app.store.sqlite.isTransaction });
  });
  const trunk = app.trunks.create(body);
  assert.equal(app.trunks.create(body).id, trunk.id);
  stopEvents(); stopFinished();
  assert.equal(observations.length, 1);
  assert.equal(observations[0].inTransaction, false);
  assert.equal(observations[0].hasTrunk, true);
  assert.equal(observations[0].receipt, 1);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].inTransaction, false);
  const nested = input();
  assert.throws(() => app.store.atomically(() => app.trunks.create(nested)),
    (error) => error.status === 409 && /existing transaction/.test(error.message));
  assert.equal(app.store.sqlite.prepare('SELECT COUNT(*) AS n FROM trunk_create_requests WHERE request_id=?').get(nested.requestId).n, 0);
});
