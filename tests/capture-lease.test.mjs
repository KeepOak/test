import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureLease, CaptureLeaseArgsSchema, NativeCaptureTargetSchema } from '../dist/desktop/capture-lease.js';

function fixture() {
  let listener, staleListener;
  const windows = [];
  const make = (id, protectedBefore = false) => {
    const state = { protected: protectedBefore, destroyed: false, calls: [] };
    const window = { isDestroyed: () => state.destroyed, isContentProtected: () => state.protected,
      setContentProtection: (value) => { state.calls.push(value); state.protected = value; },
      getNativeWindowHandle: () => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(id)); return bytes; } };
    windows.push(window);
    listener?.(window);
    return state;
  };
  const host = new CaptureLease({ platform: 'win32', release: '10.0.19041', processId: 99,
    windows: () => windows, onCreated: (fn) => { listener = staleListener = fn; return () => { listener = undefined; }; } });
  return { host, make, windows, hasListener: () => Boolean(listener), deliverStale: () => staleListener?.(windows.at(-1)) };
}
const first = { leaseId: 'a'.repeat(32) }, second = { leaseId: 'b'.repeat(32) };

test('capture target schemas reject implicit screen, numeric handles and unbounded geometry', () => {
  const bounds = { x: -1920, y: 0, w: 1920, h: 1080 };
  assert.equal(NativeCaptureTargetSchema.parse({ kind: 'monitor', deviceName: 'display2', bounds }).bounds.x, -1920);
  for (const value of [{ kind: 'monitor', index: 1, bounds }, { kind: 'window', handle: 12, processId: 2, bounds },
    { kind: 'window', handle: '12', processId: 0, bounds }, { kind: 'monitor', deviceName: '', bounds },
    { kind: 'monitor', deviceName: 'display1', bounds: { ...bounds, w: 0 } }])
    assert.equal(NativeCaptureTargetSchema.safeParse(value).success, false);
  assert.equal(CaptureLeaseArgsSchema.safeParse({ ...first, handles: ['12'] }).success, false, 'caller cannot choose windows to hide');
});

test('all owned windows are protected and only the last lease restores prior state', () => {
  const f = fixture(), original = f.make('12'), already = f.make('13', true);
  assert.deepEqual(f.host.acquire(first), { processId: 99, handles: ['12', '13'] });
  f.host.acquire(second);
  assert.equal(f.host.release(first), true);
  assert.equal(original.protected, true);
  assert.equal(f.host.release(first), false, 'duplicate stale release cannot release another stream');
  assert.equal(f.host.release(second), true);
  assert.equal(original.protected, false);
  assert.equal(already.protected, true);
  assert.equal(f.hasListener(), false);
});

test('new windows join every active capture lease before use and shutdown restores survivors', () => {
  const f = fixture();
  f.make('12'); f.host.acquire(first); f.host.acquire(second);
  const later = f.make('44');
  assert.equal(later.protected, true);
  assert.deepEqual(f.host.acquire(first).handles, ['12', '44'], 'repeated acquire is idempotent and refreshes handles');
  f.host.close();
  assert.equal(later.protected, false);
  assert.equal(f.hasListener(), false);
  assert.equal(f.host.release(second), false);
  assert.throws(() => f.host.acquire(first), /closed/i);
});

test('failed protection unwinds prior windows and does not leave a capture lease active', () => {
  const f = fixture(), firstWindow = f.make('12'), refused = f.make('13');
  const old = f.windows[1];
  old.setContentProtection = () => { throw new Error('unavailable'); };
  assert.throws(() => f.host.acquire(first), /unavailable/);
  assert.equal(firstWindow.protected, false);
  assert.equal(refused.protected, false);
  assert.equal(f.hasListener(), false);
  assert.equal(f.host.release(first), false);
});

test('a queued old window callback after release cannot reapply protection; a fresh lease can start', () => {
  const f = fixture(), original = f.make('12');
  f.host.acquire(first); f.host.release(first);
  const later = f.make('22'); f.deliverStale();
  assert.equal(later.protected, false);
  f.host.acquire(second);
  assert.equal(original.protected, true);
  assert.equal(later.protected, true);
  f.host.close();
  assert.equal(original.protected, false);
});

test('unsupported hosts refuse instead of a black rectangle and destroyed windows are harmless', () => {
  for (const [platform, release] of [['darwin', '25.0.0'], ['linux', '6.0.0'], ['win32', '10.0.18363']]) {
    const host = new CaptureLease({ platform, release, processId: 99, windows: () => [], onCreated: () => () => {} });
    assert.throws(() => host.acquire(first), /Windows 10.*2004/i);
  }
  const f = fixture(), gone = f.make('12');
  f.host.acquire(first); gone.destroyed = true;
  assert.doesNotThrow(() => f.host.release(first));
  assert.deepEqual(gone.calls, [true]);
});
