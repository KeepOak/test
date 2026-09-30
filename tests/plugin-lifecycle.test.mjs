import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginCatalog, pluginSourceHash } from '../dist/plugin-catalog.js';
import { WalledPlugins } from '../dist/add-ons/walled-plugin.js';
import { wslPath } from '../dist/sandbox-backends.js';
import { Plugins } from '../dist/plugins.js';
import { PluginEvaluations } from '../dist/plugin-evaluations.js';
import { AddOnShelf } from '../dist/add-ons/package-shelf.js';
import { wallReport } from '../dist/sandbox-backends.js';
import { wslProbe, wslReadiness } from '../dist/integrations/wsl-held.js';
import { evaluationWall } from './plugin-evaluation-wall.mjs';

function store() {
  const rows = new Map();
  return { get: (_t, _o, id) => rows.get(id), save: (_t, _o, id, data) => rows.set(id, { id, data }),
    list: () => [...rows.values()], delete: (_t, _o, id) => rows.delete(id) };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'branch-plugin-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); await mkdir(source);
  await writeFile(join(source, 'branch-plugin.json'), JSON.stringify({ id: 'demo', name: 'Demo', permissions: ['files.read'] }));
  await writeFile(join(source, 'demo.mjs'), 'export default { id: "demo" };');
  const saved = store();
  return { root, source, saved, catalog: new PluginCatalog(saved, 'owner', join(root, 'plugins')) };
}
test('installed plugin replacement requires evaluated promotion and preserves its SHA snapshot', async t => {
  const { catalog, source, root } = await fixture(t);
  const first = await catalog.install(source);
  await writeFile(join(source, 'demo.mjs'), 'export default { id: "demo", name: "new" };');
  await assert.rejects(catalog.install(source), /evaluat|promot/i);
  assert.equal((await catalog.current('demo')).entry.sha256, first.sha256);
  assert.equal((await catalog.versions('demo'))[0].sha256, first.sha256);
  assert.match(await readFile(join(root, 'plugins/demo.mjs'), 'utf8'), /id: "demo"/);
});

const code = result => `export default { id:'demo',name:'Demo',permissions:['files.read'],
  tools:[{name:'plugin.demo.answer',permission:'files.read',run:async()=>${JSON.stringify(result)}}],
  hooks:[{event:'never',run:async()=>{throw Error('hook activated')}}],
  providers:[{id:'never'}],channels:[{id:'never'}] };`;
