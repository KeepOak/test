/**
 * SELF-302: host commands take turns per folder instead of one at a time for the whole engine. A second command from
 * any helper or conversation used to be refused at once ("A host command is already active"), so helpers started
 * together could not build or test in their own copies. Only `node -e` children are started: no window, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discardTemp } from './temp-dir.mjs';
import { createBranch } from '../dist/index.js';
import { BranchShell } from '../dist/integrations/shell.js';
import { CommandTurns, projectRoot } from '../dist/integrations/command-turns.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'branch-shell-turns-'));
  const app = await createBranch({ workspace: join(root, 'workspace'), dataDir: join(root, 'private') });
  const shell = new BranchShell({ executables: { node: { path: process.execPath } } }, process.env);
  await shell.ready();
  t.after(async () => { await shell.close(); await app.close(); await discardTemp(root); });
  // Two helpers' own copies of the project, as git worktrees are: a `.git` file in each.
  const copies = {};
  for (const name of ['copy-a', 'copy-b']) {
    copies[name] = join(app.runtime.workspace, name);
    await mkdir(copies[name], { recursive: true });
    await writeFile(join(copies[name], '.git'), `gitdir: ${join(root, 'repo', '.git', 'worktrees', name)}\n`);
  }
  const context = (runId, workspace = app.runtime.workspace) => ({ ...app.runtime.context({ runId }), workspace });
  return { app, shell, copies, context, root };
}
/** A command that says when it started and ended, and takes a moment in between. */
const timed = (ms = 700) => ({ executable: 'node', args: ['-e', `const s = Date.now(); setTimeout(() => console.log(JSON.stringify({ s, e: Date.now() })), ${ms});`], cwd: '.', secrets: [] });
const span = (result) => { assert.equal(result.status, 'completed', result.stderr); return JSON.parse(result.stdout); };
/**
 * A command that leaves its mark and waits for the other's: "met" when both ran at once, "alone" when the other never
 * came while it ran, so the proof does not hang on how quickly this computer starts programs.
 */
const meet = (mine, other) => ({ executable: 'node', args: ['-e', "const fs = require('node:fs'); const [mine, other] = process.argv.slice(1);"
  + " fs.writeFileSync(mine, ''); const end = Date.now() + 15000; const t = setInterval(() => {"
  + " if (fs.existsSync(other)) { clearInterval(t); console.log('met'); } else if (Date.now() > end) { clearInterval(t); console.log('alone'); } }, 20);",
  mine, other], cwd: '.', secrets: [] });
const met = (result) => { assert.equal(result.status, 'completed', result.stderr); return result.stdout.trim(); };
async function exists(path, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 20)))
    if (await stat(path).then(() => true, () => false)) return true;
  return false;
}

test('two helpers in their own copies run their commands at the same time', async (t) => {
  const f = await fixture(t);
  const [a, b] = [join(f.root, 'a.mark'), join(f.root, 'b.mark')];
  const [one, two] = await Promise.all([
    f.shell.execute(meet(a, b), f.context('helper-a', f.copies['copy-a'])),
    f.shell.execute(meet(b, a), f.context('helper-b', f.copies['copy-b'])),
  ]);
  assert.deepEqual([met(one), met(two)], ['met', 'met'], 'the two ran side by side');
});

test('two commands in the same copy take turns instead of the second being refused', async (t) => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([
    f.shell.execute(timed(), f.context('helper-a', f.copies['copy-a'])),
    f.shell.execute(timed(), f.context('helper-a2', f.copies['copy-a'])),
  ]);
  const one = span(a), two = span(b);
  const [first, second] = one.s <= two.s ? [one, two] : [two, one];
  assert.ok(second.s >= first.e, `the second waited for the first: ${JSON.stringify({ first, second })}`);
});

test('commands in different projects of one workspace run side by side; the workspace itself is one folder', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.copies['copy-a'], 'src'));
  assert.equal(await projectRoot(join(f.copies['copy-a'], 'src'), f.app.runtime.workspace), await realpath(f.copies['copy-a']));
  assert.equal(await projectRoot(f.app.runtime.workspace, f.app.runtime.workspace), await realpath(f.app.runtime.workspace));
  const [a, b] = [join(f.root, 'a.mark'), join(f.root, 'b.mark')];
  const [one, two] = await Promise.all([
    f.shell.execute({ ...meet(a, b), cwd: 'copy-a' }, f.context('conversation-1')),
    f.shell.execute({ ...meet(b, a), cwd: 'copy-b' }, f.context('conversation-2')),
  ]);
  assert.deepEqual([met(one), met(two)], ['met', 'met'], 'the two ran side by side');
});

test('a command waiting for its turn is stopped with its run, and a turn not given in time says why', async (t) => {
  const f = await fixture(t);
  const mark = join(f.root, 'first.mark');
  // The first holds the copy until it gives up waiting for a mark nobody makes.
  const running = f.shell.execute({ ...meet(mark, join(f.root, 'never.mark')), timeoutMs: 30000 }, f.context('first', f.copies['copy-a']));
  assert.ok(await exists(mark), 'the first command started');
  const waiting = f.shell.execute(timed(), f.context('second', f.copies['copy-a']));
  await new Promise((resolve) => setTimeout(resolve, 200));
  await f.shell.closeRun({ owner: f.app.runtime.owner, runId: 'second' });
  await assert.rejects(waiting, /Run finished/);
  await f.shell.closeRun({ owner: f.app.runtime.owner, runId: 'first' });
  assert.equal((await running).status, 'cancelled');

  const turns = new CommandTurns(8);
  const release = await turns.take('/w/copy-a', new AbortController().signal, 1000);
  await assert.rejects(turns.take('/w/copy-a', new AbortController().signal, 50), /Another command was still running in \/w\/copy-a/);
  const later = turns.take('/w/copy-a', new AbortController().signal, 1000);
  release();
  (await later)();
  // A copy inside the project (.branch-worktrees) and the project itself are one place; copies side by side are not.
  const nested = new CommandTurns(8), project = join(tmpdir(), 'w'), copy = join(project, '.branch-worktrees', 'helper-1');
  const inCopy = await nested.take(copy, new AbortController().signal, 1000);
  await assert.rejects(nested.take(project, new AbortController().signal, 50), /Another command was still running/);
  const sibling = await nested.take(join(project, '.branch-worktrees', 'helper-2'), new AbortController().signal, 50);
  let rootStarted = false;
  const root = nested.take(project, new AbortController().signal, 1000).then((release) => { rootStarted = true; return release; });
  // A later command in another copy waits behind the project's command that came first, instead of starving it.
  let laterStarted = false;
  const later2 = nested.take(join(project, '.branch-worktrees', 'helper-3'), new AbortController().signal, 1000).then((release) => { laterStarted = true; return release; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(laterStarted, false, 'the later copy waits behind the project');
  inCopy(); sibling();
  const releaseRoot = await root;
  assert.ok(rootStarted);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(laterStarted, false, 'and still waits while the project runs');
  releaseRoot();
  (await later2)();
  assert.ok(laterStarted);
  // The engine as a whole is bounded too.
  const one = new CommandTurns(1);
  const held = await one.take('/w/a', new AbortController().signal, 1000);
  await assert.rejects(one.take('/w/b', new AbortController().signal, 50), /1 commands were still running/);
  held();
});
