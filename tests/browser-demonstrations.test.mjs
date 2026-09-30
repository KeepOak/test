import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createBranch, RunArtifacts } from '../dist/index.js';
import { BranchBrowser, registerBrowser } from '../dist/integrations/browser.js';
import { BrowserProfiles } from '../dist/integrations/browser-profiles.js';
import { BrowserControlApi, browserApiPath, requireBrowserOwner } from '../dist/browser-control-api.js';
import { BrowserDemonstrations } from '../dist/browser-demonstrations.js';
import { savePolicy } from '../dist/policy.js';
import { discardTemp } from './temp-dir.mjs';

assert.equal(chromium.name(), 'chromium');
async function fixture(t, profile = null) {
  const root = await mkdtemp(join(tmpdir(), 'branch-human-demo-')), hits = [], cookies = [];
  const site = createServer((request, response) => {
    hits.push(request.url); cookies.push(request.headers.cookie ?? ''); response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Demo</title><form action="/done"><label>Name<input id="name" name="name"></label>'
      + '<button>Save name</button></form><label>Password<input id="password" type="password"></label>'
      + '<label>API key<input id="api-key" name="api_key"></label><label>Authorization<input id="auth"></label>'
      + '<label>Remember<input id="check" type="checkbox"></label>'
      + '<button>Ambiguous</button><button>Ambiguous</button>');
  });
  site.listen(0, '127.0.0.1'); await once(site, 'listening');
  const origin = `http://127.0.0.1:${site.address().port}`;
  const app = await createBranch({ workspace: join(root, 'workspace'), dataDir: join(root, 'data'),
    provider: { name: 'scripted', async complete() { return { content: 'Unused', toolCalls: [] }; } } });
  const browser = new BranchBrowser({ allowedOrigins: [origin] });
  browser.store = app.store; browser.artifacts = new RunArtifacts(join(root, 'artifacts')); app.browser = browser;
  browser.profiles = new BrowserProfiles(join(root, 'profiles'), { async key() { return Buffer.alloc(32, 13); } });
  if (profile) await browser.profiles.save(app.runtime.owner, profile, { cookies: [{ name: 'demo_signed_in', value: 'fixture-identity',
    domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] });
  registerBrowser(app.registry, browser); savePolicy(app.store, app.runtime.owner, { preset: 'off' });
  const api = new BrowserControlApi(app), scope = { sessionId: app.store.createSession(app.runtime.owner), profile, clientId: randomUUID() };
  const access = { signal: new AbortController().signal, authorize: () => requireBrowserOwner(app, true, false) };
  const call = (part, body, method = 'POST') => api.handle(method, browserApiPath + part, body, access);
  const started = await call('/start', scope), control = browser.controls.get({ owner: app.runtime.owner, conversation: scope.sessionId, profile }, started.control.id);
  const bound = () => ({ ...scope, id: control.id, epoch: control.view().epoch });
  const view = () => call('', bound(), 'GET');
  const input = async (tool, args) => { const seen = await view(); return call('/action', { ...bound(), frameId: seen.frameId,
    tabId: seen.tabId, sequence: control.view().sequence + 1, tool, arguments: args }); };
  const demo = async (operation, extra = {}) => { const seen = await view(); return call('/demonstration', { ...bound(), tabId: seen.tabId, operation, ...extra }); };
  const click = async selector => { const page = browser.browser.contexts()[0].pages()[0], box = await page.locator(selector).boundingBox(), size = page.viewportSize();
    return input('browser.owner_input', { kind: 'click', x: (box.x + 5) / size.width, y: (box.y + 5) / size.height }); };
  t.after(async () => { api.close(); await browser.close(); await app.close(); site.close(); await once(site, 'close'); await discardTemp(root); });
  await input('browser.navigate', { url: origin });
  return { root, app, browser, scope, bound, view, input, call, demo, click, hits, cookies, origin };
}

test('explicit saved profile stays in the same replay task and is denied by current profile policy', async t => {
  const h = await fixture(t, 'demonstration-sign-in'); await h.demo('start');
  await h.click('#name'); await h.input('browser.owner_input', { kind: 'text', text: 'Signed in' });
  await h.click('form button');
  const preview = await h.demo('preview');
  assert.equal(preview.definition.steps[0].args.profile, 'demonstration-sign-in');
  assert.doesNotMatch(JSON.stringify(preview), /fixture-identity/);
  const saved = await h.demo('save', { previewToken: preview.previewToken });
  await h.call('/stop', h.bound());
  assert.equal((await h.app.workflows.run(h.app.runtime.owner, saved.workflow.id)).status, 'completed');
  assert.equal(h.cookies.at(-1), 'demo_signed_in=fixture-identity');
  const before = h.hits.length;
  savePolicy(h.app.store, h.app.runtime.owner, { preset: 'custom', rules: [{ tool: 'browser.profile', decision: 'deny' }] });
  assert.notEqual((await h.app.workflows.run(h.app.runtime.owner, saved.workflow.id)).status, 'completed');
  assert.equal(h.hits.length, before);
});

