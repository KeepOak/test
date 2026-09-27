import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatScreenEntry } from '../dist/channels/screen-entry.js';
import { ScreenRefusal } from '../dist/channels/screen-sessions.js';
import { chatScreenAccount } from '../dist/channels/screen-settings.js';
const chat = { channel: 'bot', chatId: '42', senderId: '42', chatKind: 'direct', trunk: null };
const monitor = { kind: 'monitor', deviceName: 'DISPLAY1', bounds: { x: 0, y: 0, w: 640, h: 360 } };
function world(t) {
  let now = 1000, held = null, eligible = true, targets = 0, opens = 0, actions = 0, closes = 0, frameHook, targetHook, pinHook;
  let provenance = { handle: '7', processId: 42, program: 'notepad', className: 'Notepad', x: 10, y: 20, width: 100, height: 200 };
  const links = [], log = [], seen = [], signal = new AbortController();
  const parts = { now: () => now, eligible: () => eligible, held: () => held, windowOwner: () => true,
    verify: (_, raw) => { if (raw === 'bad') throw new ScreenRefusal(); return { senderId: raw === 'stranger' ? '77' : '42', hash: raw, authDate: 1 }; },
    confirmPin: async pin => { await pinHook?.(); return pin === '1234'; }, publicAddress: () => 'https://stand-in.trycloudflare.com',
    link: async (_, url) => links.push(url), audit: (event, detail) => log.push({ event, ...detail }),
    targets: async guard => { guard(); targets++; await targetHook?.(); guard(); return { excludedProcessId: 100, monitors: [monitor], windows: [
      { handle: '555', processId: 100, program: 'branch', className: 'Branch', title: 'Viewer', x: 0, y: 0, width: 640, height: 360 },
      { handle: '7', processId: 42, program: 'notepad', className: 'Notepad', title: 'Notes', x: 10, y: 20, width: 100, height: 200 },
      { handle: '8', processId: 43, program: 'notepad', className: 'Notepad', title: 'Hidden', minimised: true, x: 0, y: 0, width: 20, height: 20 },
      { handle: '9', processId: 44, program: 'chrome', className: 'Chrome_WidgetWin_1', title: 'Branch browser viewer', x: 0, y: 0, width: 20, height: 20 },
      { handle: '10', processId: 45, title: 'Missing process proof', x: 0, y: 0, width: 20, height: 20 }] }; },
    open: async (target, guard) => { guard(); opens++; seen.push(target); return { visible: () => true,
      frames: { close() {}, next: async () => { await frameHook?.(); return { bytes: Buffer.from('stand-in'), type: 'image/jpeg', width: 640, height: 360,
        screen: monitor.bounds, windows: [provenance], after: [provenance] }; } },
      act: async () => actions++, pointer: () => null, takeOver() {}, handBack() {}, close: async () => closes++ }; },
  };
  const entry = new ChatScreenEntry(parts); t.after(() => entry.close());
  return { entry, parts, links, log, seen, hold: v => held = v, allow: v => eligible = v, time: v => now = v,
    frameHook: fn => frameHook = fn, targetHook: fn => targetHook = fn, pinHook: fn => pinHook = fn,
    counts: () => ({ targets, opens, actions, closes }), signal, provenance: value => provenance = value };
}
async function pending(w) { await w.entry.command(chat, ''); return new URL(w.links[0]).searchParams.get('request'); }
async function started(w) { const id = await pending(w), choices = await w.entry.targets(id, 'signed', '1234'); return w.entry.start(id, 'signed', choices[0].id); }
test('only an exact Telegram owner DM account is eligible, never groups or catch-up', () => {
  const setting = { on: true, accounts: [{ channel: 'bot', sender: '42' }] };
  assert.equal(chatScreenAccount(setting, chat, 'telegram'), true);
  for (const [value, kind] of [[{ ...chat, senderId: '77' }, 'telegram'], [{ ...chat, chatKind: 'group' }, 'telegram'],
    [{ ...chat, caughtUp: true }, 'telegram'], [chat, 'discord']]) assert.equal(chatScreenAccount(setting, value, kind), false);
  assert.equal(chatScreenAccount({ ...setting, on: false }, chat, 'telegram'), false);
});
test('links use only the existing HTTPS door and carry no keys or launch proof', async (t) => {
  const w = world(t); await pending(w); assert.match(w.links[0], /^https:\/\/stand-in.trycloudflare.com\/chat-screen\?request=/);
  assert.equal(w.counts().targets, 0); assert.equal(w.counts().opens, 0);
  w.parts.publicAddress = () => 'http://stand-in'; await assert.rejects(w.entry.command(chat, ''), /HTTPS/);
  w.parts.publicAddress = () => null; await assert.rejects(w.entry.command(chat, ''), /secure door/);
});
test('fresh signed confirmation precedes enumeration and opaque choices exclude the actual viewer PID', async (t) => {
  const w = world(t), id = await pending(w);
  await assert.rejects(w.entry.targets(id, 'bad', '1234')); await assert.rejects(w.entry.targets(id, 'stranger', '1234'));
  await assert.rejects(w.entry.targets(id, 'signed', 'wrong'), /Confirm/); assert.equal(w.counts().targets, 0);
  const choices = await w.entry.targets(id, 'signed', '1234'); assert.deepEqual(choices.map(c => c.label), ['Notes']);
  assert.ok(choices.every(c => !('handle' in c) && !('processId' in c))); assert.equal(w.counts().opens, 0);
  await assert.rejects(w.entry.start(id, 'signed', '7'), /fresh screen target/);
  const session = await w.entry.start(id, 'signed', choices[0].id); assert.equal(w.seen[0].handle, '7');
  assert.equal(JSON.stringify(w.log).includes(session.key), false);
  w.entry.sessions.stop(session.key); await assert.rejects(w.entry.start(id, 'signed', choices[0].id));
});
test('revocation during PIN or enumeration never returns a target and expired choices never open', async (t) => {
  const w = world(t), id = await pending(w); w.pinHook(() => w.hold('App lock'));
  await assert.rejects(w.entry.targets(id, 'signed', '1234'), /App lock/); assert.equal(w.counts().targets, 0);
  w.hold(null); w.pinHook(null); w.targetHook(() => w.allow(false));
  await assert.rejects(w.entry.targets(id, 'signed', '1234')); assert.equal(w.counts().opens, 0);
  const other = world(t), request = await pending(other), choices = await other.entry.targets(request, 'fresh', '1234');
  other.time(121001); await assert.rejects(other.entry.start(request, 'fresh', choices[0].id, '1234'), /fresh screen target/);
  assert.equal(other.counts().opens, 0);
});
test('input requires an explicit owner takeover and a fresh single-use displayed frame', async (t) => {
  const w = world(t), session = await started(w), action = { action: 'click', window: 'Notes', x: .5, y: .5 };
  let frame = await w.entry.frame(session.key, 640);
  await assert.rejects(w.entry.action(session.key, frame.inputFrame, action), /Take over/);
  w.entry.sessions.control(session.key, true); frame = await w.entry.frame(session.key, 640);
  await w.entry.action(session.key, frame.inputFrame, action); assert.equal(w.counts().actions, 1);
  await assert.rejects(w.entry.action(session.key, frame.inputFrame, action), /Refresh/);
  frame = await w.entry.frame(session.key, 640); w.time(6001);
  await assert.rejects(w.entry.action(session.key, frame.inputFrame, action), /Refresh/); assert.equal(w.counts().actions, 1);
});
test('overlapping frame/input is refused and permission revocation closes the session', async (t) => {
  const w = world(t), session = await started(w); let release, reached;
  const gate = new Promise(resolve => release = resolve), ready = new Promise(resolve => reached = resolve);
  w.frameHook(async () => { reached(); await gate; }); const frame = w.entry.frame(session.key, 640); await ready;
  await assert.rejects(w.entry.frame(session.key, 640), /previous screen request/);
  await assert.rejects(w.entry.action(session.key, 'guess', { action: 'click', window: 'Notes', x: .5, y: .5 }), /previous screen request/);
  w.hold('Lockdown'); release(); await assert.rejects(frame, /Lockdown/); assert.equal(w.counts().actions, 0);
  assert.equal(w.counts().closes, 1);
});
test('late browser or missing native window provenance is discarded before pixels or input proofs are returned', async (t) => {
  const w = world(t), session = await started(w);
  w.provenance({ handle: '7', processId: 42, program: 'notepad', className: 'Chrome_WidgetWin_1' });
  await assert.rejects(w.entry.frame(session.key, 640), /viewer identity changed/); assert.equal(w.counts().closes, 1);
  const other = world(t), next = await started(other); other.provenance({ handle: '7', processId: 42 });
  await assert.rejects(other.entry.frame(next.key, 640), /viewer identity changed/); assert.equal(other.counts().actions, 0);
});
