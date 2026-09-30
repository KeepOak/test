import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newWindow } from './new-window-places.mjs';
import { installScreenStandIn } from './local-screen-fixture.mjs';
import { openChat } from './open-chat.mjs'; // trunk-one-row: one row per Trunk

const TEMP = process.platform === 'win32' ? 'C:/Users/bishi/AppData/Local/Temp/Codex-session-files' : tmpdir();
test('owner chooses an external application, sees its frame, manually types/clicks/scrolls, and closing releases it', async t => {
  let seen, sid;
  const root = await mkdtemp(join(TEMP, 'local-screen-window-'));
  const w = await newWindow(t, { root, seed(app) {
    seen = installScreenStandIn(app);
    const run = app.store.createRun(app.runtime.owner, 'Native window test'); sid = run.sessionId;
    app.store.message(sid, { role: 'user', content: run.prompt });
    app.store.message(sid, { role: 'assistant', content: 'Ready.' }); app.store.finish(run.id, 'completed', 'Ready.');
  } });
  const { page } = w;
  await openChat(page, sid);
  await page.locator('#conversation .b').first().waitFor();
  await page.locator('.head [data-act="stage"][data-v="computer"]').first().click();
  await page.locator('#native-target option').filter({ hasText: 'Fixture editor' }).waitFor({ state: 'attached' });
  // computer-control: the view opens on the main display by itself (Branch's own windows are left out of it by the host).
  await page.locator('#stage7 .livescr-img[src^="data:image/jpeg"]').waitFor();
  assert.ok(seen.kinds.length >= 1 && seen.kinds.every((kind) => kind === 'monitor'), `the display, not a window: ${seen.kinds}`);
  assert.equal(seen.opened - seen.closed, 1, 'one view open');
  await page.getByText("Showing Whole screen · 1920×1080. Branch's own windows are left out.").waitFor();
  assert.equal(await page.locator('#stage7 .shot7:not(.livescr-img)').count(), 0, 'no historical screenshot stands in for the live view');
  await page.waitForFunction(() => document.querySelector('#stage7 .livescr-img')?.naturalWidth > 0);
  await page.waitForTimeout(100);
  await page.locator('[data-act="native-control"][data-v="take"]').click();
  await page.getByText('You have control: every task is paused. Use your own mouse and keyboard.').waitFor();
  assert.equal(await page.locator('#native-text').count(), 0, "a whole display is driven with the owner's own mouse, not through the view");
  await page.locator('#native-target').selectOption({ label: 'Fixture editor' });
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await page.locator('#stage7 .livescr-img[src^="data:image/jpeg"]').waitFor();
  await page.waitForFunction(() => document.querySelector('#stage7 .livescr-img')?.naturalWidth > 0);
  await page.waitForTimeout(100);
  await page.locator('[data-act="native-control"][data-v="take"]').click();
  await page.locator('#native-text').waitFor();
  await page.locator('#native-text').fill('hello selected editor');
  await page.waitForTimeout(100);
  await page.getByRole('button', { name: 'Send text', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#native-text')?.value === '');
  await page.waitForTimeout(100);
  await page.locator('#stage7 .livescr-img').click();
  await page.waitForTimeout(100);
  await page.getByRole('button', { name: 'Scroll down', exact: true }).click();
  for (let i = 0; i < 500 && seen.effects.length < 3; i++) await page.waitForTimeout(20);
  assert.deepEqual(seen.effects.map(v => v.action), ['type', 'click', 'scroll']);
  assert.ok(seen.effects.every(v => v.window === 'Fixture editor'));
  await page.locator('[data-act="stage-close"]').click();
  for (let i = 0; i < 100 && seen.closed < seen.opened; i++) await page.waitForTimeout(10);
  assert.equal(seen.closed, seen.opened, 'the display and the window were both let go'); assert.equal(seen.held, false);
  assert.deepEqual(w.errors, []);
});