const suite = { id: 'tasks', cases: [{ id: 'answer', tool: 'plugin.demo.answer', args: {}, expected: 'better' }] };
async function evaluations(t) {
  const f = await fixture(t);
  await writeFile(join(f.source, 'demo.mjs'), code('old'));
  const first = await f.catalog.install(f.source);
  await writeFile(join(f.source, 'demo.mjs'), code('better'));
  const grants = ['files.read'], disabled = [];
  // Execute only this test's local fixture host; inspect the real wall plan without changing owner settings.
  const { wallDeps, spawn, runs } = evaluationWall();
  const lifecycle = new PluginEvaluations({ store: f.saved, owner: 'owner', catalog: f.catalog,
    plugins: { granted: () => [...grants], disable: id => disabled.push(id) }, shelf: { record: () => null },
    wall: { unreadable: () => [join(f.root, 'owner')], timeoutMs: 2000, wallDeps, spawn } });
  await writeFile(join(f.source, 'demo.mjs'), code('old'));
  const initial = await lifecycle.evaluate({ id: 'demo', source: f.source, suite: { ...suite, cases: [{ ...suite.cases[0], expected: 'old' }] } });
  assert.equal(initial.baselineUnavailable, true);
  await lifecycle.promote('demo', initial.id);
  disabled.length = 0; runs.length = 0;
  await writeFile(join(f.source, 'demo.mjs'), code('better'));
  return { ...f, first, grants, disabled, runs, lifecycle };
}
test('real fixture tools run in separate host; comparable evidence promotes and restores the exact SHA', async t => {
  const f = await evaluations(t);
  const report = await f.lifecycle.evaluate({ id: 'demo', source: f.source, suite });
  assert.equal(report.baseline.passed, 0); assert.equal(report.candidate.passed, 1); assert.equal(report.passed, true);
  assert.equal(f.runs.length, 4); assert.deepEqual(f.disabled, []);
  const installed = await f.lifecycle.promote('demo', report.id);
  assert.equal(installed.sha256, report.candidateHash); assert.deepEqual(f.disabled, ['demo']);
  const restored = await f.lifecycle.restore('demo', pluginSourceHash(f.first, code('old')), report.candidateSourceHash);
  assert.equal(restored.sha256, f.first.sha256);
  assert.equal((await f.catalog.current('demo')).code, code('old'));
});
test('missing, malformed and empty fixtures never produce promotable evidence', async t => {
  const f = await evaluations(t);
  await assert.rejects(f.lifecycle.evaluate({ id: 'demo', source: f.source, suite: { id: 'empty', cases: [] } }));
  await assert.rejects(f.lifecycle.evaluate({ id: 'demo', source: f.source, suite: { id: 'bad', cases: [{ id: 'x', tool: 'x' }] } }));
  const report = await f.lifecycle.evaluate({ id: 'demo', source: f.source, suite: { id: 'missing', cases: [{ id: 'missing', tool: 'plugin.demo.missing', expected: null }] } });
  assert.equal(report.passed, false);
  await assert.rejects(f.lifecycle.promote('demo', report.id), /successful executable evaluation/);
});
test('permission revocation, candidate mutation and installed mutation invalidate promotion', async t => {
  const f = await evaluations(t);
  const report = await f.lifecycle.evaluate({ id: 'demo', source: f.source, suite });
  f.grants.length = 0;
  await assert.rejects(f.lifecycle.promote('demo', report.id), /permissions changed/);
  f.grants.push('files.read');
  await writeFile(join(f.source, 'branch-plugin.json'), JSON.stringify({ id: 'demo', name: 'Changed', permissions: ['files.read'] }));
  await assert.rejects(f.lifecycle.promote('demo', report.id), /Source/);
  await writeFile(join(f.root, 'plugins/demo.mjs'), code('tampered'));
  await assert.rejects(f.lifecycle.promote('demo', report.id), /source changed/);
  assert.deepEqual(f.disabled, []);
});
test('add-on replacement retains whole package metadata and safely restores after installation failure', async t => {
  const f = await fixture(t);
  let refuse = false;
  const shelf = new AddOnShelf({ store: f.saved, owner: 'owner', dataDir: join(f.root, 'data'),
    plugins: { disable() {} }, filters: { forget() {} }, vet: async () => { if (refuse) throw Error('local test vet failure'); } });
  const manifest = version => JSON.stringify({ format: 'branch-addon', id: 'demo', name: 'Demo', version,
    description: 'preserve me', author: 'Fixture', plugin: 'demo.mjs', permissions: ['files.read'] });
  await writeFile(join(f.source, 'branch-addon.json'), manifest('1'));
  await writeFile(join(f.source, 'demo.mjs'), code('old'));
  await writeFile(join(f.source, 'notes.md'), 'original ancillary file');
  const first = await shelf.install(f.source, { origin: { list: 'local-list', entry: 'demo', version: '1', signed: 'local' } });
  await writeFile(join(f.source, 'branch-addon.json'), manifest('2'));
  await writeFile(join(f.source, 'demo.mjs'), code('better'));
  const candidate = await shelf.look(f.source);
  await assert.rejects(shelf.replace('demo', f.source, first.sha256, candidate.offer.sha256), /Evaluate and promote/);
  assert.equal(shelf.record('demo').sha256, first.sha256);
  const second = await shelf.replace('demo', f.source, first.sha256, candidate.offer.sha256, { evaluated: true });
  const restored = await shelf.restore('demo', first.sha256, second.sha256);
  assert.deepEqual(restored.origin, first.origin); assert.equal(restored.description, 'preserve me'); assert.equal(restored.enabled, false);
  assert.equal((await shelf.currentFiles('demo')).get('notes.md'), 'original ancillary file');
  const realInstall = shelf.install.bind(shelf);
  f.saved.delete('settings', 'owner', 'plugin-review:demo'); // Previously approved package state to preserve on rollback.
  shelf.install = async (...args) => { await realInstall(...args); throw Error('injected install failure'); };
  await assert.rejects(shelf.replace('demo', f.source, first.sha256, candidate.offer.sha256, { evaluated: true }), /injected install failure/);
  shelf.install = realInstall;
  assert.equal(shelf.record('demo').sha256, first.sha256); assert.equal(await shelf.unchanged(shelf.record('demo')), true);
  assert.equal(f.saved.get('settings', 'owner', 'plugin-review:demo'), undefined);
  const again = await shelf.replace('demo', f.source, first.sha256, candidate.offer.sha256, { evaluated: true });
  const write = shelf.writeFiles.bind(shelf); let fail = true;
  shelf.writeFiles = async (...args) => { await write(...args); if (fail) { fail = false; throw Error('injected restore failure'); } };
  await assert.rejects(shelf.restore('demo', first.sha256, again.sha256), /injected restore failure/);
  assert.equal(shelf.record('demo').sha256, again.sha256);
  assert.equal(await shelf.unchanged(shelf.record('demo')), true);
  const signed = { ...shelf.record('demo'), origin: { list: 'signed-fixture', entry: 'demo', version: '2', signed: 'checked' } };
  f.saved.save('settings', 'owner', 'add-on:demo', signed);
  await assert.rejects(shelf.replace('demo', f.source, again.sha256, candidate.offer.sha256, { evaluated: true }), /checked signed update/);
  assert.deepEqual(shelf.record('demo').origin, signed.origin);
});
test('catalog storage failure restores the exact previous code and metadata', async t => {
  const f = await evaluations(t);
  const report = await f.lifecycle.evaluate({ id: 'demo', source: f.source, suite });
  const save = f.saved.save;
  let fail = true;
  f.saved.save = (table, owner, id, data) => {
    if (id === 'plugin-catalog:demo' && fail) { fail = false; throw Error('injected metadata failure'); }
    return save(table, owner, id, data);
  };
  await assert.rejects(f.lifecycle.promote('demo', report.id), /injected metadata failure/);
  assert.equal((await f.catalog.current('demo')).code, code('old'));
  assert.equal((await f.catalog.current('demo')).entry.sha256, f.first.sha256);
});
test('metadata-only versions have different retained identities and restore the original manifest', async t => {
  const f = await evaluations(t);
  await writeFile(join(f.source, 'demo.mjs'), code('old'));
  await writeFile(join(f.source, 'branch-plugin.json'), JSON.stringify({ id: 'demo', name: 'New name', version: '2', permissions: ['files.read'] }));
  const report = await f.lifecycle.evaluate({ id: 'demo', source: f.source, suite: { ...suite, cases: [{ ...suite.cases[0], expected: 'old' }] } });
  assert.equal(report.baselineHash, report.candidateHash);
  assert.notEqual(report.baselineSourceHash, report.candidateSourceHash);
  await f.lifecycle.promote('demo', report.id);
  const versions = await f.catalog.versions('demo');
  assert.equal(new Set(versions.map(row => row.versionSha256)).size, 2);
  const restored = await f.lifecycle.restore('demo', report.baselineSourceHash, report.candidateSourceHash);
  assert.equal(restored.name, 'Demo'); assert.equal(restored.version, '1');
});
/** Whether this computer has the real evaluation wall: WSL with Node and bubblewrap on Windows, bubblewrap on Linux. */
const strongWall = process.platform === 'win32' ? await wslReadiness(wslProbe) === null : (await wallReport()).available;
test('real strong wall executes a plugin fixture without reading or writing an outside canary',
  { skip: !strongWall && 'needs a real wall: WSL Node and bubblewrap on Windows, bubblewrap on Linux' }, async t => {
  const f = await fixture(t), canary = join(f.root, 'private-canary.txt');
  await writeFile(canary, 'private owner data');
  const target = process.platform === 'win32' ? wslPath(canary) : canary;
  const source = `import {readFile,writeFile} from 'node:fs/promises'; import {networkInterfaces} from 'node:os';
    export default {id:'demo',name:'Demo',permissions:['files.read'],tools:[{name:'plugin.demo.answer',permission:'files.read',run:async()=>{
      const readable=await readFile(${JSON.stringify(target)},'utf8').then(()=>true,()=>false);
      const writable=await writeFile(${JSON.stringify(target)},'changed').then(()=>true,()=>false);
      let externalInterfaces='refused';
      try { externalInterfaces=Object.values(networkInterfaces()).flat().filter(x=>x&&!x.internal).length; } catch {}
      return {readable,writable,externalInterfaces};
    }}]};`;
  const host = new WalledPlugins({ evaluation: true, policy: () => ({ walled: true, hosts: [] }), unreadable: () => [], timeoutMs: 15000 });
  const result = await host.ask(source, [], { kind: 'call', tool: 'plugin.demo.answer', args: {} });
  // Linux's seccomp filter refuses even listing the interfaces; WSL's held runner shows only loopback.
  const { externalInterfaces, ...files } = result.result;
  assert.deepEqual(files, { readable: false, writable: false });
  assert.ok(externalInterfaces === 0 || externalInterfaces === 'refused', `no outside network: ${externalInterfaces}`);
  assert.equal(await readFile(canary, 'utf8'), 'private owner data');
});
test('fresh installation cannot activate before proof and concurrent enable cannot cross a lifecycle lock', async t => {
  const f = await fixture(t), registered = [];
  await writeFile(join(f.source, 'demo.mjs'), code('old'));
  await f.catalog.install(f.source);
  const plugins = new Plugins(f.saved, 'owner', { register: tool => registered.push(tool), unregister() {} }, join(f.root, 'plugins'));
  await assert.rejects(plugins.enable('demo'), /staged/);
  const done = await evaluations(t);
  const real = new Plugins(done.saved, 'owner', { register: tool => registered.push(tool), unregister() {} }, join(done.root, 'plugins'));
  let releaseLoad, started;
  const loading = new Promise(resolve => { started = resolve; });
  real.isolation = { holds: () => true, load: async () => { started(); return new Promise(resolve => { releaseLoad = resolve; }); } };
  const enabling = real.enable('demo'); await loading;
  const releaseLock = real.holdLifecycle('demo');
  await assert.rejects(real.enable('demo'), /promoted or restored/);
  releaseLock();
  releaseLoad({ id: 'demo', name: 'Demo', permissions: ['files.read'], tools: [{ name: 'plugin.demo.answer', permission: 'files.read', run: async () => 'old' }] });
  await assert.rejects(enabling, /changed during activation/);
  assert.deepEqual(registered, []);
});
test('a never-installed candidate requires exact manifest-and-code proof at the final copy', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'demo.mjs'), code('better'));
  const lifecycle = new PluginEvaluations({ store: f.saved, owner: 'owner', catalog: f.catalog,
    plugins: { granted: () => [], disable() {} }, shelf: { record: () => null }, wall: { unreadable: () => [], timeoutMs: 15000, ...evaluationWall() } });
  const report = await lifecycle.evaluate({ id: 'demo', source: f.source, suite });
  assert.equal(report.baselineUnavailable, true); assert.equal(report.baselineHash, ''); assert.equal(report.passed, true);
  const install = f.catalog.install.bind(f.catalog);
  f.catalog.install = async (...args) => {
    await writeFile(join(f.source, 'branch-plugin.json'), JSON.stringify({ id: 'demo', name: 'Swapped at copy', permissions: ['files.read'] }));
    return install(...args);
  };
  await assert.rejects(lifecycle.promote('demo', report.id), /manifest or code changed/);
  await assert.rejects(f.catalog.current('demo'), { code: 'ENOENT' });
  f.catalog.install = install;
  const current = await lifecycle.evaluate({ id: 'demo', source: f.source, suite });
  await lifecycle.promote('demo', current.id);
  assert.equal((await f.catalog.current('demo')).entry.name, 'Swapped at copy');
  assert.equal((await lifecycle.status('demo')).pending, false);
});
test('unsupported plugin API versions cannot earn successful evaluation evidence', async t => {
  const f = await evaluations(t);
  await writeFile(join(f.source, 'demo.mjs'), code('better').replace('export default {', 'export default { apiVersion:999,'));
  const report = await f.lifecycle.evaluate({ id: 'demo', source: f.source, suite });
  assert.equal(report.passed, false);
  assert.match(report.candidate.cases[0].error, /interface 999/);
  await assert.rejects(f.lifecycle.promote('demo', report.id), /successful executable evaluation/);
});
