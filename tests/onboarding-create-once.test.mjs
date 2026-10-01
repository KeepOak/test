/* Setup's real creation functions with a controlled request ledger. No provider or browser is needed
   to verify duplicate exits and recovery at each POST boundary. Window coverage remains separate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const source = readFileSync(new URL('../public/app/flows/setup.js', import.meta.url), 'utf8');
const start = source.search(/(?:async )?function makeTrunks\(o\)/);
const end = source.indexOf('\n/* The trunk.propose', start);
assert.ok(start >= 0 && end > start);

function fixture({ failCreate = false, failLook = false, failRefresh = false, loseReply = false, malformedReply = false, failRoster = false } = {}) {
  const ledger = [], saved = [], requests = new Map();
  let createFailed = false, lookFailed = false;
  const E = { trunkModes: { trunks: 'on' }, trunks: [] };
  const context = vm.createContext({
    E, crypto: { randomUUID }, TEMPLATES: [['Inbox', 'Mail', '#112233', 0], ['Research', 'Research', '#334455', 0]],
    t: (key) => key, hex: (value) => value, lookOf: () => ({}), SHAPE_NAMES: ['round'],
    api: async (route, body) => {
      await Promise.resolve(); // leave time for another exit to arrive
      if (route === 'trunks' && body === undefined) { if (failRoster) throw new Error('Roster unavailable'); return { trunks: [...saved] }; }
      ledger.push({ route, body });
      if (route === 'trunks') {
        if (failCreate && !createFailed) { createFailed = true; throw new Error('Create refused'); }
        if (requests.has(body.requestId)) return { trunk: requests.get(body.requestId) };
        const trunk = { id: `trunk-${saved.length + 1}`, name: body.name };
        saved.push(trunk);
        if (body.requestId) requests.set(body.requestId, trunk);
        if (loseReply && saved.length === 1) throw new Error('Reply lost after commit');
        if (malformedReply && saved.length === 1) return {};
        return { trunk };
      }
      if (failLook && !lookFailed) { lookFailed = true; throw new Error('Look refused'); }
      return {};
    },
    refresh: async () => { if (failRefresh) throw new Error('Offline'); E.trunks = [...saved]; },
  });
  vm.runInContext(source.slice(start, end) + ';globalThis.make = makeTrunks;', context);
  const o = { tpls: new Set([0]), picks: new Set(), proposals: [] };
  return { make: context.make, o, ledger, saved, E };
}

test('rapid setup exits share one pass and preserve each distinct selected Trunk', async () => {
  const f = fixture();
  f.o.tpls.add(1);
  f.o.proposals.push({ name: 'Travel', title: 'Trips', description: 'Plans' });
  f.o.picks.add('Travel');
  await Promise.all([f.make(f.o), f.make(f.o), f.make(f.o)]);
  assert.deepEqual(f.saved.map((t) => t.name), ['Inbox', 'Research', 'Travel']);
  assert.equal(f.ledger.filter((r) => r.route === 'trunks').length, 3);
  assert.equal(f.o.tpls.size, 0);
  assert.equal(f.o.picks.size, 0);
});

test('a matching template and repeated proposed name create only one Trunk', async () => {
  const f = fixture();
  f.o.proposals = [{ name: 'Inbox' }, { name: 'Travel' }, { name: 'Travel' }];
  f.o.picks = new Set(['Inbox', 'Travel']);
  await f.make(f.o);
  assert.deepEqual(f.saved.map((t) => t.name), ['Inbox', 'Travel']);
});

test('a refused create remains selected and retry creates it once', async () => {
  const f = fixture({ failCreate: true });
  await assert.rejects(f.make(f.o), /Create refused/);
  assert.equal(f.saved.length, 0);
  assert.equal(f.o.tpls.size, 1);
  await f.make(f.o);
  assert.equal(f.saved.length, 1);
  assert.equal(f.ledger.filter((r) => r.route === 'trunks').length, 2);
});

test('accepted create followed by failed look saves the same id on retry', async () => {
  const f = fixture({ failLook: true });
  f.o.tpls.add(1);
  await assert.rejects(f.make(f.o), /Look refused/);
  assert.equal(f.saved.length, 1);
  await Promise.all([f.make(f.o), f.make(f.o)]);
  assert.deepEqual(f.saved.map((t) => t.name), ['Inbox', 'Research']);
  assert.equal(f.ledger.filter((r) => r.route === 'trunks').length, 2);
  assert.equal(f.ledger.filter((r) => r.route === 'trunks/trunk-1').length, 2);
  assert.equal(f.ledger.filter((r) => r.route === 'trunks/trunk-2').length, 1);
});

test('a failed refresh does not recreate an acknowledged Trunk when selected again', async () => {
  const f = fixture({ failRefresh: true });
  await f.make(f.o);
  f.o.tpls.add(0);
  await f.make(f.o);
  assert.equal(f.saved.length, 1);
});

for (const mode of ['loseReply', 'malformedReply']) test(`${mode}: retry uses the same immutable request after server commit`, async () => {
  const f = fixture({ [mode]: true });
  await assert.rejects(f.make(f.o));
  assert.equal(f.saved.length, 1);
  await f.make(f.o);
  assert.equal(f.saved.length, 1);
  const creates = f.ledger.filter((r) => r.route === 'trunks');
  assert.equal(creates.length, 2);
  assert.equal(creates[0].body.requestId, creates[1].body.requestId);
  assert.deepEqual(creates[0].body, creates[1].body);
});

test('a completed intent does not suppress an explicit new selection after deletion', async () => {
  const f = fixture();
  await f.make(f.o);
  f.E.trunks = [];
  f.saved.length = 0;
  f.o.tpls.add(0);
  await f.make(f.o);
  assert.equal(f.saved.length, 1);
  assert.notEqual(f.ledger.filter((r) => r.route === 'trunks')[0].body.requestId,
    f.ledger.filter((r) => r.route === 'trunks')[1].body.requestId);
});

test('an unselected failed appearance write does not block a different selection', async () => {
  const f = fixture({ failLook: true });
  await assert.rejects(f.make(f.o), /Look refused/);
  f.o.tpls.delete(0);
  f.o.tpls.add(1);
  await f.make(f.o);
  assert.deepEqual(f.saved.map((t) => t.name), ['Inbox', 'Research']);
  assert.equal(f.ledger.filter((r) => r.route === 'trunks/trunk-1').length, 1);
});

test('a reopened setup checks the authoritative roster after losing a committed response', async () => {
  const f = fixture({ loseReply: true });
  await assert.rejects(f.make(f.o));
  const reopened = { tpls: new Set([0]), picks: new Set(), proposals: [] };
  await f.make(reopened);
  assert.equal(f.saved.length, 1);
  assert.equal(f.ledger.filter((r) => r.route === 'trunks').length, 1);
});

test('an unreadable authoritative roster blocks creation rather than guessing from stale state', async () => {
  const f = fixture({ failRoster: true });
  await assert.rejects(f.make(f.o), /Roster unavailable/);
  assert.equal(f.saved.length, 0);
});
