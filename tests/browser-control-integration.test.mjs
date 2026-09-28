import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBranch, Budget } from '../dist/index.js';
import { BranchBrowser, registerBrowser } from '../dist/integrations/browser.js';
import { BrowserProfiles } from '../dist/integrations/browser-profiles.js';
import { BrowserSession } from '../dist/integrations/browser-session.js';
import { chromium } from 'playwright';
import { tryToolByHand } from '../dist/playground.js';
import { saveAttachSettings } from '../dist/integrations/browser-attach.js';
import { discardTemp } from './temp-dir.mjs';

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const command = (control, sequence = 1, tabId = control.view().tabs[0]) => ({ epoch: control.view().epoch,
  writer: control.view().writer, sequence, tabId });
async function fixture(t, limits = {}) {
  const root = await mkdtemp(join(tmpdir(), 'branch-browser-control-')), hits = [], held = deferred(), slow = deferred();
  const site = createServer(async (request, response) => {
    hits.push({ path: request.url, cookie: request.headers.cookie ?? '' });
    if (request.url === '/slow') { slow.resolve(); await held.promise; }
    response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'shared-page=one; Path=/' });
    response.end('<!doctype html><meta charset="utf-8"><title>Isolated</title><label>Name<input id="name"></label><button onclick="document.getElementById(\'out\').textContent=document.getElementById(\'name\').value">Save</button><p id="out">Original</p>');
  });
  site.listen(0, '127.0.0.1'); await once(site, 'listening');
  const origin = `http://127.0.0.1:${site.address().port}`;
  const app = await createBranch({ workspace: join(root, 'workspace'), dataDir: join(root, 'data'), provider: { name: 'scripted', async complete() { return { content: 'Unused', toolCalls: [] }; } } });
  const browser = new BranchBrowser({ allowedOrigins: [origin], ...limits }); browser.store = app.store;
  browser.profiles = new BrowserProfiles(join(root, 'profiles'), { async key() { return Buffer.alloc(32, 7); } });
  const binding = { owner: app.runtime.owner, conversation: app.store.createSession(app.runtime.owner), profile: null };
  const context = (scope = binding, stop = new AbortController()) => ({ owner: scope.owner, runId: app.store.createRun(scope.owner, 'Isolated browser', scope.conversation, false, 'window').id,
    workspace: join(root, 'workspace'), signal: stop.signal, budget: new Budget(), permissions: new Set(['browser.read', 'browser.interact']), depth: 0 });
  t.after(async () => {
    held.resolve();
    try { await browser.close(); }
    finally { await app.close(); site.close(); await once(site, 'close'); await discardTemp(root); }
  });
  return { app, browser, binding, context, origin, hits, held, slow };
}

test('owner and later agent tasks use the same guarded page, with stable tabs and independent task limits', async (t) => {
  const { browser, binding, context, origin, hits } = await fixture(t, { maxRuns: 1, maxActionsPerRun: 5 });
  const owner = context(), view = await browser.createControlled(binding, 'window', owner), control = browser.controls.get(binding, view.id);
  const own = (sequence, work, tabId) => browser.ownerCommand(binding, view.id, command(control, sequence, tabId), owner, work);
  await assert.rejects(browser.navigate(origin, owner), /control/, 'a run never inherits the owner grant');
  await own(1, (scoped) => browser.navigate(origin, scoped));
  await own(2, (scoped) => browser.fill('Name', 'Chosen 世界', scoped));
  await own(3, (scoped) => browser.click('button', 'Save', scoped));
  const task = context(); browser.bindControlledRun(binding, view.id, task);
  await control.handBack(control.view().epoch, 'window', task.runId);
  assert.match((await browser.snapshot(task)).accessibility, /Chosen 世界/);
  await browser.navigate(origin + '/next', task);
  assert.match(hits.find((hit) => hit.path === '/next').cookie, /shared-page=one/);
  assert.equal(browser.browser.contexts().length, 1);
  await browser.tab('open', undefined, task);
  const second = control.view().tabs[1];
  await browser.tab('select', 0, task);
  await browser.closeRun(task);
  assert.equal(control.view().writer, null);
  assert.equal(browser.browser.contexts().length, 1, 'task completion keeps the shared context');
  await control.takeOver(control.view().epoch, 'window');
  await own(1, (scoped) => browser.tab('close', 1, scoped), control.view().tabs[0]);
  assert.equal(control.view().tabs.length, 1);
  await assert.rejects(own(2, (scoped) => browser.snapshot(scoped), second), /tab/);
  const next = context(); browser.bindControlledRun(binding, view.id, next);
  await control.handBack(control.view().epoch, 'window', next.runId);
  assert.equal((await browser.snapshot(next)).url, origin + '/next', 'the later run has a fresh task budget and the same page');
  await assert.rejects(browser.navigate('http://127.0.0.1:1/blocked', next), /allowed origin/);
  await browser.stopControlled(binding, view.id);
  assert.equal(browser.browser.contexts().length, 0);
  await assert.rejects(browser.snapshot(next), /stopped/);
});

