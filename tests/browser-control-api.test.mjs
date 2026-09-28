import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBranch } from '../dist/index.js';
import { BranchBrowser, registerBrowser } from '../dist/integrations/browser.js';
import { BrowserControlApi, browserApiPath, requireBrowserOwner } from '../dist/browser-control-api.js';
import { OwnerInputSchema, ownerPageInput } from '../dist/integrations/browser-owner-input.js';
import { startServer } from '../dist/server.js';
import { savePolicy } from '../dist/policy.js';
import { chromium } from 'playwright'; // a real headless Chromium opens these pages (CI installs it for this file)

assert.equal(typeof chromium.launch, 'function');
import { underShortLivedKey } from '../dist/key-context.js';
import { setLockdown } from '../dist/lockdown.js';
import { discardTemp } from './temp-dir.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, provider = { name: 'scripted', async complete() { return { content: 'Unused', toolCalls: [] }; } }) {
  const root = await mkdtemp(join(tmpdir(), 'branch-browser-api-')), hits = [];
  const site = createServer((request, response) => { hits.push(request.url); response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><meta charset="utf-8"><title>Fixture</title><label>Name<input id="name"></label><p id="out">Owner page</p><div style="height:3000px">Scroll</div>'); });
  site.listen(0, '127.0.0.1'); await once(site, 'listening');
  const origin = `http://127.0.0.1:${site.address().port}`;
  const app = await createBranch({ workspace: join(root, 'workspace'), dataDir: join(root, 'data'), provider });
  const browser = new BranchBrowser({ allowedOrigins: [origin] }); browser.store = app.store; app.browser = browser;
  const api = new BrowserControlApi(app), scope = { sessionId: app.store.createSession(app.runtime.owner), profile: null, clientId: randomUUID() };
  t.after(async () => { api.close(); try { await browser.close(); } finally { await app.close(); site.close(); await once(site, 'close'); await discardTemp(root); } });
  registerBrowser(app.registry, browser); savePolicy(app.store, app.runtime.owner, { preset: 'off' });
  let fullKey = true, door = false;
  const access = { signal: new AbortController().signal, authorize: () => requireBrowserOwner(app, fullKey, door) };
  const call = (part, body, method = 'POST') => api.handle(method, browserApiPath + part, body, access);
  const started = await call('/start', scope), binding = { owner: app.runtime.owner, conversation: scope.sessionId, profile: null };
  assert.equal(started.status, 'ready', JSON.stringify(started));
  const control = browser.controls.get(binding, started.control.id);
  const bound = () => ({ ...scope, id: control.id, epoch: control.view().epoch });
  const view = () => call('', bound(), 'GET');
  const input = async (tool, args) => { const seen = await view(); return call('/action', { ...bound(), frameId: seen.frameId,
    tabId: seen.tabId, sequence: control.view().sequence + 1, tool, arguments: args }); };
  return { app, browser, api, scope, bound, view, input, call, control, origin, hits, root,
    revoke: () => { fullKey = false; }, door: () => { door = true; } };
}

test('owner API uses one guarded page for Unicode input, history, tabs and explicit Stop', async t => {
  const { browser, input, call, bound, control, origin } = await fixture(t);
  assert.equal((await input('browser.navigate', { url: origin })).status, 'ran');
  const page = browser.browser.contexts()[0].pages()[0], box = await page.locator('#name').boundingBox(), viewport = page.viewportSize();
  assert.equal((await input('browser.owner_input', { kind: 'click', x: (box.x + 5) / viewport.width, y: (box.y + 5) / viewport.height })).status, 'ran');
  assert.equal((await input('browser.owner_input', { kind: 'text', text: 'Owner 世界 🌳' })).status, 'ran');
  assert.equal(await page.locator('#name').inputValue(), 'Owner 世界 🌳');
  assert.equal((await input('browser.owner_input', { kind: 'key', key: 'Control+A' })).status, 'ran');
  assert.equal((await input('browser.owner_input', { kind: 'text', text: 'Replaced' })).status, 'ran');
  assert.equal(await page.locator('#name').inputValue(), 'Replaced');
  await input('browser.navigate', { url: origin + '/second' });
  await input('browser.owner_input', { kind: 'back' }); assert.equal(page.url(), origin + '/');
  await input('browser.owner_input', { kind: 'forward' }); assert.equal(page.url(), origin + '/second');
  await input('browser.owner_input', { kind: 'reload' });
  await input('browser.tab', { action: 'open' }); assert.equal(control.view().tabs.length, 2);
  await input('browser.tab', { action: 'close', index: 1 }); assert.equal(control.view().tabs.length, 1);
  await call('/stop', bound()); assert.equal(browser.browser.contexts().length, 0);
});

test('old frames, duplicate sequences, wrong windows and forged raw input never gain authority', async t => {
  const { browser, app, input, call, bound, view, control, origin, scope } = await fixture(t);
  await input('browser.navigate', { url: origin });
  const seen = await view(), action = { ...bound(), frameId: seen.frameId, tabId: seen.tabId, sequence: 2, tool: 'browser.owner_input', arguments: { kind: 'text', text: 'Rejected' } };
  await view(); await assert.rejects(call('/action', action), /view changed/);
  const fresh = await view(), valid = { ...action, frameId: fresh.frameId, sequence: control.view().sequence + 1 };
  await assert.rejects(call('/action', { ...valid, clientId: randomUUID() }), /no longer holds/);
  await assert.rejects(call('/action', { ...valid, sequence: 500 }), /no longer holds/);
  await assert.rejects(call('/action', { ...valid, tabId: randomUUID() }), /no longer holds/);
  const context = app.runtime.context(); await assert.rejects(browser.ownerInput({ kind: 'text', text: 'Forged' }, context), /owner window/);
  await call('/disconnect', bound()); assert.equal(control.view().writer, null);
  await call('/start', scope); assert.equal(control.view().writer, null, 'reconnect never grants automatically');
  await call('/control', { ...bound(), operation: 'takeover' }); assert.equal(control.view().writer.id, scope.clientId);
  await assert.rejects(call('/action', valid), /control changed/);
  for (const value of [{ kind: 'click', x: 2, y: 0 }, { kind: 'key', key: 'F12' }, { kind: 'text', text: '' }, { kind: 'wheel', dx: 5000, dy: 0 }])
    assert.equal(OwnerInputSchema.safeParse(value).success, false);
});

test('confirmation is one-time and binds exact input, frame and current policy', async t => {
  const { app, browser, input, call, bound, view, control, origin } = await fixture(t);
  await input('browser.navigate', { url: origin });
  savePolicy(app.store, app.runtime.owner, { preset: 'custom', rules: [{ tool: 'browser.owner_input', decision: 'ask' }] });
  const seen = await view(), action = { ...bound(), frameId: seen.frameId, tabId: seen.tabId, sequence: control.view().sequence + 1,
    tool: 'browser.owner_input', arguments: { kind: 'text', text: 'Exact chosen input' } };
  const question = await call('/action', action); assert.equal(question.status, 'asked');
  await assert.rejects(call('/action', { ...action, arguments: { kind: 'text', text: 'Changed input' }, confirmToken: question.confirmToken }), /action changed/);
  await assert.rejects(call('/action', { ...action, confirmToken: question.confirmToken }), /expired/);
  const next = await call('/action', action);
  assert.equal((await call('/action', { ...action, confirmToken: next.confirmToken })).status, 'ran');
  await assert.rejects(call('/action', { ...action, confirmToken: next.confirmToken }), /no longer holds/);
  const page = browser.browser.contexts()[0].pages()[0]; assert.equal(await page.locator('#name').inputValue(), '');
  const newer = await view(), changed = { ...action, sequence: control.view().sequence + 1, frameId: newer.frameId };
  const asked = await call('/action', changed);
  savePolicy(app.store, app.runtime.owner, { preset: 'off' });
  await assert.rejects(call('/action', { ...changed, confirmToken: asked.confirmToken }), /action changed/);
});

test('a page navigation while approval waits makes the old frame and yes unusable', async t => {
  const { app, browser, input, call, bound, view, control, origin } = await fixture(t);
  await input('browser.navigate', { url: origin });
  savePolicy(app.store, app.runtime.owner, { preset: 'custom', rules: [{ tool: 'browser.owner_input', decision: 'ask' }] });
  const seen = await view(), action = { ...bound(), frameId: seen.frameId, tabId: seen.tabId, sequence: control.view().sequence + 1,
    tool: 'browser.owner_input', arguments: { kind: 'text', text: 'Never typed at a different page' } };
  const asked = await call('/action', action); assert.equal(asked.status, 'asked');
  const page = browser.browser.contexts()[0].pages()[0];
  await page.goto(origin + '/different-target');
  await assert.rejects(call('/action', { ...action, confirmToken: asked.confirmToken }), /page changed/);
  assert.equal(await page.locator('#name').inputValue(), '');
  const fresh = await view(); assert.notEqual(fresh.frameId, seen.frameId);
  await assert.rejects(call('/action', { ...action, frameId: fresh.frameId, confirmToken: asked.confirmToken }), /action changed/);
});

test('a changed live permission target invalidates the exact pending browser yes', async t => {
  const { app, browser, input, call, bound, view, control, origin } = await fixture(t);
  await input('browser.navigate', { url: origin });
  savePolicy(app.store, app.runtime.owner, { preset: 'custom', rules: [{ tool: 'browser.owner_input', decision: 'ask' }] });
  const original = app.runtime.checkPolicy.bind(app.runtime); let target = 'host-a.example';
  app.runtime.checkPolicy = (...args) => { const verdict = original(...args);
    return args[0] === 'browser.owner_input' ? { ...verdict, target } : verdict; };
  const seen = await view(), action = { ...bound(), frameId: seen.frameId, tabId: seen.tabId, sequence: control.view().sequence + 1,
    tool: 'browser.owner_input', arguments: { kind: 'text', text: 'Target drift must not type' } };
  const asked = await call('/action', action); assert.equal(asked.status, 'asked');
  target = 'host-b.example';
  await assert.rejects(call('/action', { ...action, confirmToken: asked.confirmToken }), /action changed/);
  assert.equal(await browser.browser.contexts()[0].pages()[0].locator('#name').inputValue(), '');
});

test('a page change during address policy wait cannot dispatch the held navigation', async t => {
  const { browser, input, origin, hits } = await fixture(t);
  await input('browser.navigate', { url: origin });
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  browser.policy = { async assertAllowed(target) {
    if (target.pathname === '/held-navigation') { entered.resolve(); await release.promise; }
  } };
  const pending = input('browser.navigate', { url: origin + '/held-navigation' });
  await entered.promise;
  await browser.browser.contexts()[0].pages()[0].goto(origin + '/new-page');
  release.resolve();
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(hits.includes('/held-navigation'), false);
});

test('a revoked drag closes its page without releasing the mouse over a live target', async () => {
  const entered = deferred(), release = deferred();
  let moves = 0, downs = 0, ups = 0, closes = 0, revoked = false;
  const page = { viewportSize: () => ({ width: 800, height: 600 }), url: () => 'about:blank', mouse: {
    async move() { if (++moves === 2) { entered.resolve(); await release.promise; } },
    async down() { downs++; }, async up() { ups++; },
  }, async close() { closes++; } };
  const pending = ownerPageInput(page, { kind: 'drag', x: 0.1, y: 0.1, toX: 0.9, toY: 0.9 }, () => {
    if (revoked) throw new Error('Fixture owner grant revoked');
  });
  await entered.promise; revoked = true; release.resolve();
  await assert.rejects(pending, /grant revoked/);
  assert.deepEqual({ downs, ups, closes }, { downs: 1, ups: 0, closes: 1 });
});

test('Lockdown during a dispatched drag stops the owned browser instead of delivering a drop', async t => {
  const { app, browser, input, control, origin } = await fixture(t);
  await input('browser.navigate', { url: origin });
  const page = browser.browser.contexts()[0].pages()[0], entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const move = page.mouse.move.bind(page.mouse), up = page.mouse.up.bind(page.mouse);
  let moves = 0, releases = 0;
  page.mouse.move = async (...args) => { if (++moves === 2) { entered.resolve(); await release.promise; } return move(...args); };
  page.mouse.up = async (...args) => { releases++; return up(...args); };
  const pending = input('browser.owner_input', { kind: 'drag', x: 0.1, y: 0.1, toX: 0.9, toY: 0.9 });
  await entered.promise;
  setLockdown(app.store, app.runtime.owner, { on: true }); release.resolve();
  await assert.rejects(pending);
  assert.equal(releases, 0);
  assert.equal(control.view().state, 'stopped');
  assert.equal(browser.browser.contexts().length, 0);
});

test('owner key revocation during address policy wait prevents dispatch and revokes the writer', async t => {
  const { browser, input, control, origin, revoke, hits } = await fixture(t);
  await input('browser.navigate', { url: origin });
  const entered = deferred(), hold = deferred(); browser.policy = { async assertAllowed() { entered.resolve(); await hold.promise; } };
  t.after(() => hold.resolve());
  const pending = input('browser.navigate', { url: origin + '/revoked' }), rejected = assert.rejects(pending, /full owner window key/);
  await entered.promise; revoke(); hold.resolve(); await rejected;
  assert.equal(hits.includes('/revoked'), false); assert.equal(control.view().writer, null);
});

test('owner authority is checked on reads, start and every later action', async t => {
  const { app, view, call, scope, door } = await fixture(t);
  await assert.rejects(underShortLivedKey(() => view()), /full owner window key/);
  const person = app.store.profiles.create({ name: 'Fixture', pin: '2468' });
  app.store.profiles.switch({ profileId: person.id, pin: '2468' }); await assert.rejects(view(), /Only the owner/);
  app.store.profiles.switch({ profileId: null });
  app.sessionLock.setPin({ pin: '2468' }); app.sessionLock.lock(); await assert.rejects(view(), /Branch is locked/); app.sessionLock.unlock({ pin: '2468' });
  setLockdown(app.store, app.runtime.owner, { on: true }); await assert.rejects(view(), /Lockdown/); setLockdown(app.store, app.runtime.owner, { on: false });
  door(); await assert.rejects(call('/start', scope), /only in Branch/);
});

test('real HTTP routes reject script keys and household calls before creating browser work', async t => {
  const { app, root, scope } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, 'data'), port: 0, host: '127.0.0.1' }); t.after(() => server.close());
  const send = (part, body, token = server.token) => fetch(new URL(browserApiPath + part, server.url), { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const key = app.sessionTokens.create(app.runtime.owner, { name: 'Fixture script', scope: 'run' }).token;
  assert.equal((await send('/start', scope, key)).status, 401);
  const person = app.store.profiles.create({ name: 'Fixture', pin: '2468' }); app.store.profiles.switch({ profileId: person.id, pin: '2468' });
  assert.ok([400, 403].includes((await send('/start', scope)).status)); app.store.profiles.switch({ profileId: null });
  const answer = await send('/start', scope), result = await answer.json(); assert.equal(answer.status, 200, JSON.stringify(result)); assert.equal(result.status, 'ready');
  setLockdown(app.store, app.runtime.owner, { on: true }); assert.equal((await send('/start', scope)).status, 403);
  setLockdown(app.store, app.runtime.owner, { on: false });
  app.sessionLock.setPin({ pin: '2468' }); app.sessionLock.lock(); assert.equal((await send('/start', scope)).status, 423);
  app.sessionLock.unlock({ pin: '2468' });
});

