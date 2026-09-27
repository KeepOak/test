import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatScreenSessions, ScreenRefusal } from '../dist/channels/screen-sessions.js';

const chat = { channel: 'telegram', senderId: '42', chatId: '42', chatKind: 'direct', trunk: 'trunk-1' };
function world(t) {
  let clock = 1000, held = null, eligible = true, ownWindow = true, visible = true, stopped;
  let opens = 0, closes = 0, frames = 0, actions = 0, frameHook, openHook, pinHook;
  const log = [], states = [];
  const ports = {
    eligible: (who) => eligible && who.senderId === '42' && who.chatId === '42', held: () => held,
    verify: (_, raw) => { if (raw === 'bad') throw new ScreenRefusal(); return { senderId: raw === 'stranger' ? '77' : '42', hash: raw, authDate: 1 }; },
    confirmPin: async (pin) => { await pinHook?.(); return pin === '1234'; }, windowOwner: () => ownWindow,
    now: () => clock, audit: (event, detail) => log.push({ event, ...detail }),
    open: async (_, stop, signal) => {
      opens++; stopped = stop; await openHook?.(signal);
      return { visible: () => visible, frames: { close: () => states.push('reader closed'), next: async () => { frames++; await frameHook?.(); return { bytes: Buffer.from('stand-in'), type: 'image/jpeg', width: 640, height: 360, screen: { x: 10, y: 20, w: 100, h: 200 } }; } },
        act: async () => { actions++; }, takeOver: () => states.push('owner'), handBack: () => states.push('agent'),
        pointer: () => ({ x: 60, y: 120, at: 'time', trunk: 'trunk-1' }), close: async () => { closes++; } };
    },
  };
  const sessions = new ChatScreenSessions(ports); t.after(() => sessions.close());
  return { sessions, ports, log, states, counts: () => ({ opens, closes, frames, actions }),
    time: (value) => { clock = value; }, hold: (value) => { held = value; }, allow: (value) => { eligible = value; }, window: (value) => { ownWindow = value; },
    visible: (value) => { visible = value; }, stopBanner: () => stopped(), frameHook: (fn) => { frameHook = fn; }, openHook: (fn) => { openHook = fn; }, pinHook: (fn) => { pinHook = fn; } };
}
async function started(w, proof = 'signed-1') { const request = w.sessions.request(chat); w.sessions.confirmInWindow(request.id); return w.sessions.start(request.id, proof); }
test('fresh window plus signed identity opens a bounded purpose-only key and normalized cursor', async (t) => {
  const w = world(t), session = await started(w);
  assert.match(session.key, /^[\w-]{43}$/); assert.equal(session.expires, 301000);
  const frame = await w.sessions.frame(session.key); assert.equal(frame.session, session.id); assert.equal(frame.control, 'agent');
  assert.deepEqual(frame.cursor, { x: 0.5, y: 0.5, at: 'time', trunk: 'trunk-1' });
  assert.equal(JSON.stringify(w.log).includes(session.key), false);
  assert.throws(() => w.sessions.request(chat), /Stop the current/);
});
test('off, revoked, held and wrong owner requests refuse before desktop opens', (t) => {
  const w = world(t); w.allow(false); assert.throws(() => w.sessions.request(chat), ScreenRefusal);
  w.allow(true); w.hold('locked'); assert.throws(() => w.sessions.request(chat), /locked/);
  w.hold(null); assert.throws(() => w.sessions.request({ ...chat, senderId: '77' }), ScreenRefusal);
  assert.throws(() => w.sessions.request({ ...chat, chatKind: 'group' }), ScreenRefusal);
  assert.throws(() => w.sessions.request({ ...chat, caughtUp: true }), ScreenRefusal);
  assert.equal(w.counts().opens, 0);
});
test('bad signature, other signed user and absent confirmation do not open or burn proof', async (t) => {
  const w = world(t), pending = w.sessions.request(chat);
  await assert.rejects(w.sessions.start(pending.id, 'bad'), ScreenRefusal);
  await assert.rejects(w.sessions.start(pending.id, 'stranger', '1234'), ScreenRefusal);
  await assert.rejects(w.sessions.start(pending.id, 'signed-1'), /Confirm/);
  await assert.rejects(w.sessions.start(pending.id, 'signed-1', 'wrong'), /Confirm/);
  assert.equal(w.counts().opens, 0);
  assert.ok(await w.sessions.start(pending.id, 'signed-1', '1234'));
});
test('fresh confirmation cannot be reused and signed launches cannot be replayed', async (t) => {
  const w = world(t), first = await started(w); w.sessions.stop(first.key);
  const second = w.sessions.request(chat);
  await assert.rejects(w.sessions.start(second.id, 'signed-1', '1234'), ScreenRefusal);
  await assert.rejects(w.sessions.start(second.id, 'signed-2'), /Confirm/);
  w.window(false); assert.throws(() => w.sessions.confirmInWindow(second.id), ScreenRefusal);
  assert.equal(w.counts().opens, 1);
});
test('pending expiry and confirmation expiry require a new request or PIN', async (t) => {
  const w = world(t), pending = w.sessions.request(chat); w.sessions.confirmInWindow(pending.id); w.time(121001);
  await assert.rejects(w.sessions.start(pending.id, 'signed-1'), /Confirm/);
  w.time(181001); await assert.rejects(w.sessions.start(pending.id, 'signed-1', '1234'), ScreenRefusal);
  assert.equal(w.counts().opens, 0);
});
test('permission changing during PIN or banner opening refuses and closes before key issuance', async (t) => {
  const w = world(t), pending = w.sessions.request(chat); w.pinHook(() => w.hold('locked'));
  await assert.rejects(w.sessions.start(pending.id, 'signed-1', '1234'), /locked/); assert.equal(w.counts().opens, 0);
  w.hold(null); w.pinHook(null); w.openHook(() => w.allow(false));
  await assert.rejects(w.sessions.start(pending.id, 'signed-1', '1234'), ScreenRefusal);
  assert.equal(w.counts().closes, 1);
});
test('missing visible notice and Stop while opening prevent all frames', async (t) => {
  const w = world(t); w.visible(false); await assert.rejects(started(w), /notice/);
  assert.equal(w.counts().frames, 0); assert.equal(w.counts().closes, 1);
  w.visible(true); w.openHook(() => w.sessions.stopFromWindow()); await assert.rejects(started(w, 'signed-2'), ScreenRefusal);
  assert.equal(w.counts().closes, 2);
});
test('wrong keys cannot capture, touch idle time, stop or take over', async (t) => {
  const w = world(t), session = await started(w), wrong = 'x'.repeat(43);
  await assert.rejects(w.sessions.frame(wrong), ScreenRefusal); assert.throws(() => w.sessions.control(wrong, true), ScreenRefusal);
  assert.throws(() => w.sessions.stop(wrong), ScreenRefusal); assert.equal(w.counts().frames, 0);
  assert.ok(await w.sessions.frame(session.key));
});
test('viewing does not renew idle expiry; idle and lifetime close readers and revoke keys', async (t) => {
  const w = world(t), session = await started(w); w.time(60999); await w.sessions.frame(session.key);
  w.time(61000); w.sessions.sweep(); await assert.rejects(w.sessions.frame(session.key), ScreenRefusal);
  assert.equal(w.counts().closes, 1); assert.ok(w.states.includes('reader closed'));
  const next = await started(w, 'signed-2');
  for (let at = 110000; at <= 310000; at += 50000) { w.time(at); w.sessions.control(next.key, true); }
  w.time(next.expires); w.sessions.sweep(); assert.throws(() => w.sessions.control(next.key, true), ScreenRefusal);
});
test('Take over is required, only bounded input actions pass, and typed text stays out of audit', async (t) => {
  const w = world(t), session = await started(w);
  await assert.rejects(w.sessions.action(session.key, { action: 'type', window: 'Stand-in', text: 'secrettext' }), /Take over/);
  w.sessions.control(session.key, true);
  await w.sessions.action(session.key, { action: 'type', window: 'Stand-in', text: 'secrettext' });
  await assert.rejects(w.sessions.action(session.key, { action: 'execute', command: 'no' }));
  await assert.rejects(w.sessions.action(session.key, { action: 'click', window: 'Stand-in', x: 2, y: 0.5 }));
  assert.equal(w.counts().actions, 1); assert.equal(JSON.stringify(w.log).includes('secrettext'), false);
  assert.equal(w.log.find((e) => e.event === 'action').characters, 10);
  w.sessions.control(session.key, false); assert.equal((await w.sessions.frame(session.key)).control, 'agent');
});
test('late locks discard captured frame and every revocation closes the active session', async (t) => {
  const w = world(t), session = await started(w); w.frameHook(() => w.hold('Lockdown'));
  await assert.rejects(w.sessions.frame(session.key), /Lockdown/); assert.equal(w.counts().closes, 1);
  w.hold(null); w.frameHook(null); const next = await started(w, 'signed-2'); w.allow(false); w.sessions.sweep();
  await assert.rejects(w.sessions.frame(next.key), ScreenRefusal); assert.equal(w.counts().closes, 2);
});
test('Stop from banner, paired chat or local owner revokes immediately; other chats cannot stop', async (t) => {
  const w = world(t), first = await started(w); w.stopBanner();
  assert.equal(w.counts().closes, 1, 'banner Stop closes immediately, without waiting for another request');
  assert.ok(w.states.includes('reader closed'));
  await assert.rejects(w.sessions.frame(first.key), ScreenRefusal);
  const second = await started(w, 'signed-2'); assert.throws(() => w.sessions.stopFromChat({ ...chat, chatId: 'group' }), ScreenRefusal);
  assert.ok(w.sessions.stopFromChat(chat)); await assert.rejects(w.sessions.frame(second.key), ScreenRefusal);
  const third = await started(w, 'signed-3'); w.sessions.stopFromWindow(); await assert.rejects(w.sessions.frame(third.key), ScreenRefusal);
  assert.equal(w.counts().closes, 3);
});
test('launch freshness is checked after PIN and again after desktop startup', async (t) => {
  const w = world(t), original = w.ports.verify;
  let checks = 0, rejectAt = 2;
  w.ports.verify = (...args) => { if (++checks === rejectAt) throw new ScreenRefusal('expired launch'); return original(...args); };
  const request = w.sessions.request(chat);
  await assert.rejects(w.sessions.start(request.id, 'signed-1', '1234'), /expired launch/);
  assert.equal(w.counts().opens, 0);
  checks = 0; rejectAt = 3;
  await assert.rejects(w.sessions.start(request.id, 'signed-2', '1234'), /expired launch/);
  assert.equal(w.counts().opens, 1); assert.equal(w.counts().closes, 1);
});
test('failed desktop cleanup blocks another session rather than reusing a stale notice', async (t) => {
  const w = world(t), original = w.ports.open;
  w.ports.open = async (...args) => { const desktop = await original(...args); desktop.close = async () => { throw new Error('cleanup failed'); }; return desktop; };
  const first = await started(w); w.sessions.stop(first.key);
  await assert.rejects(started(w, 'signed-2'), /cleanup failed/);
  assert.equal(w.counts().opens, 1);
});