test('takeover drains an actual held navigation and drops a queued agent write without replay', async (t) => {
  const { browser, binding, context, origin, hits, slow, held } = await fixture(t);
  const owner = context(), view = await browser.createControlled(binding, 'window', owner), control = browser.controls.get(binding, view.id);
  await browser.ownerCommand(binding, view.id, command(control), owner, (scoped) => browser.navigate(origin, scoped));
  const task = context(); browser.bindControlledRun(binding, view.id, task);
  await control.handBack(control.view().epoch, 'window', task.runId);
  const navigating = browser.navigate(origin + '/slow', task), rejected = assert.rejects(navigating, /control/);
  await slow.promise;
  const queued = browser.fill('Name', 'Must never run', task), rejectedQueue = assert.rejects(queued, /control/);
  const transfer = control.takeOver(control.view().epoch, 'window');
  assert.equal(control.view().state, 'transferring');
  held.resolve(); await rejected; await rejectedQueue; await transfer;
  assert.equal(hits.filter((hit) => hit.path === '/slow').length, 1);
  assert.equal((await browser.ownerCommand(binding, view.id, command(control), owner, (scoped) => browser.snapshot(scoped))).url, origin + '/slow');
  await browser.ownerCommand(binding, view.id, command(control, 2), owner, (scoped) => browser.click('button', 'Save', scoped));
  const seen = await browser.ownerCommand(binding, view.id, command(control, 3), owner, (scoped) => browser.snapshot(scoped));
  assert.doesNotMatch(seen.accessibility, /Must never run/);
});

test('controlled bindings refuse wrong owners, conversations and Trunk profiles and never borrow a real browser', async (t) => {
  const { browser, binding, context, app } = await fixture(t);
  const owner = context(), view = await browser.createControlled(binding, 'window', owner);
  await assert.rejects(browser.createControlled({ ...binding, owner: 'other' }, 'window', owner), /another owner/);
  await assert.rejects(browser.createControlled({ ...binding, profile: 'trunk-other' }, 'window', owner), /another Trunk/);
  const other = { ...binding, conversation: app.store.createSession(binding.owner) };
  assert.throws(() => browser.bindControlledRun(other, view.id, owner), /another conversation/);
  const bad = context(other);
  assert.throws(() => browser.bindControlledRun(binding, view.id, bad), /another conversation/);
  await assert.rejects(browser.useProfile('missing', owner), /explicitly selected/);
  saveAttachSettings(app.store, binding.owner, { enabled: true, runId: owner.runId });
  let connections = 0; browser.connect = async () => { connections++; throw new Error('No real browser'); };
  await assert.rejects(browser.borrow(owner), /shared Branch browser/);
  assert.equal(connections, 0, 'the external connection path is never reached');
});

