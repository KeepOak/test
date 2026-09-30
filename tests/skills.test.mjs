import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discardTemp } from './temp-dir.mjs';
import { createBranch, parseSkillDocument } from '../dist/index.js';
import { startServer } from '../dist/server.js';

const document = (name = 'example', body = 'UNIQUE_SKILL_BODY', description = 'Select for fixture work.') =>
  `---\nname: ${name}\ndescription: ${description}\nallowed-tools: files.write\n---\n${body}\n`;
async function fixture(t, provider) {
  const scratch = join(tmpdir(), 'Codex-session-files'); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'branch-skills-'));
  const options = { workspace: join(root, 'workspace'), dataDir: join(root, 'data'), provider };
  const app = await createBranch(options);
  // Whatever a test opens on top of the app is shut first, in this same hook: separate hooks run in the
  // order they were added, which closed the app and deleted its folder under a server still using them.
  const closing = [];
  t.after(async () => { for (const close of closing.reverse()) await close(); await app.close(); await discardTemp(root); });
  return { app, options, closing };
}
const revision = skill => ({ expectedRevision: skill.revision });

test('skill parser accepts YAML metadata and rejects malformed, ambiguous, aliased and oversized documents', () => {
  const text = '\uFEFF---\r\nname: sample\r\ndescription: >-\r\n  First line\r\n  second line\r\nlicense: MIT\r\nmetadata:\r\n  author: Example\r\n---\r\n# Instructions\r\n';
  assert.deepEqual(parseSkillDocument(text), { name: 'sample', description: 'First line second line', license: 'MIT', metadata: { author: 'Example' } });
  for (const invalid of ['instructions only', document('Bad_Name'), document('-edge'), document('two--hyphens'),
    document('a'.repeat(65)), document('good', ''), document('good', 'body', 'x'.repeat(1025)),
    '---\nname: example\ndescription: &description example\nlicense: *description\n---\nbody',
    '---\nname: example\nname: duplicate\ndescription: example\n---\nbody',
    '---\nname: example\ndescription: !custom example\n---\nbody',
    '---\nname: example\ndescription: example\nunknown: true\n---\nbody',
    document('example', 'x'.repeat(48000)), document('example', '\u0000'.repeat(11000)),
    '---\nname: example\ndescription: example\nmetadata:\n  count: 12\n---\nbody'])
    assert.throws(() => parseSkillDocument(invalid), invalid.slice(0, 90));
});

test('skill documents retain exact bytes, owner isolation, revisions and selection across restart', async t => {
  const { app, options } = await fixture(t), skills = app.store.skills;
  const text = document().replaceAll('\n', '\r\n');
  const installed = skills.install('local', { document: text });
  assert.equal(installed.document, text); assert.equal(installed.activeVersion, 1);
  assert.deepEqual(skills.list('other'), []);
  for (const operation of [() => skills.view('other', installed.id), () => skills.read('other', installed.id, { version: 1 }),
    () => skills.remove('other', installed.id, revision(installed))]) assert.throws(operation, /not found/);
  const edited = skills.update('local', installed.id, { ...revision(installed), document: document('revised', 'New instructions') });
  assert.equal(edited.revision, 2); assert.equal(edited.headVersion, 2); assert.equal(edited.activeVersion, 1);
  assert.equal(edited.activeName, 'example'); assert.equal(skills.catalog('local')[0].name, 'example');
  assert.throws(() => skills.activate('local', installed.id, { ...revision(installed), version: 2 }), /stale revision/);
  const active = skills.activate('local', installed.id, { ...revision(edited), version: 2 });
  assert.equal(active.revision, 3); assert.equal(active.activeName, 'revised');
  const rollback = skills.activate('local', installed.id, { ...revision(active), version: 1 });
  assert.equal(skills.read('local', installed.id, { version: 1 }).document, text);
  await app.close(); const reopened = await createBranch(options);
  try {
    assert.deepEqual(reopened.store.skills.view('local', installed.id), rollback);
    const disabled = reopened.store.skills.disable('local', installed.id, revision(rollback));
    assert.equal(disabled.activeVersion, null); assert.deepEqual(reopened.store.skills.catalog('local'), []);
    assert.deepEqual(reopened.store.skills.remove('local', installed.id, revision(disabled)), { removed: true });
    assert.throws(() => reopened.store.skills.read('local', installed.id, { version: 1 }), /not found/);
  } finally { await reopened.close(); }
});

