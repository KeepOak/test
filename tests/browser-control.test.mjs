import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserControls } from '../dist/browser-control.js';

const binding = { owner: 'isolated-owner', conversation: 'isolated-conversation', profile: 'trunk-isolated' };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const command = (control, sequence = 1, tabId = control.view().tabs[0]) => ({ epoch: control.view().epoch,
  writer: control.view().writer, sequence, tabId });
const rejects = (work, pattern = /control|revoked|stopped/) => assert.rejects(async () => work(), pattern);

test('browser binding is stable and isolated across owners, conversations and profiles; runs do not own its lifetime', async () => {
  const controls = new BrowserControls(), control = controls.ensure(binding, 'window-a');
  assert.equal(controls.ensure(binding, 'window-b'), control, 'opening another window never silently grants it control');
  for (const changed of [{ owner: 'other' }, { conversation: 'other' }, { profile: 'other' }, { profile: null }]) {
    const scope = { ...binding, ...changed }, other = controls.ensure(scope, 'window-a');
    assert.notEqual(other.id, control.id);
    assert.throws(() => controls.get(scope, control.id), /not found/);
  }
  controls.bindRun(binding, control.id, 'run-a');
  assert.equal(controls.forRun(binding.owner, 'run-a'), control);
  assert.equal(controls.forRun('other', 'run-a'), null);
  assert.throws(() => controls.bindRun({ ...binding, profile: 'other' }, controls.ensure({ ...binding, profile: 'other' }, 'window-a').id, 'run-a'), /another browser/);
  await control.handBack(control.view().epoch, 'window-a', 'run-a');
  controls.finishRun(binding.owner, 'run-a');
  assert.equal(controls.forRun(binding.owner, 'run-a'), null);
  assert.equal(control.view().writer, null, 'finishing an agent task grants nobody authority');
  assert.equal(controls.ensure(binding, 'window-a').id, control.id);
  const leaked = control.view(); leaked.binding.owner = 'other'; leaked.tabs.length = 0;
  assert.deepEqual(control.view().binding, binding);
  assert.equal(control.view().tabs.length, 1);
});

test('exclusive writes preserve order, reject duplicates and gaps, and use immutable tab identity', async () => {
  const control = new BrowserControls().ensure(binding, 'window'), hold = deferred(), entered = deferred(), effects = [];
  const first = control.write(command(control), async (write) => { effects.push('first'); entered.resolve(); await hold.promise; write.check(); return 'done'; });
  await entered.promise;
  const second = control.write(command(control, 2), async () => { effects.push('second'); });
  assert.deepEqual(effects, ['first']);
  assert.throws(() => control.write(command(control, 2), async () => {}), /duplicated/);
  assert.throws(() => control.write(command(control, 4), async () => {}), /out of order/);
  assert.throws(() => control.write(command(control, 3, 'unknown'), async () => {}), /tab/);
  hold.resolve(); await first; await second;
  assert.deepEqual(effects, ['first', 'second']);
  const tab = await control.write(command(control, 3), async (write) => write.addTab());
  await control.write(command(control, 4), async (write) => write.closeTab(tab));
  assert.throws(() => control.write(command(control, 5, tab), async () => {}), /tab/);
  await rejects(() => control.write(command(control, 5), async (write) => write.closeTab(control.view().tabs[0])), /last tab/);
});

test('takeover blocks new agent writes and waits for the held effect; queued old actions never replay', async () => {
  const controls = new BrowserControls(), control = controls.ensure(binding, 'window'), hold = deferred(), entered = deferred();
  controls.bindRun(binding, control.id, 'run');
  await control.handBack(control.view().epoch, 'window', 'run');
  const old = command(control), effects = [];
  const active = control.write(old, async () => { effects.push('already started'); entered.resolve(); await hold.promise; });
  const activeRejected = rejects(() => active);
  await entered.promise;
  const queued = control.write({ ...old, sequence: 2 }, async () => effects.push('must not run'));
  const queuedRejected = rejects(() => queued);
  const transfer = control.takeOver(old.epoch, 'window');
  assert.equal(control.view().state, 'transferring');
  assert.equal(control.view().writer, null);
  assert.throws(() => control.write({ ...old, sequence: 3 }, async () => {}), /control/);
  await Promise.resolve(); assert.equal(control.view().state, 'transferring', 'no concurrent owner writer');
  hold.resolve(); await activeRejected; await queuedRejected;
  const owned = await transfer;
  assert.equal(owned.state, 'owner');
  assert.deepEqual(effects, ['already started']);
  assert.throws(() => control.write(old, async () => {}), /control/);
  await control.write(command(control), async () => effects.push('owner'));
  assert.deepEqual(effects, ['already started', 'owner']);
});