test('concurrent session creation uses one context and keeps its explicit encrypted profile', async (t) => {
  const { browser, binding, context, origin } = await fixture(t);
  const scoped = { ...binding, profile: 'shared' }; await browser.profiles.create(binding.owner, scoped.profile);
  const original = browser.profiles.load.bind(browser.profiles), gate = deferred(), entered = deferred();
  browser.profiles.load = async (...args) => { entered.resolve(); await gate.promise; return original(...args); };
  const first = context(), second = context(), opening = browser.createControlled(scoped, 'window', first);
  await entered.promise;
  const another = browser.createControlled(scoped, 'second-window', second);
  gate.resolve(); const [a, b] = await Promise.all([opening, another]);
  assert.equal(a.id, b.id);
  const control = browser.controls.get(scoped, a.id);
  await browser.ownerCommand(scoped, a.id, command(control), first, (signed) => browser.navigate(origin, signed));
  await assert.rejects(browser.useProfile('shared', first), /explicitly selected/);
  await browser.closeRun(first);
  await browser.closeRun(second);
  assert.ok((await browser.watchControlled(scoped, a.id)).frame?.length > 0, 'the kept page stays watchable without a task binding');
  browser.bindControlledRun(scoped, a.id, second);
  await control.takeOver(control.view().epoch, 'window');
  await browser.ownerCommand(scoped, a.id, command(control), second, (signed) => browser.snapshot(signed));
  assert.equal(browser.browser.contexts().length, 1);
  await browser.stopControlled(scoped, a.id);
  const saved = await original(binding.owner, 'shared');
  assert.equal(saved.cookies.filter((cookie) => cookie.name === 'shared-page').length, 1);
});

test('BrowserSession serializes page and tab writers, and cancels queued work before its effect', async (t) => {
  const native = await chromium.launch({ headless: true });
  const session = new BrowserSession(async () => native, async () => {});
  t.after(async () => { await session.close(); await native.close(); });
  const hold = deferred(), entered = deferred(), stop = new AbortController(), context = { signal: stop.signal };
  let effects = 0;
  const active = session.use(context, async () => { entered.resolve(); await hold.promise; });
  await entered.promise;
  const tab = session.openTab(stop.signal), noTab = assert.rejects(tab, /stopped/);
  const action = session.use(context, async () => effects++), noAction = assert.rejects(action, /stopped/);
  stop.abort(new Error('stopped')); hold.resolve();
  await assert.rejects(active, /stopped/); await noTab; await noAction;
  assert.equal(effects, 0);
  assert.equal(session.tabs().length, 1);
});

test('owner command survives the actual manual gate context clone and rechecks authorization after awaits', async (t) => {
  const { app, browser, binding, context, origin, hits } = await fixture(t);
  registerBrowser(app.registry, browser);
  const owner = context(), view = await browser.createControlled(binding, 'window', owner), control = browser.controls.get(binding, view.id);
  const result = await browser.ownerCommand(binding, view.id, command(control), owner, (scoped) =>
    tryToolByHand(app, { name: 'browser.navigate', arguments: { url: origin }, confirm: true, sessionId: binding.conversation }, scoped,
      () => ({ id: owner.runId, done: () => {} })));
  assert.equal(result.status, 'ran', JSON.stringify(result));
  const hold = deferred(), entered = deferred(); let allowed = true;
  browser.policy = { async assertAllowed() { entered.resolve(); await hold.promise; } };
  const request = browser.ownerCommand(binding, view.id, command(control, 2), owner, (scoped) => browser.navigate(origin + '/revoked', scoped),
    () => { if (!allowed) throw new Error('Owner authorization revoked'); });
  const rejected = assert.rejects(request, /authorization revoked/);
  await entered.promise; allowed = false; hold.resolve(); await rejected;
  assert.equal(hits.some((hit) => hit.path === '/revoked'), false);
});