test('handback refuses a persisted running row with no live runtime task', async t => {
  const { app, call, bound, scope } = await fixture(t);
  const stale = app.store.createRun(app.runtime.owner, 'Stale task', scope.sessionId, false, 'window');
  await assert.rejects(call('/control', { ...bound(), operation: 'handback', runId: stale.id }), /currently running owner task/);
});

test('browser preview reads respect the current manual browser permission without making polling runs', async t => {
  const { app, input, view, scope, call, origin } = await fixture(t); await input('browser.navigate', { url: origin });
  const before = app.store.sessionRuns(app.runtime.owner, scope.sessionId).length; await view(); await view();
  assert.equal(app.store.sessionRuns(app.runtime.owner, scope.sessionId).length, before);
  savePolicy(app.store, app.runtime.owner, { preset: 'custom', rules: [{ tool: 'browser.snapshot', decision: 'deny' }] });
  await assert.rejects(view(), /permission changed|settings|allow|denied|refused/i);
  await assert.rejects(call('/start', { ...scope, profile: 'trunk-other' }), /another Trunk/);
});

test('a live owner task shares the page only after explicit handback, and completion withdraws its grant', async t => {
  const entered = deferred(), release = deferred(); let rounds = 0;
  const provider = { name: 'scripted', async complete() {
    if (++rounds === 1) { entered.resolve(); await release.promise; return { content: '', toolCalls: [{ id: 'look', name: 'browser.snapshot', arguments: '{}' }] }; }
    return { content: 'Done', toolCalls: [] };
  } };
  const { app, browser, input, call, bound, scope, origin, control } = await fixture(t, provider);
  await input('browser.navigate', { url: origin });
  const pending = app.runtime.run({ prompt: 'Read the shared browser', sessionId: scope.sessionId }); t.after(() => release.resolve());
  await entered.promise;
  const task = app.store.sessionRuns(app.runtime.owner, scope.sessionId).find(run => run.status === 'running');
  assert.ok(task); assert.ok(app.runtime.activeRunSignal(task.id));
  const grant = await call('/control', { ...bound(), operation: 'handback', runId: task.id }); assert.equal(grant.control.writer.id, task.id);
  release.resolve(); const finished = await pending;
  assert.equal(finished.status, 'completed'); assert.equal(browser.browser.contexts().length, 1);
  assert.ok(app.store.events(task.id).some(event => event.kind === 'tool.completed'));
  assert.equal(app.runtime.activeRunSignal(task.id), null);
  assert.equal(control.view().writer, null, 'the real runtime cleanup released control');
  await call('/control', { ...bound(), operation: 'takeover' }); assert.equal(control.view().writer.id, scope.clientId);
});

