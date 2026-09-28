import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalScreen } from '../dist/local-screen.js';

const bounds = { x: -900, y: 0, w: 900, h: 600 };
const target = { kind: 'window', handle: '12', processId: 7, bounds };
function fixture() {
  const state = { owner: 'owner', key: true, locked: null, lockdown: false, allowed: true, now: 1000, effects: [], closed: 0,
    listed: 0, open: 0, visible: true, delay: null };
  const access = { owner: 'owner', sessionId: 'session', viaDoor: false, shortKey: false, keyValid: () => state.key };
  const windows = [{ ...target, title: 'Editor', program: 'notepad', className: 'Notepad', width: bounds.w, height: bounds.h, x: bounds.x, y: bounds.y, minimised: false }];
  const deps = { owner: () => state.owner, isOwner: () => true, owns: (_, sid) => sid === 'session',
    lockdown: () => state.lockdown, locked: () => state.locked, signIn: () => false, allowsHere: () => state.allowed, now: () => state.now,
    desktop: { captureTargets: async (_, guard) => { guard(); state.listed++; if (state.delay) await state.delay; guard(); return { monitors: [], windows, excludedProcessId: 99 }; },
      chatScreen: async (_, options) => { state.open++; options.guard(); return {
        visible: () => state.visible, takeOver: () => {}, handBack: () => {}, pointer: () => null,
        frames: { next: async () => { if (state.delay) await state.delay; options.guard(); return { bytes: Buffer.from('jpeg'), type: 'image/jpeg', width: 900, height: 600, target, method: 'window', screen: bounds, windows, after: windows }; }, close: () => {} },
        act: async (action) => { if (state.delay) await state.delay; options.guard(); state.effects.push(action); },
        close: async () => { state.closed++; },
      }; } },
  };
  return { screen: new LocalScreen(deps), state, access, windows };
}
async function selected(f) {
  const list = await f.screen.targets(f.access, new AbortController().signal);
  assert.equal(list.targets[0].label, 'Editor');
  assert.equal(list.targets[0].target, undefined, 'client gets opaque selection rather than HWND/PID');
  return f.screen.select(f.access, list.targets[0].id, new AbortController().signal);
}

test('native selection is explicit and owned; door/short keys/foreign sessions never enumerate', async () => {
  const f = fixture();
  assert.throws(() => f.screen.view(f.access, ''), /Choose a window or display/);
  for (const changed of [{ viaDoor: true }, { shortKey: true }, { owner: 'other' }, { sessionId: 'foreign' }])
    await assert.rejects(f.screen.targets({ ...f.access, ...changed }, new AbortController().signal));
  assert.equal(f.state.listed, 0);
  await assert.rejects(f.screen.select(f.access, '12', new AbortController().signal));
  assert.equal(f.state.open, 0);
});

test('opaque target IDs expire and refresh identity/bounds before any native port opens', async () => {
  const f = fixture(), list = await f.screen.targets(f.access, new AbortController().signal);
  f.windows[0].processId = 8;
  await assert.rejects(f.screen.select(f.access, list.targets[0].id, new AbortController().signal), /changed/);
  assert.equal(f.state.open, 0);
  f.windows[0].processId = 7;
  const next = await f.screen.targets(f.access, new AbortController().signal);
  f.state.now += 31000;
  await assert.rejects(f.screen.select(f.access, next.targets[0].id, new AbortController().signal), /Choose/);
});

test('last displayed frame is required, expires and is consumed once before an input effect', async () => {
  const f = fixture(), choice = await selected(f);
  const view = f.screen.view(f.access, choice.viewId);
  await assert.rejects(f.screen.input(f.access, choice.viewId, 'missing', { action: 'key', window: 'Editor', chord: 'ENTER' }, new AbortController().signal));
  view.streaming = true;
  let frame = await f.screen.frame(f.access, choice.viewId, 900, new AbortController().signal);
  f.screen.painted(f.access, choice.viewId, frame.frameId);
  await f.screen.control(f.access, choice.viewId, frame.frameId, true);
  frame = await f.screen.frame(f.access, choice.viewId, 900, new AbortController().signal);
  f.screen.painted(f.access, choice.viewId, frame.frameId);
  await f.screen.input(f.access, choice.viewId, frame.frameId, { action: 'key', window: 'Editor', chord: 'ENTER' }, new AbortController().signal);
  await assert.rejects(f.screen.input(f.access, choice.viewId, frame.frameId, { action: 'key', window: 'Editor', chord: 'ENTER' }, new AbortController().signal), /fresh frame/);
  assert.equal(f.state.effects.length, 1);
  const expired = await f.screen.frame(f.access, choice.viewId, 900, new AbortController().signal);
  f.screen.painted(f.access, choice.viewId, expired.frameId);
  f.state.now += 2100;
  await assert.rejects(f.screen.input(f.access, choice.viewId, expired.frameId, { action: 'key', window: 'Editor', chord: 'ENTER' }, new AbortController().signal), /fresh frame/);
});