test('a real dispatched tab open reconciles stable IDs before the new owner writer is granted', async (t) => {
  const { browser, binding, context, origin } = await fixture(t), owner = context();
  const view = await browser.createControlled(binding, 'window', owner), control = browser.controls.get(binding, view.id);
  await browser.ownerCommand(binding, view.id, command(control), owner, (scoped) => browser.navigate(origin, scoped));
  const task = context(); browser.bindControlledRun(binding, view.id, task);
  await control.handBack(control.view().epoch, 'window', task.runId);
  const original = BrowserSession.prototype.openTab, hold = deferred(), opened = deferred();
  BrowserSession.prototype.openTab = async function (...args) { const index = await original.apply(this, args); opened.resolve(); await hold.promise; return index; };
  t.after(() => { BrowserSession.prototype.openTab = original; hold.resolve(); });
  const opening = browser.tab('open', undefined, task), rejected = assert.rejects(opening, /control/);
  await opened.promise;
  const transfer = control.takeOver(control.view().epoch, 'window');
  assert.equal(control.view().state, 'transferring');
  hold.resolve(); await rejected; await transfer;
  assert.equal(control.view().tabs.length, 2);
  assert.equal(browser.browser.contexts()[0].pages().length, 2);
  const newId = control.view().tabs[1];
  const seen = await browser.ownerCommand(binding, view.id, command(control, 1, newId), owner, (scoped) => browser.tab('list', undefined, scoped));
  assert.equal(seen.tabs.find((tab) => tab.active).index, 1);
});

test('Stop closes the actual shared context during navigation, and late completion cannot reopen it', async (t) => {
  const { browser, binding, context, origin, slow, held } = await fixture(t), owner = context();
  const view = await browser.createControlled(binding, 'window', owner), control = browser.controls.get(binding, view.id);
  await browser.ownerCommand(binding, view.id, command(control), owner, (scoped) => browser.navigate(origin, scoped));
  const task = context(); browser.bindControlledRun(binding, view.id, task);
  await control.handBack(control.view().epoch, 'window', task.runId);
  const navigating = browser.navigate(origin + '/slow', task), rejected = assert.rejects(navigating, /closed|stopped|revoked/);
  await slow.promise;
  await browser.stopControlled(binding, view.id);
  held.resolve(); await rejected;
  assert.equal(browser.browser.contexts().length, 0);
  assert.equal(control.view().state, 'stopped');
  await assert.rejects(browser.navigate(origin, task), /stopped/);
});

test('closing a tab before the active one preserves the active page identity', async (t) => {
  const { browser, binding, context, origin } = await fixture(t), owner = context();
  const view = await browser.createControlled(binding, 'window', owner), control = browser.controls.get(binding, view.id);
  await browser.ownerCommand(binding, view.id, command(control), owner, (scoped) => browser.navigate(origin, scoped));
  const task = context(); browser.bindControlledRun(binding, view.id, task);
  await control.handBack(control.view().epoch, 'window', task.runId);
  await browser.tab('open', undefined, task); await browser.tab('open', undefined, task);
  await browser.tab('select', 1, task);
  const activeId = control.view().tabs[1];
  const seen = await browser.tab('close', 0, task);
  assert.equal(control.view().tabs[seen.tabs.find((tab) => tab.active).index], activeId);
});

test('Stop during profile loading prevents late shared session startup', async (t) => {
  const { browser, binding, context } = await fixture(t), owner = context(), scoped = { ...binding, profile: 'shared' };
  await browser.profiles.create(binding.owner, 'shared');
  const original = browser.profiles.load.bind(browser.profiles), hold = deferred(), entered = deferred();
  browser.profiles.load = async (...args) => { entered.resolve(); await hold.promise; return original(...args); };
  const opening = browser.createControlled(scoped, 'window', owner), rejected = assert.rejects(opening, /stopped/);
  await entered.promise;
  const control = browser.controls.ensure(scoped, 'window');
  await browser.stopControlled(scoped, control.id);
  hold.resolve(); await rejected;
  assert.equal(browser.browser, undefined);
  assert.equal(control.view().state, 'stopped');
});