test('handback drains owner input; disconnect revokes the in-flight transfer without automatic agent authority', async () => {
  const controls = new BrowserControls(), control = controls.ensure(binding, 'window'), hold = deferred(), entered = deferred();
  controls.bindRun(binding, control.id, 'run');
  const active = control.write(command(control), async (write) => { entered.resolve(); await hold.promise; write.check(); });
  const activeRejected = rejects(() => active);
  await entered.promise;
  const transferring = control.handBack(control.view().epoch, 'window', 'run');
  const transferRejected = rejects(() => transferring);
  control.disconnect('window');
  hold.resolve(); await activeRejected; await transferRejected;
  assert.equal(control.view().state, 'owner');
  assert.equal(control.view().writer, null);
  assert.throws(() => control.write({ ...command(control), writer: { kind: 'agent', id: 'run' } }, async () => {}), /control/);
  await control.takeOver(control.view().epoch, 'reconnected-window');
  await control.handBack(control.view().epoch, 'reconnected-window', 'run');
  assert.equal(control.view().state, 'agent', 'only an explicit new handback grants the agent');
});

test('Stop aborts active and queued writes and cannot be undone by a late transfer or same-session reconnect', async () => {
  const controls = new BrowserControls(), control = controls.ensure(binding, 'window'), hold = deferred(), entered = deferred();
  let signal, calls = 0;
  const active = control.write(command(control), async (write) => { signal = write.signal; entered.resolve(); await hold.promise; write.check(); calls++; });
  const activeRejected = rejects(() => active);
  await entered.promise;
  const queued = control.write(command(control, 2), async () => calls++), queuedRejected = rejects(() => queued);
  const transferring = control.takeOver(control.view().epoch, 'window'), transferRejected = rejects(() => transferring);
  controls.stop(binding, control.id);
  assert.equal(signal.aborted, true);
  hold.resolve(); await activeRejected; await queuedRejected; await transferRejected;
  assert.equal(calls, 0);
  assert.equal(control.view().state, 'stopped');
  await rejects(() => control.takeOver(control.view().epoch, 'window'));
  const replacement = controls.ensure(binding, 'window');
  assert.notEqual(replacement.id, control.id);
  assert.throws(() => controls.get(binding, control.id), /not found/);
});

test('owner disconnect and agent completion revoke held writes, while irrelevant disconnects do nothing', async () => {
  for (const writer of ['owner', 'agent']) {
    const controls = new BrowserControls(), control = controls.ensure(binding, 'window'), hold = deferred(), entered = deferred();
    controls.bindRun(binding, control.id, 'run');
    if (writer === 'agent') await control.handBack(control.view().epoch, 'window', 'run');
    const before = control.view(); control.disconnect('unrelated-window'); assert.deepEqual(control.view(), before);
    let effects = 0;
    const work = control.write(command(control), async (write) => { entered.resolve(); await hold.promise; write.check(); effects++; });
    const stopped = rejects(() => work);
    await entered.promise;
    if (writer === 'owner') control.disconnect('window'); else controls.finishRun(binding.owner, 'run');
    hold.resolve(); await stopped;
    assert.equal(effects, 0);
    assert.equal(control.view().writer, null);
    assert.equal(control.view().state, 'owner');
  }
});

test('the bounded input queue fails closed and releases capacity after revocation', async () => {
  const control = new BrowserControls().ensure(binding, 'window'), hold = deferred(), entered = deferred();
  const writes = [control.write(command(control), async () => { entered.resolve(); await hold.promise; })];
  await entered.promise;
  for (let sequence = 2; sequence <= 32; sequence++) writes.push(control.write(command(control, sequence), async () => assert.fail('revoked queue ran')));
  const outcomes = Promise.allSettled(writes);
  assert.throws(() => control.write(command(control, 33), async () => {}), /Too much/);
  control.disconnect('window'); hold.resolve();
  assert.ok((await outcomes).every((outcome) => outcome.status === 'rejected'));
  await control.takeOver(control.view().epoch, 'window');
  assert.equal(await control.write(command(control), async () => 'fresh'), 'fresh');
});