test('postawait runtime permission changes block a dispatch even when the saved policy is unchanged', async t => {
  const { app, browser, input, origin, hits } = await fixture(t); await input('browser.navigate', { url: origin });
  const hold = deferred(), entered = deferred(); browser.policy = { async assertAllowed() { entered.resolve(); await hold.promise; } };
  const original = app.runtime.checkPolicy.bind(app.runtime); let revoked = false;
  app.runtime.checkPolicy = (...args) => { const verdict = original(...args); return revoked ? { ...verdict, decision: 'deny', reason: 'Fixture runtime permission revoked' } : verdict; };
  t.after(() => hold.resolve());
  const pending = input('browser.navigate', { url: origin + '/permission-revoked' }), rejected = assert.rejects(pending, /runtime permission revoked/); await entered.promise;
  revoked = true; hold.resolve(); await rejected;
  assert.equal(hits.includes('/permission-revoked'), false);
});

test('cancelling the actual handed-back task revokes its writer before its held model returns', async t => {
  const entered = deferred(), release = deferred();
  const { app, browser, input, call, bound, scope, origin, control } = await fixture(t, { name: 'scripted', async complete() {
    entered.resolve(); await release.promise; return { content: 'Late response', toolCalls: [] };
  } });
  await input('browser.navigate', { url: origin });
  const pending = app.runtime.run({ prompt: 'Wait for owner', sessionId: scope.sessionId }); t.after(() => release.resolve()); await entered.promise;
  const task = app.store.sessionRuns(app.runtime.owner, scope.sessionId).find(run => run.status === 'running');
  await call('/control', { ...bound(), operation: 'handback', runId: task.id });
  assert.equal(app.runtime.cancel(task.id), true); assert.equal(control.view().writer, null);
  release.resolve(); assert.equal((await pending).status, 'cancelled'); assert.equal(browser.browser.contexts().length, 1);
  await call('/control', { ...bound(), operation: 'takeover' }); assert.equal(control.view().writer.id, scope.clientId);
});