test('invalid skill changes are atomic, bounded and reject forged owner or conflicting active names', async t => {
  const { app } = await fixture(t), skills = app.store.skills;
  const a = skills.install('local', { document: document('a') });
  const b = skills.install('local', { document: document('b') });
  assert.throws(() => skills.install('local', { document: document('a') }), /already uses/);
  assert.throws(() => skills.install('local', { document: document('c'), owner: 'other' }));
  assert.throws(() => skills.update('local', a.id, { ...revision(a), document: 'not a skill' }));
  const renamed = skills.update('local', b.id, { ...revision(b), document: document('a') });
  assert.throws(() => skills.activate('local', b.id, { ...revision(renamed), version: 2 }), /already uses/);
  assert.deepEqual(skills.view('local', b.id), renamed);
  assert.throws(() => skills.activate('local', b.id, { ...revision(renamed), version: 3 }), /not found/);
  assert.deepEqual(skills.view('local', b.id), renamed);
  let changing = a;
  for (let i = 2; i <= 20; i++) changing = skills.update('local', a.id, { ...revision(changing), document: document('a', `Revision ${i}`) });
  assert.throws(() => skills.update('local', a.id, { ...revision(changing), document: document('a') }), /20 retained/);
  assert.deepEqual(skills.view('local', a.id), changing);
  assert.equal(skills.list('local').length, 2);
});

test('installed, enabled and metadata byte limits reject changes without partial writes', async t => {
  const { app } = await fixture(t), skills = app.store.skills;
  // All fifty may be switched on at once: one on "load when needed" costs a short line of a request (src/skill-tools.ts).
  for (let i = 0; i < 50; i++) skills.install('local', { document: document(`skill-${i}`) });
  assert.equal(skills.catalog('local').length, 50);
  assert.throws(() => skills.install('local', { document: document('overflow') }), /50 installed/);
  assert.equal(skills.list('local').length, 50);
  let count = 0;
  for (; count < 50; count++) {
    try { skills.install('bytes', { document: document(`skill-${count}`, 'body', '界'.repeat(1024)) }); }
    catch (error) { assert.match(error.message, /64 KiB/); break; }
  }
  assert.ok(count > 0 && count < 50); assert.equal(skills.list('bytes').length, count);
});

test('runtime loads only selected instructions and does not expand permissions from allowed-tools', async t => {
  let app, selected, calls = 0;
  const setup = await fixture(t, { name: 'skills-fixture', async complete(request) {
    calls++;
    const input = JSON.stringify(request.messages);
    assert.doesNotMatch(input, /UNSELECTED_BODY/);
    if (calls === 1) {
      assert.match(input, /Select for fixture work/); assert.doesNotMatch(input, /UNIQUE_SKILL_BODY/);
      return { content: '', toolCalls: [{ id: 'read', name: 'skills.read', arguments: JSON.stringify({ id: selected.id, version: 1 }) }] };
    }
    if (calls === 2) {
      assert.match(input, /UNIQUE_SKILL_BODY/);
      return { content: '', toolCalls: [{ id: 'write', name: 'files.write', arguments: '{"path":"denied.txt","content":"bad"}' }] };
    }
    assert.match(request.messages.at(-1).content, /Permission denied/);
    return { content: 'Selected skill used without elevated permissions', toolCalls: [] };
  } });
  app = setup.app;
  selected = app.store.skills.install('local', { document: document() });
  app.store.skills.install('local', { document: document('unused', 'UNSELECTED_BODY') });
  const run = await app.runtime.run({ prompt: 'Use the example skill', permissions: ['skills.read'] });
  assert.equal(run.status, 'completed'); assert.equal(calls, 3);
  await assert.rejects(stat(join(setup.options.workspace, 'denied.txt')), { code: 'ENOENT' });
  const catalog = app.store.events(run.id).find(event => event.kind === 'skills.catalog');
  assert.equal(catalog.data.entries.length, 2); assert.ok(!JSON.stringify(catalog).includes('UNIQUE_SKILL_BODY'));
});

