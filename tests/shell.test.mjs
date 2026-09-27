import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, copyFile, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBranch } from '../dist/index.js';
import { BranchShell, registerShell } from '../dist/integrations/shell.js';
import { loadIntegrations } from '../dist/integrations/bootstrap.js';
import { ShellConfigSchema } from '../dist/integrations/shell-config.js';

const fakeEnv = { ...process.env, BRANCH_API_KEY: 'MODEL_SECRET', BW_SESSION: 'VAULT_SECRET', BWS_ACCESS_TOKEN: 'BWS_SECRET', NODE_OPTIONS: '--invalid-fixture-option' };
async function fixture(t, settings = {}, provider) {
  const scratch = join(tmpdir(), 'Codex-session-files');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'branch-shell-'));
  const app = await createBranch({ workspace: join(root, 'workspace'), dataDir: join(root, 'private'), ...(provider ? { provider } : {}) });
  const script = join(app.runtime.workspace, 'worker.mjs');
  await copyFile('tests/fixtures/shell-worker.mjs', script);
  const config = { executables: { node: { path: process.execPath }, fixture: { path: process.execPath, args: [script] } }, ...settings };
  const shell = new BranchShell(config, fakeEnv);
  await shell.ready(); registerShell(app.registry, shell);
  // A process let go a moment ago can still hold its working folder for a few milliseconds on Windows.
  t.after(async () => { await shell.close(); await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  return { app, shell, root, config, context: () => app.runtime.context({ runId: 'fixture-run' }) };
}
async function waitForPids(path) {
  for (let attempt = 0; attempt < 600; attempt++) {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch { await delay(10); }
  }
  assert.fail('Fixture process did not start');
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function gone(pid) {
  for (let attempt = 0; attempt < 200 && alive(pid); attempt++) await delay(10);
  assert.equal(alive(pid), false, `Fixture PID ${pid} survived`);
}
function cleanupPids(t, pids) {
  t.after(() => {
    for (const pid of Object.values(pids)) if (alive(pid)) process.kill(pid, 'SIGKILL');
  });
}

test('opt-in shell executes real workspace project commands with literal argument arrays', async (t) => {
  const f = await fixture(t);
  const result = await f.app.registry.execute('shell.execute', { executable: 'fixture', args: ['build', 'space ; & literal'] }, f.context());
  assert.equal(result.status, 'completed'); assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout).args, ['space ; & literal']);
  assert.deepEqual(JSON.parse(await readFile(join(f.app.runtime.workspace, 'out/result.json'), 'utf8')), [1, 4, 9]);
  assert.equal(result.target.cwd, f.app.runtime.workspace);
  assert.equal(result.target.executable, process.execPath);
  assert.ok(result.durationMs >= 0);
  assert.match(result.cleanup.limitation, /not OS isolation/);
  const check = await f.app.registry.execute('shell.execute', { executable: 'node', args: ['--check', 'worker.mjs'] }, f.context());
  assert.equal(check.exitCode, 0);
});

test('a tool-backed runtime run persists actual host execution evidence', async (t) => {
  let calls = 0;
  const provider = { name: 'shell-runtime-fixture', async complete(request) {
    if (++calls === 1) return { content: '', toolCalls: [{ id: 'build', name: 'shell.execute', arguments: '{"executable":"fixture","args":["build"]}' }] };
    const result = JSON.parse(request.messages.at(-1).content).result;
    assert.equal(result.exitCode, 0); assert.match(result.stdout, /out\/result.json/);
    return { content: 'Build verified from exit status and captured output', toolCalls: [] };
  } };
  const f = await fixture(t, {}, provider);
  // Batch 26 (wave 8): a command nobody has ruled on is now asked about, so this test says up front
  // that this one is allowed. Everything it is actually checking is unchanged.
  f.app.store.save('settings', f.app.runtime.owner, 'policy',
    { preset: 'custom', rules: [{ tool: 'shell.execute', match: '*', applies: 'any', decision: 'allow', remember: 'session' }], limits: {}, unmatchedCommands: 'ask' });
  const run = await f.app.runtime.run({ prompt: 'Build the project' });
  assert.equal(run.status, 'completed');
  const evidence = f.app.store.events(run.id).find(event => event.kind === 'tool.completed');
  assert.equal(evidence.data.name, 'shell.execute');
  assert.equal(evidence.data.result.target.alias, 'fixture');
  assert.equal(evidence.data.result.exitCode, 0);
});

