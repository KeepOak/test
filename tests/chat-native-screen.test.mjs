import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatNativeScreen } from '../dist/integrations/chat-screen-native.js';
import { DesktopBanner } from '../dist/integrations/desktop-banner.js';
const target = { kind: 'monitor', deviceName: 'DISPLAY1', bounds: { x: 0, y: 0, w: 640, h: 360 } };
const window = { handle: '7', title: 'Stand-in Notes', program: 'fake', className: 'fake', processId: 42, minimised: false, x: 10, y: 20, width: 100, height: 200 };
function world(t, chosen = target) {
  let showing = false, stopNotice, held = null, permission = true, pid = 100, holder = null, stopped = 0;
  let frameHook, checkHook, returnedTarget = chosen, returnedMethod = chosen.kind, listed = [{ ...window }];
  let acquired = 0, released = 0, captures = 0, readersClosed = 0, finished = 0, opened = 0;
  const calls = [], signal = new AbortController();
  const parts = {
    target: structuredClone(chosen), signal: signal.signal,
    host: { acquire: async () => { acquired++; return { processId: pid, handles: ['555'] }; }, release: async () => { released++; } },
    banner: new DesktopBanner({}, undefined, { platform: 'linux', window: async (close) => { opened++; showing = true; stopNotice = () => { showing = false; close(); }; return { get showing() { return showing; }, close() { showing = false; close(); } }; } }),
    guard: () => { if (held) throw new Error(held); },
    check: async (at) => { at.throwIfAborted(); await checkHook?.(); if (!permission) throw new Error('OS revoked'); },
    stopped: () => { stopped++; },
    frames: () => ({ running: true, close: () => { readersClosed++; }, next: async () => { captures++; await frameHook?.(); return {
      bytes: Buffer.from('stand-in pixels'), type: 'image/jpeg', width: 640, height: 360,
      target: structuredClone(returnedTarget), method: returnedMethod, screen: structuredClone(returnedTarget.bounds),
      windows: structuredClone(listed), after: structuredClone(listed),
    }; } }),
    resolve: async () => ({ ...window }),
    input: async (action, resolved, payload) => { calls.push({ action, resolved, payload }); return { at: [320, 180], target: chosen, processId: 42 }; },
    takeOver: () => { if (holder && holder !== 'remote') throw new Error('local owner holds control'); holder = 'remote'; },
    handBack: () => { if (holder === 'remote') holder = null; }, holdsControl: () => holder === 'remote',
    agentPointer: () => ({ x: 10, y: 20, at: 'agent', trunk: 'trunk-1' }), finished: () => { finished++; },
  };
  let screen; t.after(async () => { await screen?.close().catch(() => {}); });
  return { parts, open: async () => (screen = await ChatNativeScreen.open(parts)), calls, abort: () => signal.abort(),
    hold: (value) => { held = value; }, permission: (value) => { permission = value; }, hostPid: (value) => { pid = value; },
    localHolder: () => { holder = 'local'; }, noticeStop: () => stopNotice(), frameHook: (fn) => { frameHook = fn; }, checkHook: (fn) => { checkHook = fn; },
    target: (value, method = value.kind) => { returnedTarget = value; returnedMethod = method; }, windows: (value) => { listed = value; },
    counts: () => ({ acquired, released, captures, readersClosed, finished, opened, stopped }), holder: () => holder };
}
const next = (screen) => screen.frames.next(640, new AbortController().signal);
const action = { action: 'click', window: 'Notes', x: 0.5, y: 0.5 };
test('unsupported host and startup revocation refuse before any capture or input', async (t) => {
  const w = world(t); w.parts.host = undefined; await assert.rejects(w.open(), /host/); assert.equal(w.counts().captures, 0);
  const another = world(t); another.checkHook(() => another.hold('App lock')); await assert.rejects(another.open(), /App lock/);
  assert.equal(another.counts().released, 1); assert.equal(another.counts().captures, 0);
});
test('Branch own viewer is refused before opening the reader or notice', async (t) => {
  const w = world(t, { kind: 'window', handle: '555', processId: 100, bounds: target.bounds });
  await assert.rejects(w.open(), /own viewer/);
  assert.equal(w.counts().opened, 0); assert.equal(w.counts().captures, 0); assert.equal(w.counts().released, 1);
});
test('failed acquisition or cleanup preserves the original startup refusal', async (t) => {
  const w = world(t); let releases = 0;
  w.parts.host.acquire = async () => { throw new Error('unsupported host'); };
  w.parts.host.release = async () => { releases++; throw new Error('cleanup refused'); };
  await assert.rejects(w.open(), /unsupported host/); assert.equal(releases, 0);
  const other = world(t); other.checkHook(() => other.hold('App lock'));
  other.parts.host.release = async () => { throw new Error('cleanup refused'); };
  await assert.rejects(other.open(), /App lock/);
});
test('failed cleanup still unregisters an inactive port and its reader closes once', async (t) => {
  const w = world(t), screen = await w.open();
  w.parts.host.release = async () => { throw new Error('host release failed'); };
  await assert.rejects(screen.close(), /release failed/); await assert.rejects(screen.close(), /release failed/);
  assert.equal(w.counts().finished, 1); assert.equal(w.counts().readersClosed, 1); assert.equal(screen.visible(), false);
});
test('the port binds actual displayed geometry, refreshes native proof and sends only bounded input', async (t) => {
  const w = world(t), screen = await w.open(); await next(screen);
  await assert.rejects(screen.act(action, new AbortController().signal), /Take over/);
  screen.takeOver(); await screen.act(action, new AbortController().signal);
  assert.deepEqual(w.calls[0].payload.expectedTarget, target);
  assert.deepEqual(w.calls[0].payload.expectedWindowBounds, { x: 10, y: 20, w: 100, h: 200 });
  assert.deepEqual(w.calls[0].payload.pointOnTarget, { x: 0.5, y: 0.5 });
  assert.equal(w.calls[0].payload.expectedProcessId, 42); assert.ok(w.counts().acquired >= 5);
  assert.deepEqual([screen.pointer().x, screen.pointer().y, screen.pointer().trunk], [320, 180, null]);
  screen.handBack(); assert.equal(screen.pointer().trunk, 'trunk-1');
});
test('there is no input before a frame and no guessed window on missing provenance', async (t) => {
  const w = world(t), screen = await w.open(); screen.takeOver();
  await assert.rejects(screen.act(action, new AbortController().signal), /live frame/);
  assert.equal(w.calls.length, 0); assert.equal(w.counts().readersClosed, 1);
  const other = world(t), second = await other.open(); other.windows([]); await next(second); second.takeOver();
  await assert.rejects(second.act(action, new AbortController().signal), /window changed/);
  assert.equal(other.calls.length, 0);
});
test('a returned different target or method is discarded and closes the reader', async (t) => {
  const w = world(t), screen = await w.open(); w.target({ ...target, deviceName: 'DISPLAY2' });
  await assert.rejects(next(screen), /target changed/); assert.equal(w.counts().readersClosed, 1);
  const other = world(t), second = await other.open(); other.target(target, 'rectangle');
  await assert.rejects(next(second), /target changed/);
});
test('changed host process, permission or late lock discards frames and releases native protection', async (t) => {
  const w = world(t), screen = await w.open(); w.hostPid(101);
  await assert.rejects(next(screen), /host changed/); assert.equal(w.counts().captures, 0); assert.equal(w.counts().released, 1);
  const other = world(t), second = await other.open(); other.frameHook(() => other.hold('Lockdown'));
  await assert.rejects(next(second), /Lockdown/); assert.equal(other.counts().released, 1);
  const third = world(t), last = await third.open(); third.permission(false);
  await assert.rejects(next(last), /OS revoked/); assert.equal(third.counts().captures, 0);
});
test('window target rejects a different HWND before native input', async (t) => {
  const chosen = { kind: 'window', handle: '9', processId: 42, bounds: { x: 10, y: 20, w: 100, h: 200 } };
  const w = world(t, chosen), screen = await w.open(); await next(screen); screen.takeOver();
  await assert.rejects(screen.act(action, new AbortController().signal), /window shown/); assert.equal(w.calls.length, 0);
});
test('scroll uses the displayed window center and never reaches another monitor', async (t) => {
  const w = world(t), screen = await w.open(); await next(screen); screen.takeOver();
  await screen.act({ action: 'scroll', window: 'Notes', steps: -2 }, new AbortController().signal);
  assert.deepEqual(w.calls[0].payload.pointOnTarget, { x: 60/640, y: 120/360 });
  await assert.rejects(screen.act({ action: 'scroll', window: 'Notes', steps: 11 }, new AbortController().signal));
  assert.equal(w.calls.length, 1);
});
test('closing and banner Stop release exactly once and cannot hand back an unrelated local owner', async (t) => {
  const w = world(t), screen = await w.open(); w.localHolder(); assert.throws(() => screen.takeOver(), /local owner/);
  await screen.close(); await screen.close(); assert.equal(w.holder(), 'local');
  assert.equal(w.counts().released, 1); assert.equal(w.counts().finished, 1); assert.equal(w.counts().readersClosed, 1);
  const other = world(t), second = await other.open(); other.noticeStop(); await second.close();
  assert.equal(other.counts().stopped, 1); assert.equal(other.counts().released, 1);
});
test('cancellation and saved-secret references never reach native input', async (t) => {
  const w = world(t), screen = await w.open(); await next(screen); screen.takeOver();
  await assert.rejects(screen.act({ action: 'type', window: 'Notes', text: '{{password}}' }, new AbortController().signal), /placeholder/);
  assert.equal(w.calls.length, 0);
  w.abort(); await assert.rejects(next(screen)); assert.equal(w.counts().readersClosed, 1);
});
