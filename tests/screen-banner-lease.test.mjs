import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopBanner } from '../dist/integrations/desktop-banner.js';

function world() {
  let stopped, showing = false, opened = 0, closed = 0;
  const banner = new DesktopBanner({}, undefined, { platform: 'linux', window: async (onStop) => {
    opened++; showing = true; stopped = () => { showing = false; onStop(); };
    return { get showing() { return showing; }, close() { closed++; showing = false; onStop(); } };
  } });
  return { banner, stop: () => stopped(), counts: () => ({ opened, closed }) };
}
test('a remote notice survives a task ending and disappears only when its lease ends', async () => {
  const w = world(), view = await w.banner.acquire(() => {});
  await w.banner.show(() => {}); await w.banner.hide();
  assert.equal(view.visible(), true); assert.equal(w.counts().closed, 0);
  await view.release(); assert.equal(view.visible(), false); assert.equal(w.counts().closed, 1);
  await view.release(); assert.equal(w.counts().closed, 1);
});
test('releasing a view keeps an active task notice visible', async () => {
  const w = world(), view = await w.banner.acquire(() => {});
  await w.banner.show(() => {}); await view.release();
  assert.equal(w.banner.visible, true); assert.equal(view.visible(), false);
  await w.banner.hide(); assert.equal(w.banner.visible, false);
});
test('native Stop immediately reaches every task and view, including a later lease', async () => {
  const w = world(), got = [];
  await w.banner.show(() => got.push('task'));
  const first = await w.banner.acquire(() => got.push('first'));
  const second = await w.banner.acquire(() => got.push('second'));
  w.stop(); assert.deepEqual(got, ['task', 'first', 'second']);
  assert.equal(first.visible(), false); assert.equal(second.visible(), false);
  await w.banner.show(() => {});
  assert.equal(first.visible(), false, 'a stopped lease cannot revive on another notice');
  assert.equal(second.visible(), false);
  await w.banner.hide();
  await first.release(); await second.release();
});
test('a throwing Stop listener does not swallow another session Stop', async () => {
  const w = world(); let stopped = false;
  await w.banner.show(() => { throw new Error('failed task'); });
  const view = await w.banner.acquire(() => { stopped = true; });
  w.stop(); assert.equal(stopped, true); await view.release();
});
test('concurrent view/task startup creates one notice and programmatic release never means Stop', async () => {
  const w = world(); let stops = 0;
  const [view] = await Promise.all([w.banner.acquire(() => stops++), w.banner.show(() => stops++)]);
  assert.equal(w.counts().opened, 1);
  await w.banner.hide(); await view.release(); assert.equal(stops, 0); assert.equal(w.counts().closed, 1);
});
test('a missing notice refuses the remote lease', async () => {
  const banner = new DesktopBanner({}, undefined, { platform: 'linux' });
  await assert.rejects(banner.acquire(() => {}), /notice|Branch Agent app/);
  assert.equal(banner.visible, false);
});
test('a startup that returns without a visible notice cannot grant a lease', async () => {
  const banner = new DesktopBanner({}, undefined, { platform: 'linux' });
  banner.ensureVisible = async () => {}; // Stand-in for a process that exited during startup; no real native window.
  await assert.rejects(banner.acquire(() => {}), /notice/);
});