test('a fresh grant to the same owner still refuses old epochs and unbound handbacks', async () => {
  const control = new BrowserControls().ensure(binding, 'window'), old = command(control);
  await rejects(() => control.handBack(control.view().epoch, 'other-window', 'run'));
  await rejects(() => control.handBack(control.view().epoch, 'window', 'unbound'), /not bound/);
  await control.takeOver(control.view().epoch, 'window');
  assert.throws(() => control.write(old, async () => assert.fail('old input replayed')), /control/);
  await control.write(command(control), async () => 'fresh');
  const stopped = control.stop();
  assert.deepEqual(control.stop(), stopped, 'Stop settles once');
});

test('a dispatched tab effect reconciles during transfer, but bookkeeping expires with its operation', async () => {
  const control = new BrowserControls().ensure(binding, 'window'), hold = deferred(), entered = deferred();
  let write;
  const active = control.write(command(control), async (current) => { write = current; entered.resolve(); await hold.promise; current.addTab(); });
  const rejected = rejects(() => active);
  await entered.promise;
  const transfer = control.takeOver(control.view().epoch, 'window');
  hold.resolve(); await rejected;
  assert.equal((await transfer).tabs.length, 2, 'the next writer sees the completed tab effect');
  assert.throws(() => write.addTab(), /already finished/);
  control.stop();
  assert.throws(() => write.closeTab(control.view().tabs[0]), /stopped/);
});

test('a task in the conversation takes the browser only when nobody drives it, and waits (never fails) while the owner has it', async () => {
  const controls = new BrowserControls(), control = controls.ensure(binding, 'window-a');
  controls.bindRun(binding, control.id, 'task-a', true);
  const stop = new AbortController();
  let turned = false;
  const turn = control.agentTurn('task-a', stop.signal).then(() => { turned = true; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(turned, false, 'the owner window holds it, so the step waits');
  assert.equal(control.view().waiting, 'task-a', 'the window can offer Hand back to the waiting task');
  await control.handBack(control.view().epoch, 'window-a', 'task-a');
  await turn;
  assert.deepEqual(control.view().writer, { kind: 'agent', id: 'task-a' });
  assert.equal(control.view().waiting, null);
  await control.takeOver(control.view().epoch, 'window-a');
  assert.equal(control.view().paused, 'task-a', 'taking over from the task pauses it');
  control.disconnect('window-a');
  assert.equal(control.view().writer, null);
  const late = control.agentTurn('task-a', stop.signal, 50);
  await assert.rejects(late, /haven't handed it back/, 'a lapsed owner window never resumes a paused task by itself');
  await control.handBack(control.view().epoch, 'window-b', 'task-a'); // nobody holds it: the owner's window hands back
  await control.agentTurn('task-a', stop.signal);
  assert.equal(control.view().paused, null);
  controls.bindRun(binding, control.id, 'task-b', true);
  await assert.rejects(control.agentTurn('task-b', stop.signal), /Another task/);
  controls.finishRun(binding.owner, 'task-a');
  await control.agentTurn('task-b', stop.signal);
  assert.deepEqual(control.view().writer, { kind: 'agent', id: 'task-b' }, 'nobody driving: the task takes it');
  const carrier = new AbortController();
  controls.bindRun(binding, control.id, 'owner-command');
  await control.agentTurn('owner-command', carrier.signal); // a run bound for one owner command gets no turn of its own
  assert.deepEqual(control.view().writer, { kind: 'agent', id: 'task-b' });
  await control.takeOver(control.view().epoch, 'window-a');
  const waiting = control.agentTurn('task-b', stop.signal);
  stop.abort(new Error('Cancelled by user'));
  await assert.rejects(waiting, /Cancelled/);
});

test('an owner takeover of a task window starts with the task as writer, one id per open tab', async () => {
  const controls = new BrowserControls();
  const control = controls.adopt(binding, 'window-a', 'task-a', 3);
  assert.equal(control.view().tabs.length, 3);
  assert.deepEqual(control.view().writer, { kind: 'agent', id: 'task-a' });
  assert.equal(controls.forRun(binding.owner, 'task-a'), control);
  assert.equal(controls.forConversation(binding.owner, binding.conversation), control);
  assert.throws(() => controls.adopt(binding, 'window-a', 'task-b', 1), /already has a Branch browser/);
  await control.takeOver(control.view().epoch, 'window-a');
  assert.equal(control.view().paused, 'task-a');
  control.stop();
  assert.equal(controls.forConversation(binding.owner, binding.conversation), null);
});