test('human owner controls become a saved workflow that replays in a fresh browser under current policy', async t => {
  const h = await fixture(t);
  assert.equal((await h.demo('start')).status, 'recording');
  await h.click('#name');
  await h.input('browser.owner_input', { kind: 'text', text: 'Ada ' });
  await h.input('browser.owner_input', { kind: 'text', text: 'Lovelace' });
  await h.click('form button');
  const preview = await h.demo('preview');
  assert.deepEqual(preview.omissions, []);
  assert.deepEqual(preview.definition.steps[0].args.steps, [
    { action: 'navigate', url: h.origin + '/' }, { action: 'fill', label: 'Name', value: 'Ada Lovelace' }, { action: 'click', role: 'button', name: 'Save name' },
  ]);
  const beforeSave = h.hits.length, saved = await h.demo('save', { previewToken: preview.previewToken, name: 'Submit name' });
  assert.equal(h.hits.length, beforeSave, 'saving has no browser effects');
  await h.call('/stop', h.bound());
  assert.equal(h.browser.browser.contexts().length, 0);
  const replay = await h.app.workflows.run(h.app.runtime.owner, saved.workflow.id);
  assert.equal(replay.status, 'completed', JSON.stringify(replay));
  assert.equal(h.hits.filter(url => url === '/done?name=Ada+Lovelace').length, 2);
  const beforeDenied = h.hits.length;
  savePolicy(h.app.store, h.app.runtime.owner, { preset: 'custom', rules: [{ tool: 'browser.fill', decision: 'deny' }] });
  const denied = await h.app.workflows.run(h.app.runtime.owner, saved.workflow.id);
  assert.notEqual(denied.status, 'completed');
  assert.equal(h.hits.length, beforeDenied, 'all flow permissions are checked before navigation');
});

test('secret fields, ambiguous targets and unsupported gestures cannot become a silently incomplete workflow', async t => {
  const h = await fixture(t); await h.demo('start');
  await h.click('#password'); await h.input('browser.owner_input', { kind: 'text', text: 'Never-Persist-29471' });
  await h.click('#api-key'); await h.input('browser.owner_input', { kind: 'text', text: 'an arbitrary unrecognisable secret' });
  await h.click('#auth'); await h.input('browser.owner_input', { kind: 'text', text: 'another arbitrary private value' });
  await h.click('#check');
  await h.click('button >> nth=1');
  const preview = await h.demo('preview');
  assert.equal(preview.omissions.length, 5);
  assert.doesNotMatch(JSON.stringify(preview), /Never-Persist-29471|unrecognisable|arbitrary private/);
  await assert.rejects(h.demo('save', { previewToken: preview.previewToken }), /cannot be replayed safely/);
  await h.demo('cancel');
  await assert.rejects(h.demo('preview'), /another browser control/);
});

test('owner window, conversation, tab and preview token are bound; later actions do not mutate the preview', async t => {
  const h = await fixture(t); await h.demo('start');
  await h.click('#name'); await h.input('browser.owner_input', { kind: 'text', text: 'Original' });
  const seen = await h.view(), body = { ...h.bound(), tabId: seen.tabId, operation: 'preview' };
  await assert.rejects(h.call('/demonstration', { ...body, clientId: randomUUID() }), /Take control/);
  await assert.rejects(h.call('/demonstration', { ...body, tabId: randomUUID() }), /Take control/);
  await assert.rejects(h.call('/demonstration', { ...body, sessionId: h.app.store.createSession(h.app.runtime.owner) }), /another|not found/i);
  await assert.rejects(h.input('browser.tab', { action: 'open' }), /single-tab/);
  const preview = await h.demo('preview');
  await h.input('browser.owner_input', { kind: 'text', text: ' changed' });
  await assert.rejects(h.demo('save', { previewToken: randomUUID() }), /Preview/);
  const saved = await h.demo('save', { previewToken: preview.previewToken });
  assert.equal(saved.workflow.steps[0].args.steps[1].value, 'Original');
});

test('recorded known secrets and credential URLs never become redaction literals for replay', () => {
  const recorder = new BrowserDemonstrations(value => JSON.parse(JSON.stringify(value).replaceAll('known-private', '[redacted]')));
  const scope = { owner: 'owner', conversation: 'chat', control: 'control', client: 'client', tab: 'tab', epoch: 1 };
  recorder.start(scope, 'https://example.com/');
  recorder.append(scope, { step: { action: 'fill', label: 'Name', value: 'known-private' } });
  recorder.append(scope, recorder.navigation('https://example.com/?code=privatecode'));
  const preview = recorder.preview(scope, 'Safe demo');
  assert.equal(preview.omissions.length, 2);
  assert.doesNotMatch(JSON.stringify(preview), /known-private|privatecode|\[redacted\]/);
  assert.throws(() => recorder.saved(scope, preview.previewToken, 'Safe demo'), /cannot be replayed/);
});
