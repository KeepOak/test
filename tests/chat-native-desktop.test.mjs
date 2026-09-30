import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBranch } from '../dist/index.js';
import { DesktopControl } from '../dist/integrations/desktop.js';
import { DesktopBanner } from '../dist/integrations/desktop-banner.js';
import { saveDesktopSettings } from '../dist/integrations/desktop-config.js';
import { discardTemp } from './temp-dir.mjs';
const target = { kind: 'monitor', deviceName: 'FAKE-DISPLAY', bounds: { x: 0, y: 0, w: 640, h: 360 } };
const window = { handle: '7', title: 'Fake Notes', program: 'stand-in', className: 'stand-in', processId: 42, minimised: false, x: 10, y: 20, width: 100, height: 200 };
async function world(t) {
  const root = await mkdtemp(join(tmpdir(), 'branch-chat-native-'));
  const app = await createBranch({ dataDir: join(root, 'data'), workspace: join(root, 'workspace'), provider: { name: 'stand-in', async complete() { return { content: 'Done', toolCalls: [] }; } } });
  saveDesktopSettings(app.store, app.runtime.owner, { enabled: true });
  let showing = false, allowed = true, held = null, captures = 0, closed = 0;
  const calls = [], leases = [];
  const runner = { liveProcess: (chosen, exclusion) => { calls.push(['reader', { chosen, exclusion }]); return {
    running: true, close: () => closed++, frame: async () => { captures++; return { data: Buffer.from('fake bytes').toString('base64'), width: 640, height: 360,
      target: chosen, method: chosen.kind, screen: chosen.bounds, windows: [{ ...window }], after: [{ ...window }] }; },
  }; }, run: async (action, payload) => { calls.push([action, payload]);
    if (action === 'windows') return { windows: [{ ...window }] };
    if (action === 'capture-targets') return { monitors: [target], windows: [{ ...window }] };
    if (action === 'click') return { at: [320, 180], how: 'point' };
    return {};
  }, close: async () => {} };
  const banner = new DesktopBanner(runner, undefined, { platform: 'linux', window: async (stop) => {
    showing = true; return { get showing() { return showing; }, close() { showing = false; stop(); } };
  } });
  const desktop = new DesktopControl(app.store, { runner, banner, permissions: { check: async () => ({ allowed, message: 'OS denied' }) },
    nativeCaptureLease: { acquire: async (id) => { leases.push(['acquire', id]); return { processId: 100, handles: ['555'] }; }, release: async (id) => { leases.push(['release', id]); } } });
  t.after(async () => { await desktop.close(); await app.close(); await discardTemp(root); });
  const guard = () => { if (held) throw new Error(held); };
  const open = () => desktop.chatScreen(app.runtime.owner, { target, guard, stopped: () => {}, signal: new AbortController().signal });
  return { app, desktop, runner, calls, leases, guard, open, hold: (v) => { held = v; }, permission: (v) => { allowed = v; }, counts: () => ({ captures, closed, showing }) };
}
test('the real DesktopControl consumer preserves provenance and maps type, keys and wheel correctly', async (t) => {
  const w = await world(t), screen = await w.open();
  const frame = await screen.frames.next(640, new AbortController().signal);
  assert.deepEqual(frame.target, target); assert.equal(frame.windows[0].handle, '7');
  screen.takeOver();
  for (const input of [{ action: 'type', text: 'hello' }, { action: 'key', chord: 'ctrl+s' }, { action: 'scroll', steps: -2 }, { action: 'click', x: 0.5, y: 0.5 }])
    await screen.act({ ...input, window: 'Fake Notes' }, new AbortController().signal);
  const input = w.calls.filter(([verb]) => ['type', 'key', 'scroll', 'click'].includes(verb));
  assert.equal(input[0][1].text, 'hello'); assert.equal(input[1][1].keys, '^s'); assert.equal(input[2][1].steps, -2);
  for (const [, payload] of input) { assert.deepEqual(payload.expectedTarget, target); assert.equal(payload.expectedProcessId, 42); }
  assert.deepEqual([w.desktop.pointer().x, w.desktop.pointer().y, w.desktop.pointer().trunk], [320, 180, null]);
  await screen.close(); assert.equal(w.desktop.pointer(), null);
  const second = await w.open(); await second.close(); assert.equal(w.leases.filter(([verb]) => verb === 'release').length, 2);
});
test('remote Take over waits model actions, and closing never releases a later local owner holder', async (t) => {
  const w = await world(t), screen = await w.open(); await screen.frames.next(640, new AbortController().signal); screen.takeOver();
  const run = w.app.store.createRun(w.app.runtime.owner, 'stand-in task');
  const context = w.app.runtime.context({ runId: run.id });
  const task = w.desktop.click({ window: 'Fake Notes', point: { x: 1, y: 1 } }, context);
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(w.calls.filter(([verb]) => verb === 'click').length, 0);
  await screen.act({ action: 'click', window: 'Fake Notes', x: 0.5, y: 0.5 }, new AbortController().signal);
  assert.equal(w.calls.filter(([verb]) => verb === 'click').length, 1);
  screen.handBack(); await task; assert.equal(w.calls.filter(([verb]) => verb === 'click').length, 2);
  w.desktop.takeOver(); await screen.close(); assert.equal(w.desktop.isDriving(), true);
  w.desktop.handBack(); await w.desktop.closeRun({ runId: run.id });
});
test('native targets and session creation reread held state and OS permission before touching capture', async (t) => {
  const w = await world(t), result = await w.desktop.captureTargets(w.app.runtime.owner, w.guard, new AbortController().signal);
  assert.deepEqual(result.monitors, [target]);
  w.hold('App lock'); await assert.rejects(w.open(), /App lock/); assert.equal(w.counts().captures, 0);
  w.hold(null); w.permission(false); await assert.rejects(w.open(), /OS denied/);
  assert.equal(w.counts().captures, 0);
  assert.equal(w.leases.filter(([verb]) => verb === 'release').length, 2);
});
test('target enumeration proves and excludes own PID, releases lease and never trusts a title', async (t) => {
  const w = await world(t), original = w.runner.run;
  w.runner.run = async (verb, payload, signal) => verb === 'capture-targets'
    ? { monitors: [target], windows: [{ ...window }, { ...window, handle: '555', processId: 100, title: 'Harmless name' }] }
    : original(verb, payload, signal);
  const answer = await w.desktop.captureTargets(w.app.runtime.owner, w.guard, new AbortController().signal);
  assert.equal(answer.excludedProcessId, 100); assert.deepEqual(answer.windows.map((at) => at.handle), ['7']);
  assert.equal(w.leases.filter(([verb]) => verb === 'release').length, 1);
});
test('target enumeration on an unsupported host refuses before native windows are touched', async (t) => {
  const w = await world(t); w.desktop.nativeCaptureLease = undefined;
  await assert.rejects(w.desktop.captureTargets(w.app.runtime.owner, w.guard, new AbortController().signal), /host/);
  assert.equal(w.calls.length, 0);
});