test('post-await lock/key/profile/scope revocation drops captured pixels and closes the port', async () => {
  for (const revoke of [(s) => { s.locked = 'locked'; }, (s) => { s.key = false; }, (s) => { s.owner = 'other'; }, (s) => { s.allowed = false; }, (s) => { s.lockdown = true; }]) {
    const f = fixture(), choice = await selected(f);
    f.screen.view(f.access, choice.viewId).streaming = true;
    let resume; f.state.delay = new Promise((resolve) => { resume = resolve; });
    const frame = f.screen.frame(f.access, choice.viewId, 900, new AbortController().signal);
    revoke(f.state); resume();
    await assert.rejects(frame);
    assert.equal(f.state.closed, 1);
  }
});

test('hidden notice, closed view and changed session reject manual control and input', async () => {
  const f = fixture(), choice = await selected(f);
  f.screen.view(f.access, choice.viewId).streaming = true;
  let frame = await f.screen.frame(f.access, choice.viewId, 900, new AbortController().signal);
  f.state.visible = false;
  await assert.rejects(f.screen.control(f.access, choice.viewId, frame.frameId, true));
  await f.screen.close();
  assert.throws(() => f.screen.view(f.access, choice.viewId));
  assert.equal(f.state.effects.length, 0);
});

test('unpainted frames cannot grant control; replaced and mismatched frame identities are refused', async () => {
  const f = fixture(), choice = await selected(f);
  f.screen.view(f.access, choice.viewId).streaming = true;
  const first = await f.screen.frame(f.access, choice.viewId, 900, new AbortController().signal);
  await assert.rejects(f.screen.control(f.access, choice.viewId, first.frameId, true), /fresh frame/);
  const next = await f.screen.frame(f.access, choice.viewId, 900, new AbortController().signal);
  assert.throws(() => f.screen.painted(f.access, choice.viewId, first.frameId), /no longer current/);
  f.screen.painted(f.access, choice.viewId, next.frameId);
  await f.screen.control(f.access, choice.viewId, next.frameId, true);
});

test('revocation during pending manual input produces zero effects and tears down control', async () => {
  for (const revoke of [(s) => { s.locked = 'locked'; }, (s) => { s.key = false; }, (s) => { s.owner = 'other'; }, (s) => { s.allowed = false; }, (s) => { s.lockdown = true; }]) {
    const f = fixture(), choice = await selected(f);
    f.screen.view(f.access, choice.viewId).streaming = true;
    let frame = await f.screen.frame(f.access, choice.viewId, 900, new AbortController().signal);
    f.screen.painted(f.access, choice.viewId, frame.frameId);
    await f.screen.control(f.access, choice.viewId, frame.frameId, true);
  frame = await f.screen.frame(f.access, choice.viewId, 900, new AbortController().signal);
  f.screen.painted(f.access, choice.viewId, frame.frameId);
    let resume; f.state.delay = new Promise((resolve) => { resume = resolve; });
    const pending = f.screen.input(f.access, choice.viewId, frame.frameId, { action: 'type', window: 'Editor', text: 'do not enter' }, new AbortController().signal);
    revoke(f.state); resume(); await assert.rejects(pending);
    assert.equal(f.state.effects.length, 0); assert.equal(f.state.closed, 1);
  }
});