test('owned page previews scrub directly entered secrets and remember them after the box disappears', async (t) => {
  const { browser, binding, context, origin } = await fixture(t), owner = context();
  const view = await browser.createControlled(binding, 'window', owner), control = browser.controls.get(binding, view.id);
  await browser.ownerCommand(binding, view.id, command(control), owner, (scoped) => browser.navigate(origin, scoped));
  const page = browser.browser.contexts()[0].pages()[0], secret = 'IsolatedOwnerPassword-824';
  await page.evaluate((value) => {
    const input = document.createElement('input'); input.type = 'password'; input.id = 'private'; input.value = value;
    document.body.append(input); document.title = 'Echo ' + value; history.replaceState(null, '', '/echo?q=' + value);
  }, secret);
  const first = await browser.watch(binding.owner, owner.runId);
  assert.ok(first.frame); assert.doesNotMatch(JSON.stringify({ ...first, frame: null }), new RegExp(secret));
  await page.locator('#private').evaluate((input) => input.remove());
  const later = await browser.watchControlled(binding, view.id);
  assert.ok(later.frame); assert.doesNotMatch(JSON.stringify({ ...later, frame: null }), new RegExp(secret));
  assert.match(later.title, /hidden|redacted|private/i);
  const original = page.frames; page.frames = () => { throw new Error('Fixture inspection unavailable'); };
  t.after(() => { page.frames = original; });
  const unavailable = await browser.watchControlled(binding, view.id);
  assert.equal(unavailable.url, origin); assert.equal(unavailable.title, '');
  assert.doesNotMatch(JSON.stringify({ ...unavailable, frame: null }), new RegExp(secret));
});

test('Stop closes the shared context even when keeping the profile fails', async (t) => {
  const { browser, binding, context, origin } = await fixture(t), owner = context();
  const scoped = { ...binding, profile: 'shared' }; await browser.profiles.create(binding.owner, 'shared');
  const view = await browser.createControlled(scoped, 'window', owner), control = browser.controls.get(scoped, view.id);
  await browser.ownerCommand(scoped, view.id, command(control), owner, (ctx) => browser.navigate(origin, ctx));
  const original = browser.keepSignIn; browser.keepSignIn = async () => { throw new Error('Fixture profile write failed'); };
  await assert.rejects(browser.stopControlled(scoped, view.id), /profile write failed/);
  browser.keepSignIn = original;
  assert.equal(browser.browser.contexts().length, 0); assert.equal(control.view().state, 'stopped');
});

for (const action of ['open', 'close']) for (const revoked of ['disconnect', 'task abort']) {
  test(`completed tab ${action} reconciles its identity despite ${revoked}`, async (t) => {
    const { browser, binding, context, origin } = await fixture(t), owner = context();
    const view = await browser.createControlled(binding, 'window', owner), control = browser.controls.get(binding, view.id);
    const own = (seq, work, tabId) => browser.ownerCommand(binding, view.id, command(control, seq, tabId), owner, work);
    await own(1, (ctx) => browser.navigate(origin, ctx));
    if (action === 'close') await own(2, (ctx) => browser.tab('open', undefined, ctx));
    const stop = new AbortController(), task = context(binding, stop); browser.bindControlledRun(binding, view.id, task);
    if (revoked === 'task abort') await control.handBack(control.view().epoch, 'window', task.runId);
    const entry = [...browser.sessions.values()].find((entry) => entry.control === control), session = entry.session;
    const hold = deferred(), effected = deferred();
    const target = action === 'open' ? session : session.tabPage(1), method = action === 'open' ? 'newPage' : 'close', original = target[method];
    target[method] = async function (...args) { const result = await original.apply(this, args); effected.resolve(); await hold.promise; return result; };
    t.after(() => { target[method] = original; hold.resolve(); });
    const request = revoked === 'task abort' ? browser.tab(action, action === 'close' ? 1 : undefined, task)
      : own(action === 'close' ? 3 : 2, (ctx) => browser.tab(action, action === 'close' ? 1 : undefined, ctx));
    const rejected = assert.rejects(request, /control|abort|revoked/i); await effected.promise;
    if (revoked === 'disconnect') control.disconnect('window'); else stop.abort(new Error('Fixture task aborted'));
    hold.resolve(); await rejected;
    if (revoked === 'task abort') await browser.closeRun(task);
    await control.takeOver(control.view().epoch, 'window');
    const tabs = control.view().tabs;
    assert.equal(tabs.length, action === 'open' ? 2 : 1);
    assert.equal(tabs.length, browser.browser.contexts()[0].pages().length);
    for (const [index, id] of tabs.entries()) {
      const result = await own(index + 1, (ctx) => browser.tab('list', undefined, ctx), id);
      assert.equal(result.tabs.find((tab) => tab.active).index, index);
    }
  });
}