test('shell environment excludes model/vault keys and rejects unselected env configuration', async (t) => {
  const f = await fixture(t, { env: { CI: 'fixture-ci' } });
  const result = await f.shell.execute({ executable: 'fixture', args: ['env'] }, f.context());
  const env = JSON.parse(result.stdout);
  assert.equal(env.CI, 'fixture-ci');
  for (const name of ['BRANCH_API_KEY', 'BW_SESSION', 'BWS_ACCESS_TOKEN', 'NODE_OPTIONS']) assert.equal(env[name], undefined);
  assert.equal(env.PATH, '');
  assert.doesNotMatch(result.stdout, /MODEL_SECRET|VAULT_SECRET|BWS_SECRET/);
  assert.throws(() => ShellConfigSchema.parse({ ...f.config, inheritEnv: ['BRANCH_API_KEY'] }));
  assert.throws(() => ShellConfigSchema.parse({ ...f.config, env: { NODE_OPTIONS: '--inspect' } }));
  await assert.rejects(f.app.registry.execute('shell.execute', { executable: 'node', env: { TOKEN: 'x' } }, f.context()));
});

test('shell rejects denied aliases, permissions, traversal, and linked cwd', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.shell.execute({ executable: 'missing' }, f.context()), /not configured/);
  await assert.rejects(f.app.registry.execute('shell.execute', { executable: 'node' }, f.app.runtime.context({ permissions: [] })), /Permission denied/);
  for (const cwd of ['..', '../private', f.root])
    await assert.rejects(f.shell.execute({ executable: 'node', cwd }, f.context()), /Path denied/);
  const outside = join(f.root, 'outside'); await mkdir(outside);
  await symlink(outside, join(f.app.runtime.workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.shell.execute({ executable: 'node', cwd: 'linked' }, f.context()), /link/i);
  assert.throws(() => new BranchShell({ executables: { node: { path: 'node' } } }));
  const batch = new BranchShell({ executables: { npm: { path: resolve('npm.cmd') } } });
  await assert.rejects(batch.ready(), /native executable/);
});

test('shell captures nonzero exit, bounds output, and enforces timeout', async (t) => {
  // Exit codes, output caps and timeouts are measured without a job object. The configured maximum is
  // generous: a loaded Windows runner took over half a second just to start node for the failing
  // command, which then read as a timeout. Only the held command is given a short limit of its own.
  const f = await fixture(t, { maxOutputBytes: 1024, timeoutMs: 60000, useJobObject: false });
  const failed = await f.shell.execute({ executable: 'fixture', args: ['fail'] }, f.context());
  assert.equal(failed.exitCode, 7); assert.equal(failed.status, 'failed');
  assert.match(failed.stdout, /before failure/); assert.match(failed.stderr, /compilation failed/);
  const flooded = await f.shell.execute({ executable: 'fixture', args: ['flood'] }, f.context());
  assert.equal(flooded.status, 'output_limit'); assert.equal(flooded.truncated, true);
  assert.ok(Buffer.byteLength(flooded.stdout) + Buffer.byteLength(flooded.stderr) <= 1024);
  const timed = await f.shell.execute({ executable: 'fixture', args: ['hold'], timeoutMs: 100 }, f.context());
  assert.equal(timed.status, 'timed_out'); assert.ok(timed.durationMs < 8000);
  await assert.rejects(f.shell.execute({ executable: 'fixture', timeoutMs: 60001 }, f.context()), /maximum/);
});

test('returned output obeys its combined UTF-8 byte limit for invalid bytes and split Unicode', async (t) => {
  const f = await fixture(t, { maxOutputBytes: 256 });
  for (const count of [128, 257]) {
    const result = await f.shell.execute({ executable: 'fixture', args: ['invalid-bytes', String(count)] }, f.context());
    assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 256);
    assert.equal(result.truncated, true);
    if (count === 128) {
      assert.equal(result.status, 'completed', 'Decoded replacement characters alone exceed the limit');
      assert.ok(result.observedOutputBytes < 256);
    }
  }
  const unicode = await f.shell.execute({ executable: 'fixture', args: ['split-unicode'] }, f.context());
  assert.equal(unicode.stdout, '☃🙂'.repeat(20));
  assert.doesNotMatch(unicode.stdout + unicode.stderr, /\uFFFD/);
  assert.ok(Buffer.byteLength(unicode.stdout) + Buffer.byteLength(unicode.stderr) <= 256);
  assert.equal(unicode.truncated, true);
  const cut = await f.shell.execute({ executable: 'fixture', args: ['unicode-limit'] }, f.context());
  assert.equal(cut.stderr, 'ok');
  assert.equal(cut.stdout, '☃'.repeat(84));
  assert.doesNotMatch(cut.stdout + cut.stderr, /\uFFFD/);
  assert.equal(cut.truncated, true);
});