test('a stale selection cannot resurrect or close the newer view after delayed enumeration', async () => {
  const f = fixture(), list = await f.screen.targets(f.access, new AbortController().signal);
  // A second opaque choice for the same native target models two tabs choosing concurrently.
  f.windows.push({ ...f.windows[0], handle: '13', title: 'Other editor' });
  const choices = await f.screen.targets(f.access, new AbortController().signal);
  let resume; f.state.delay = new Promise((resolve) => { resume = resolve; });
  const old = f.screen.select(f.access, choices.targets[0].id, new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  f.state.delay = null;
  const current = await f.screen.select(f.access, choices.targets[1].id, new AbortController().signal);
  resume(); await assert.rejects(old, /replaced/);
  assert.equal(f.screen.view(f.access, current.viewId).label, 'Other editor');
  assert.equal(f.state.open, 1); await f.screen.close();
});

test('own/browser windows and missing process provenance never become opaque choices', async () => {
  const f = fixture();
  f.windows.push({ ...f.windows[0], handle: '13', program: 'chrome', title: 'Notepad' },
    { ...f.windows[0], handle: '14', processId: 99 }, { ...f.windows[0], handle: '15', program: '' },
    { ...f.windows[0], handle: '16', className: 'Chrome_WidgetWin_1', program: 'renamed' });
  const list = await f.screen.targets(f.access, new AbortController().signal);
  assert.deepEqual(list.targets.map((v) => v.label), ['Editor']);
  assert.match(list.notice, /browser windows are left out/);
});

test('late snapshot provenance change discards pixels before publishing them', async () => {
  const f = fixture(), choice = await selected(f);
  f.screen.view(f.access, choice.viewId).streaming = true;
  f.windows[0].className = 'Chrome_WidgetWin_1';
  await assert.rejects(f.screen.frame(f.access, choice.viewId, 900, new AbortController().signal), /became a browser/);
  assert.equal(f.state.closed, 1);
});
test('Stop during a pending frame discards it and cannot close a successor', async () => {
  const f = fixture(), choice = await selected(f);
  f.screen.view(f.access, choice.viewId).streaming = true;
  let resume; f.state.delay = new Promise(r => { resume = r; });
  const pending = f.screen.frame(f.access, choice.viewId, 900, new AbortController().signal);
  await f.screen.close(); f.state.delay = null;
  const next = await selected(f);
  resume(); await assert.rejects(pending);
  assert.equal(f.screen.view(f.access, next.viewId).label, 'Editor');
  assert.equal(f.state.closed, 1); await f.screen.close();
});

test('changed snapshot bounds cannot publish a frame even when its declared target is unchanged', async () => {
  const f = fixture(), choice = await selected(f);
  f.screen.view(f.access, choice.viewId).streaming = true; f.windows[0].x++;
  await assert.rejects(f.screen.frame(f.access, choice.viewId, 900, new AbortController().signal), /moved or resized/);
  assert.equal(f.state.closed, 1);
});
test('an abandoned selection expires without a stream and releases its native port', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); await selected(f);
  t.mock.timers.tick(5001); await Promise.resolve();
  assert.equal(f.state.closed, 1); assert.equal(f.state.effects.length, 0);
});
// computer-control: a whole display, offered only through the host's proof (captureTargets has already acquired and
// released the exclusion lease), framed exactly, never clicked through, and still able to pause every task.
function withDisplay() {
  const f = fixture(), display = { kind: 'monitor', deviceName: '\\.\DISPLAY1', bounds: { x: 0, y: 0, w: 1920, h: 1080 } };
  const frames = { method: 'monitor', screen: display.bounds, target: display };
  f.screen.deps.desktop.captureTargets = async (_, guard) => { guard(); f.state.listed++;
    return { monitors: [{ ...display, primary: true }, { kind: 'monitor', deviceName: '\\.\DISPLAY2', primary: false, bounds: { x: 1920, y: 0, w: 1280, h: 1024 } }], windows: f.windows, excludedProcessId: 99 }; };
  const open = f.screen.deps.desktop.chatScreen;
  f.screen.deps.desktop.chatScreen = async (owner, options) => {
    const port = await open(owner, options), held = { value: false };
    port.takeOver = () => { held.value = true; }; port.handBack = () => { held.value = false; };
    port.frames.next = async () => ({ bytes: Buffer.from('jpeg'), type: 'image/jpeg', width: 1280, height: 720, windows: [], after: [], ...frames });
    return Object.assign(port, { held });
  };
  return { f, display, frames };
}

test('displays are offered first with their size, the main one marked, without device names reaching the window', async () => {
  const { f } = withDisplay();
  const list = await f.screen.targets(f.access, new AbortController().signal);
  assert.deepEqual(list.targets.map((v) => [v.kind, v.label, v.primary]),
    [['monitor', 'Display 1 (main) · 1920×1080', true], ['monitor', 'Display 2 · 1280×1024', false], ['window', 'Editor', false]]);
  assert.ok(list.targets.every((v) => v.target === undefined && v.deviceName === undefined));
});

test('a display frames only as itself, and is driven with the owner\'s own hands, never through the view', async () => {
  const { f, frames } = withDisplay();
  const list = await f.screen.targets(f.access, new AbortController().signal);
  const choice = await f.screen.select(f.access, list.targets[0].id, new AbortController().signal);
  f.screen.view(f.access, choice.viewId).streaming = true;
  const frame = await f.screen.frame(f.access, choice.viewId, 1280, new AbortController().signal);
  assert.equal(frame.label, 'Display 1 (main) · 1920×1080');
  f.screen.painted(f.access, choice.viewId, frame.frameId);
  assert.deepEqual(await f.screen.control(f.access, choice.viewId, frame.frameId, true), { control: true });
  const next = await f.screen.frame(f.access, choice.viewId, 1280, new AbortController().signal);
  f.screen.painted(f.access, choice.viewId, next.frameId);
  await assert.rejects(f.screen.input(f.access, choice.viewId, next.frameId, { action: 'click', window: 'Editor', x: 0.5, y: 0.5 }, new AbortController().signal),
    /use your own mouse and keyboard/);
  assert.deepEqual(f.state.effects, [], 'nothing reached the display');
  // A frame of another size or place than the display chosen is dropped, and the view closes.
  f.screen.view(f.access, choice.viewId);
  frames.screen = { x: 0, y: 0, w: 1920, h: 1200 };
  await assert.rejects(f.screen.frame(f.access, choice.viewId, 1280, new AbortController().signal), /changed/);
  assert.equal(f.state.closed, 1);
});