test('an owner-entered secret prevents shared-page recording even after its box is removed', async t => {
  const { app, browser, input, view, control, origin, scope } = await fixture(t); await input('browser.navigate', { url: origin });
  const page = browser.browser.contexts()[0].pages()[0];
  await page.evaluate(() => { const box = document.createElement('input'); box.type = 'password'; box.id = 'private'; box.value = 'FixtureOnlyOwnerSecret'; document.body.append(box); });
  const binding = { owner: app.runtime.owner, conversation: scope.sessionId, profile: null };
  const run = app.store.createRun(app.runtime.owner, 'Isolated recording check', scope.sessionId, false, 'window'), context = app.runtime.context({ runId: run.id });
  browser.bindControlledRun(binding, control.id, context); await control.handBack(control.view().epoch, scope.clientId, run.id);
  await assert.rejects(browser.startRecording(context), /private values/);
  await control.takeOver(control.view().epoch, scope.clientId); await view(); await page.locator('#private').evaluate(box => box.remove());
  await control.handBack(control.view().epoch, scope.clientId, run.id); await assert.rejects(browser.startRecording(context), /private values/);
  assert.equal([...browser.sessions.values()].find(entry => entry.control === control).session.isRecording(), false);
  await browser.closeRun(context);
});

test('App lock and Lockdown revoke the page grant even after the owner unlocks again', async t => {
  const { app, browser, input, call, bound, scope, control, origin } = await fixture(t); await input('browser.navigate', { url: origin });
  app.sessionLock.setPin({ pin: '2468' }); const epoch = control.view().epoch;
  app.sessionLock.lock(); assert.equal(control.view().writer, null); assert.ok(control.view().epoch > epoch);
  app.sessionLock.unlock({ pin: '2468' }); await call('/start', scope); assert.equal(control.view().writer, null);
  await call('/control', { ...bound(), operation: 'takeover' }); assert.equal(control.view().writer.id, scope.clientId);
  const regained = control.view().epoch; setLockdown(app.store, app.runtime.owner, { on: true }); assert.equal(control.view().writer, null);
  setLockdown(app.store, app.runtime.owner, { on: false }); await call('/start', scope); assert.equal(control.view().writer, null);
  assert.ok(control.view().epoch > regained); assert.equal(browser.browser.contexts().length, 1);
});