test('cancellation terminates a running parent and its child before returning', async (t) => {
  const f = await fixture(t), controller = new AbortController();
  const path = join(f.app.runtime.workspace, 'pids.json');
  const pending = f.shell.execute({ executable: 'fixture', args: ['tree', path] }, { ...f.context(), signal: controller.signal });
  const pids = await waitForPids(path); cleanupPids(t, pids);
  assert.equal(alive(pids.parent), true); assert.equal(alive(pids.child), true);
  controller.abort(new Error('Cancel fixture'));
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  await gone(pids.parent); await gone(pids.child);
  assert.equal(result.cleanup.status, 'tree_termination_requested');
});

test('shell shutdown drains running parent and child and rejects new commands', async (t) => {
  const f = await fixture(t), path = join(f.app.runtime.workspace, 'pids.json');
  const pending = f.shell.execute({ executable: 'fixture', args: ['tree', path] }, f.context());
  const pids = await waitForPids(path); cleanupPids(t, pids);
  await f.shell.close(); assert.equal((await pending).status, 'cancelled');
  await gone(pids.parent); await gone(pids.child);
  await assert.rejects(f.shell.execute({ executable: 'node' }, f.context()), /closed/);
});

test('parent exit with a descendant holding pipes returns bounded cleanup status', async (t) => {
  const f = await fixture(t), path = join(f.app.runtime.workspace, 'pids.json');
  const pending = f.shell.execute({ executable: 'fixture', args: ['orphan', path] }, f.context());
  const pids = await waitForPids(path); cleanupPids(t, pids);
  const result = await pending;
  assert.ok(result.durationMs < 8000);
  assert.match(result.cleanup.limitation, /may survive/);
  if (process.platform === 'win32') {
    assert.equal(result.status, 'descendant_pipes');
    assert.equal(result.cleanup.status, 'incomplete');
    // A job object kills the orphan as it is let go; without one, the old limitation still holds.
    if (result.isolation === 'job-object') await gone(pids.child);
    else {
      assert.equal(alive(pids.child), true, 'The result must honestly identify the Windows orphan limitation');
      process.kill(pids.child, 'SIGKILL');
    }
  } else assert.equal(result.status, 'descendant_pipes');
  await gone(pids.parent); await gone(pids.child);
  await f.shell.close();
});

test('runtime shutdown cancels command execution and waits for its child processes', async (t) => {
  const f = await fixture(t), path = join(f.app.runtime.workspace, 'pids.json');
  const pending = f.app.runtime.executeTool('shell.execute', { executable: 'fixture', args: ['tree', path] }, { mode: 'owner' });
  const rejected = assert.rejects(pending, /shutting down/);
  const pids = await waitForPids(path); cleanupPids(t, pids);
  await f.app.close(); await rejected;
  await gone(pids.parent); await gone(pids.child);
});

test('with no settings file only programs installed here are offered, and a settings file replaces them', async (t) => {
  const f = await fixture(t), configPath = join(f.root, 'integrations.json');
  const registry = new (f.app.registry.constructor)();
  // Dogfood A2: nothing on PATH means nothing to run, so still no command tool. Branch's own browser ships on regardless.
  const off = await loadIntegrations(registry, undefined, { PATH: join(f.root, 'no-programs-here') });
  assert.equal(off.count, 1, 'only the browser');
  assert.equal(registry.permissions().includes('shell.execute'), false);
  await off.close();
  await writeFile(configPath, JSON.stringify({ shell: f.config }));
  const on = await loadIntegrations(registry, configPath, fakeEnv); t.after(on.close);
  assert.equal(on.count, 1); assert.equal(registry.permissions().includes('shell.execute'), true);
  assert.throws(() => f.shell.execute({ executable: 'node', args: 'invalid' }, f.context()));
  assert.equal((await f.shell.execute({ executable: 'fixture', args: ['build'] }, f.context())).status, 'completed');
});