test('task skill catalogs pin versions through edits and activation, and removal denies further reads', async t => {
  const { app } = await fixture(t), skills = app.store.skills;
  const first = skills.install('local', { document: document() });
  let calls = 0;
  const { skillInstructions } = await import('../dist/skill-tools.js');
  const run = app.store.createRun('local', 'pin fixture'), context = app.runtime.context({ runId: run.id });
  skillInstructions(app.store, context);
  const second = skills.update('local', first.id, { ...revision(first), document: document('new-name', 'New body') });
  const active = skills.activate('local', first.id, { ...revision(second), version: 2 });
  assert.equal((await app.registry.execute('skills.list', {}, context))[0].version, 1);
  assert.equal((await app.registry.execute('skills.read', { id: first.id, version: 1 }, context)).document, first.document);
  await assert.rejects(app.registry.execute('skills.read', { id: first.id, version: 2 }, context), /not available/);
  const disabled = skills.disable('local', first.id, revision(active));
  assert.equal((await app.registry.execute('skills.read', { id: first.id, version: 1 }, context)).document, first.document);
  skills.remove('local', first.id, revision(disabled));
  await assert.rejects(app.registry.execute('skills.read', { id: first.id, version: 1 }, context), /not found/);
  app.store.finish(run.id, 'completed', 'done');
});

test('tasks without skills.read do not receive metadata and direct tools cannot select inactive versions', async t => {
  const { app } = await fixture(t, { name: 'no-skills', async complete(request) {
    assert.doesNotMatch(JSON.stringify(request.messages), /distinctive-secret-description/);
    assert.ok(request.tools.every(tool => !tool.name.startsWith('skills.')));
    return { content: 'Done', toolCalls: [] };
  } });
  const skill = app.store.skills.install('local', { document: document('example', 'Body', 'distinctive-secret-description') });
  assert.equal((await app.runtime.run({ prompt: 'Plain task', permissions: [] })).status, 'completed');
  assert.equal((await app.runtime.executeTool('skills.read', { id: skill.id, version: 1 })).document, skill.document);
  app.store.skills.disable('local', skill.id, revision(skill));
  await assert.rejects(app.runtime.executeTool('skills.read', { id: skill.id, version: 1 }), /not available/);
});

test('skill API requires authorization, exposes metadata only in state and rejects stale or malformed updates', async t => {
  const { app, options, closing } = await fixture(t);
  const server = await startServer(app, { dataDir: options.dataDir, port: 0 }); closing.push(() => server.close());
  const headers = { authorization: 'Bearer ' + server.token, 'content-type': 'application/json' };
  const post = (path, value, custom = headers) => fetch(server.url + '/api/skills/' + path, {
    method: 'POST', headers: custom, body: JSON.stringify(value),
  });
  assert.equal((await post('install', { document: document() }, { 'content-type': 'application/json' })).status, 401);
  assert.equal((await post('install', { document: document(), owner: 'other' })).status, 400);
  const saved = await (await post('install', { document: document() })).json();
  const state = await (await fetch(server.url + '/api/state', { headers })).json();
  assert.equal(state.skills.length, 1); assert.ok(!JSON.stringify(state.skills).includes('UNIQUE_SKILL_BODY'));
  assert.equal((await post(`${saved.id}/update`, { expectedRevision: 9, document: document() })).status, 400);
  assert.equal((await post(`${saved.id}/read`, { version: 1, owner: 'other' })).status, 400);
  const read = await (await post(`${saved.id}/read`, { version: 1 })).json();
  assert.equal(read.document, saved.document);
});
